#!/usr/bin/env node

import { readFile } from 'fs'
import { promisify } from 'util'
import axios from 'axios'
import { parse as yamlParse, stringify as yamlStringify } from 'yaml'
import { join as pathJoin } from 'path'

import { getLastSuccessfulBuildRevisionOnBranch } from './circle'
import { requireEnv } from './env'
import { getBranchpointCommit } from './git'
import { spawnGetStdout } from './command'

const CONTINUATION_API_URL = `https://circleci.com/api/v2/pipeline/continue`
const DEFAULT_CONFIG_VERSION = 2.1
const DEFAULT_TARGET_BRANCHES_REGEX = /^(release\/|develop$|main$|master$)/
const DEFAULT_RUN_ONLY_CHANGED_ON_TARGET_BRANCHES = false

const pReadFile = promisify(readFile)

interface CircleParameter {
  type: string
  default?: string
}

interface CircleJobDefinition {
  conditional?: boolean
  executor?: string
  parameters?: Record<string, CircleParameter>
}

interface CircleWorkflowJob {
  context?: string | string[]
  filters?: any
  name?: string
  requires?: string[]
}

interface CircleWorkflow {
  jobs: Record<string, CircleWorkflowJob>[]
}

interface CircleConfig {
  dependencies?: string[]
  jobs?: Record<string, CircleJobDefinition>
  workflows?: Record<string, CircleWorkflow>
  [k: string]: unknown
}

interface Package {
  name: string
  circleConfig: CircleConfig
}

interface CircletronConfig {
  runOnlyChangedOnTargetBranches: boolean
  targetBranchesRegex: RegExp
}

async function getPackages(): Promise<Package[]> {
  const packageOutput = await spawnGetStdout('lerna', ['list', '--parseable', '--all', '--long'])
  const allPackages = await Promise.all(
    packageOutput
      .trim()
      .split('\n')
      .map(async (line) => {
        const [fullPath, name] = line.split(':')
        let circleConfig: CircleConfig | undefined
        try {
          circleConfig = yamlParse((await pReadFile(pathJoin(fullPath, 'circle.yml'))).toString())
        } catch (e) {
          // no circle config, filter below
        }

        return { circleConfig, name }
      }),
  )

  function hasConfig(pkg: { circleConfig?: CircleConfig }): pkg is Package {
    return !!pkg.circleConfig
  }
  return allPackages.filter(hasConfig)
}

/**
 * Get the names of the packages which builds should be triggered for by
 * determing which packages have changed in this branch and consulting
 * .circleci/circletron.yml to packages that should be run due to a dependency
 * changing.
 */
const getTriggerPackages = async (
  packages: Package[],
  config: CircletronConfig,
  branch: string,
): Promise<Set<string>> => {
  // run all jobs on target branches
  const isTargetBranch = config.targetBranchesRegex.test(branch)
  const changedPackages = new Set<string>()
  const allPackageNames = new Set(packages.map((pkg) => pkg.name))

  let changesSinceCommit: string

  if (isTargetBranch) {
    if (config.runOnlyChangedOnTargetBranches) {
      const lastBuildCommit: string | undefined = await getLastSuccessfulBuildRevisionOnBranch(
        branch,
      )

      if (!lastBuildCommit) {
        console.log(`Could not find a previous build on ${branch}, running all pipelines`)
        return allPackageNames
      }

      changesSinceCommit = lastBuildCommit
    } else {
      console.log(`Detected a push from ${branch}, running all pipelines`)
      return allPackageNames
    }
  } else {
    changesSinceCommit = await getBranchpointCommit(config.targetBranchesRegex)
  }

  console.log("Looking for changes since `%s'", changesSinceCommit)
  const changeOutput = (
    await spawnGetStdout('lerna', [
      'list',
      '--parseable',
      '--all',
      '--long',
      '--since',
      changesSinceCommit,
    ])
  ).trim()

  if (!changeOutput) {
    console.log('Found no changed packages')
  } else {
    for (const pkg of changeOutput.split('\n')) {
      changedPackages.add(pkg.split(':', 2)[1])
    }

    console.log('Found changes: %O', changedPackages)
  }

  return new Set(
    Array.from(changedPackages)
      .flatMap((changedPackage) => [
        changedPackage,
        ...packages
          .filter((pkg) => pkg.circleConfig.dependencies?.includes(changedPackage))
          .map((pkg) => pkg.name),
      ])
      .filter((pkg) => allPackageNames.has(pkg)),
  )
}

const SKIP_JOB = {
  docker: [{ image: 'busybox:stable' }],
  steps: [
    {
      run: {
        name: 'Jobs not required',
        command: 'echo "Jobs not required"',
      },
    },
  ],
}

const SKIP_JOB_NAME: string = 'circletron_skip_job'

async function buildConfiguration(
  packages: Package[],
  triggerPackages: Set<string>,
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let config: Record<string, any> = {}
  try {
    config = yamlParse((await pReadFile('circle.yml')).toString())
  } catch (e) {
    // the root config does not have to exist
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mergeObject = (path: string, projectYaml: any): void => {
    for (const [name, value] of Object.entries(projectYaml[path] ?? {})) {
      if (!config[path]) {
        config[path] = {}
      } else if (config[path][name]) {
        throw new Error(`Two ${path} with the same name: ${name}`)
      }
      config[path][name] = value
    }
  }
  if (!config.jobs) {
    config.jobs = {}
  }
  if (!config.version) {
    config.version = DEFAULT_CONFIG_VERSION
  }
  const jobsConfig = config.jobs

  jobsConfig[SKIP_JOB_NAME] = SKIP_JOB

  for (const pkg of packages) {
    const { circleConfig } = pkg
    mergeObject('orbs', circleConfig)
    mergeObject('executors', circleConfig)
    mergeObject('commands', circleConfig)

    // jobs may be missing from circle config if all workflow jobs are from orbs
    const jobs: Record<string, CircleJobDefinition> | undefined = { ...circleConfig.jobs }
    for (const [jobName, jobData] of Object.entries(jobs ?? {})) {
      if (jobsConfig[jobName]) {
        throw new Error(`Two jobs with the same name: ${jobName}`)
      }
      if ('conditional' in jobData) {
        const { conditional } = jobData
        delete jobData.conditional
        if (conditional === false) {
          // these jobs are triggered no matter what
          jobsConfig[jobName] = jobData
          continue
        }
      }
      jobsConfig[jobName] = triggerPackages.has(pkg.name)
        ? jobData
        : {
            ...SKIP_JOB,
            parameters: jobData.parameters,
          }
    }

    // Manipulate the workflows to skip jobs that are either:
    // - shared but outside of a trigger package
    // - defined by an orb
    if (!triggerPackages.has(pkg.name)) {
      for (const workflowName in circleConfig.workflows) {
        for (const [i, jobRecord] of circleConfig.workflows[workflowName].jobs.entries()) {
          for (const [jobName, job] of Object.entries(jobRecord)) {
            // If the job is not defined within this package's Circle configuration,
            // we assume that it is either shared, something along the lines of a 'hold'
            // job, or defined by an orb
            if (!circleConfig.jobs || !(jobName in circleConfig.jobs)) {
              const skipReplacementJob: CircleWorkflowJob = {
                // if the job has a custom name, we should inherit it, otherwise fallback
                // to the job's 'key'
                name: job.name || jobName,
              }

              // if the job has filters or required jobs, set those to the skip job
              if (job.filters) skipReplacementJob.filters = job.filters
              if (job.requires) skipReplacementJob.requires = job.requires

              const skipJobConfiguration: Record<string, CircleWorkflowJob> = {
                [SKIP_JOB_NAME]: skipReplacementJob,
              }

              circleConfig.workflows[workflowName].jobs[i] = skipJobConfiguration
            }
          }
        }
      }
    }

    mergeObject('workflows', circleConfig)
  }
  return yamlStringify(config)
}

export async function getCircletronConfig(): Promise<CircletronConfig> {
  let rawConfig: { targetBranches?: string; runOnlyChangedOnTargetBranches?: boolean } = {}
  try {
    rawConfig = yamlParse((await pReadFile(pathJoin('.circleci', 'circletron.yml'))).toString())
  } catch (e) {
    // circletron.yml is not mandatory
  }

  return {
    runOnlyChangedOnTargetBranches:
      rawConfig.runOnlyChangedOnTargetBranches ?? DEFAULT_RUN_ONLY_CHANGED_ON_TARGET_BRANCHES,
    targetBranchesRegex: rawConfig.targetBranches
      ? new RegExp(rawConfig.targetBranches)
      : DEFAULT_TARGET_BRANCHES_REGEX,
  }
}

export async function triggerCiJobs(branch: string, continuationKey: string): Promise<void> {
  const lernaConfig = await getCircletronConfig()
  const packages = await getPackages()
  const triggerPackages = await getTriggerPackages(packages, lernaConfig, branch)

  const configuration = await buildConfiguration(packages, triggerPackages)
  const body = { 'continuation-key': continuationKey, configuration }
  console.log('CircleCI configuration:')
  console.log(configuration)

  const response = await axios.post(CONTINUATION_API_URL, body)
  console.log('CircleCI response: %O', response.data)
}

if (require.main === module) {
  const branch = requireEnv('CIRCLE_BRANCH')
  const continuationKey = requireEnv('CIRCLE_CONTINUATION_KEY')

  triggerCiJobs(branch, continuationKey).catch((err) => {
    console.warn('Got error: %O', err)
    process.exit(1)
  })
}
