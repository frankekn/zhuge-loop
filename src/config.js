import fs from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_CONTEXT_COMMANDS } from './context.js'
import { DEFAULT_LINEAR_PROMPT_PHASE_IDS } from './linear.js'
import { resolveFrom } from './utils.js'

const DEFAULT_CONFIG = {
  name: 'zhuge-loop',
  repoDir: '.',
  runtimeDir: '.zhuge-loop',
  statePath: '.zhuge-loop/state.json',
  logsDir: '.zhuge-loop/logs',
  haltLogPath: '.zhuge-loop/HALT.log',
  lockPath: '.zhuge-loop/zhuge-loop.lock',
  sleepMs: 120_000,
  maxConsecutiveFailures: 3,
  keepRecentTurns: 30,
  context: {
    commands: DEFAULT_CONTEXT_COMMANDS,
  },
  repoPolicy: {
    onDirty: 'warn',
    pushBranch: null,
    autoCommitAfterEachPhase: false,
    autoPushAfterEachPhase: false,
    forbidEmoji: false,
    requireConventionalCommits: false,
    commitMessageMaxLen: 96,
    requireIssueKeyRegex: '',
  },
  integrations: {
    linear: {
      enabled: false,
      cliPath: './tools/linear-cli.sh',
      promptPhaseIds: DEFAULT_LINEAR_PROMPT_PHASE_IDS,
      maxTasks: 10,
      contextMaxChars: 4_000,
    },
  },
  kiro: {
    acpCommand: 'kiro-acp',
    cliCommand: 'kiro-cli-chat',
    trustAllTools: true,
    fallbackToCli: true,
  },
  profileRotation: ['default'],
  profiles: {
    default: {
      description: 'Minimal profile example',
      phases: [
        {
          id: 'heartbeat',
          run: {
            kind: 'shell',
            command: 'echo "replace this command in zhuge.config.json"',
          },
          timeoutMs: 600_000,
          allowFailure: false,
        },
      ],
    },
  },
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
}

function assertBoolean(value, name) {
  if (typeof value !== 'boolean') {
    throw new Error(`${name} must be boolean`)
  }
}

function normalizeContext(context) {
  if (context == null) {
    return {
      commands: DEFAULT_CONTEXT_COMMANDS.map((command) => ({ ...command })),
    }
  }

  if (typeof context !== 'object' || Array.isArray(context)) {
    throw new Error('context must be an object')
  }

  const commands = context.commands ?? DEFAULT_CONTEXT_COMMANDS
  if (!Array.isArray(commands)) {
    throw new Error('context.commands must be an array')
  }

  return {
    commands: commands.map((command, index) => {
      const commandPath = `context.commands[${index}]`
      assertNonEmptyString(command?.name, `${commandPath}.name`)
      assertNonEmptyString(command?.command, `${commandPath}.command`)

      const timeoutMs = command.timeoutMs ?? 5_000
      const maxLines = command.maxLines ?? 50
      assertPositiveInteger(timeoutMs, `${commandPath}.timeoutMs`)
      assertPositiveInteger(maxLines, `${commandPath}.maxLines`)

      return {
        name: command.name.trim(),
        command: command.command.trim(),
        timeoutMs,
        maxLines,
      }
    }),
  }
}

function normalizeRepoPolicy(repoPolicy) {
  const merged = {
    ...DEFAULT_CONFIG.repoPolicy,
    ...(repoPolicy ?? {}),
  }

  if (!['warn', 'auto-stash'].includes(merged.onDirty)) {
    throw new Error('repoPolicy.onDirty must be "warn" or "auto-stash"')
  }

  if (merged.pushBranch != null) {
    assertNonEmptyString(merged.pushBranch, 'repoPolicy.pushBranch')
  }

  assertBoolean(merged.autoCommitAfterEachPhase, 'repoPolicy.autoCommitAfterEachPhase')
  assertBoolean(merged.autoPushAfterEachPhase, 'repoPolicy.autoPushAfterEachPhase')
  assertBoolean(merged.forbidEmoji, 'repoPolicy.forbidEmoji')
  assertBoolean(merged.requireConventionalCommits, 'repoPolicy.requireConventionalCommits')
  assertPositiveInteger(Number(merged.commitMessageMaxLen), 'repoPolicy.commitMessageMaxLen')
  if (merged.requireIssueKeyRegex != null && String(merged.requireIssueKeyRegex).length > 0) {
    assertNonEmptyString(merged.requireIssueKeyRegex, 'repoPolicy.requireIssueKeyRegex')
  }

  return {
    onDirty: merged.onDirty,
    pushBranch: merged.pushBranch == null ? null : String(merged.pushBranch).trim(),
    autoCommitAfterEachPhase: Boolean(merged.autoCommitAfterEachPhase),
    autoPushAfterEachPhase: Boolean(merged.autoPushAfterEachPhase),
    forbidEmoji: Boolean(merged.forbidEmoji),
    requireConventionalCommits: Boolean(merged.requireConventionalCommits),
    commitMessageMaxLen: Number(merged.commitMessageMaxLen),
    requireIssueKeyRegex: String(merged.requireIssueKeyRegex ?? '').trim(),
  }
}

function normalizeLinearIntegration(linear, repoDir) {
  const merged = {
    ...DEFAULT_CONFIG.integrations.linear,
    ...(linear ?? {}),
  }

  assertBoolean(merged.enabled, 'integrations.linear.enabled')
  assertNonEmptyString(merged.cliPath, 'integrations.linear.cliPath')
  assertPositiveInteger(Number(merged.maxTasks), 'integrations.linear.maxTasks')
  assertPositiveInteger(Number(merged.contextMaxChars), 'integrations.linear.contextMaxChars')

  if (!Array.isArray(merged.promptPhaseIds)) {
    throw new Error('integrations.linear.promptPhaseIds must be an array')
  }

  const promptPhaseIds = merged.promptPhaseIds.map((phaseId, index) => {
    assertNonEmptyString(phaseId, `integrations.linear.promptPhaseIds[${index}]`)
    return String(phaseId).trim()
  })

  return {
    enabled: Boolean(merged.enabled),
    cliPath: resolveFrom(repoDir, merged.cliPath),
    promptPhaseIds,
    maxTasks: Number(merged.maxTasks),
    contextMaxChars: Number(merged.contextMaxChars),
  }
}

function normalizePhase(profileName, phase, index) {
  const phasePath = `profiles.${profileName}.phases[${index}]`
  assertNonEmptyString(phase?.id, `${phasePath}.id`)

  const timeoutMs = phase.timeoutMs ?? 600_000
  assertPositiveInteger(timeoutMs, `${phasePath}.timeoutMs`)

  if (phase.allowFailure != null && typeof phase.allowFailure !== 'boolean') {
    throw new Error(`${phasePath}.allowFailure must be boolean`)
  }

  const hasLegacyCommand =
    Object.prototype.hasOwnProperty.call(phase, 'command') && phase.command != null
  const hasRun = Object.prototype.hasOwnProperty.call(phase, 'run') && phase.run != null

  if (hasLegacyCommand && hasRun) {
    throw new Error(`${phasePath} cannot specify both command and run`)
  }

  let run = null
  if (hasRun) {
    if (!phase.run || typeof phase.run !== 'object' || Array.isArray(phase.run)) {
      throw new Error(`${phasePath}.run must be an object`)
    }

    const kind = String(phase.run.kind ?? '').trim()
    if (kind === 'shell') {
      assertNonEmptyString(phase.run.command, `${phasePath}.run.command`)
      run = {
        kind: 'shell',
        command: phase.run.command.trim(),
      }
    } else if (kind === 'kiro') {
      assertNonEmptyString(phase.run.agent, `${phasePath}.run.agent`)
      assertNonEmptyString(phase.run.prompt, `${phasePath}.run.prompt`)
      run = {
        kind: 'kiro',
        agent: phase.run.agent.trim(),
        prompt: phase.run.prompt,
      }
    } else {
      throw new Error(`${phasePath}.run.kind must be "shell" or "kiro"`)
    }
  } else {
    assertNonEmptyString(phase.command, `${phasePath}.command`)
    run = {
      kind: 'shell',
      command: phase.command.trim(),
    }
  }

  return {
    id: phase.id.trim(),
    timeoutMs,
    allowFailure: Boolean(phase.allowFailure),
    run,
  }
}

function normalizeProfiles(profiles) {
  const normalizedProfiles = {}

  for (const [profileName, profile] of Object.entries(profiles)) {
    if (!Array.isArray(profile?.phases) || profile.phases.length === 0) {
      throw new Error(`profiles.${profileName}.phases must be a non-empty array`)
    }

    normalizedProfiles[profileName] = {
      ...profile,
      phases: profile.phases.map((phase, index) => normalizePhase(profileName, phase, index)),
    }
  }

  return normalizedProfiles
}

export function normalizeConfig(raw, configPath = path.resolve(process.cwd(), 'zhuge.config.json')) {
  const merged = {
    ...DEFAULT_CONFIG,
    ...raw,
    context: normalizeContext(raw?.context ?? DEFAULT_CONFIG.context),
    repoPolicy: normalizeRepoPolicy(raw?.repoPolicy ?? DEFAULT_CONFIG.repoPolicy),
    kiro: {
      ...DEFAULT_CONFIG.kiro,
      ...(raw?.kiro ?? {}),
    },
    profiles: raw?.profiles ?? DEFAULT_CONFIG.profiles,
    profileRotation: raw?.profileRotation ?? DEFAULT_CONFIG.profileRotation,
  }

  const configDir = path.dirname(configPath)
  const repoDir = resolveFrom(configDir, merged.repoDir)
  const profiles = normalizeProfiles(merged.profiles)
  const integrations = {
    linear: normalizeLinearIntegration(raw?.integrations?.linear ?? DEFAULT_CONFIG.integrations.linear, repoDir),
  }

  const normalized = {
    ...merged,
    repoDir,
    profiles,
    integrations,
    runtimeDir: resolveFrom(repoDir, merged.runtimeDir),
    statePath: resolveFrom(repoDir, merged.statePath),
    logsDir: resolveFrom(repoDir, merged.logsDir),
    haltLogPath: resolveFrom(repoDir, merged.haltLogPath),
    lockPath: resolveFrom(repoDir, merged.lockPath),
  }

  assertPositiveInteger(normalized.sleepMs, 'sleepMs')
  assertPositiveInteger(normalized.maxConsecutiveFailures, 'maxConsecutiveFailures')
  assertPositiveInteger(normalized.keepRecentTurns, 'keepRecentTurns')

  if (!Array.isArray(normalized.profileRotation) || normalized.profileRotation.length === 0) {
    throw new Error('profileRotation must be a non-empty array')
  }

  if (!normalized.profiles || typeof normalized.profiles !== 'object') {
    throw new Error('profiles must be an object')
  }

  assertNonEmptyString(normalized.kiro.acpCommand, 'kiro.acpCommand')
  assertNonEmptyString(normalized.kiro.cliCommand, 'kiro.cliCommand')
  assertBoolean(normalized.kiro.trustAllTools, 'kiro.trustAllTools')
  assertBoolean(normalized.kiro.fallbackToCli, 'kiro.fallbackToCli')

  for (const profileName of normalized.profileRotation) {
    if (!normalized.profiles[profileName]) {
      throw new Error(`profileRotation references missing profile: ${profileName}`)
    }
  }

  return normalized
}

export async function loadConfig(configPath = path.resolve(process.cwd(), 'zhuge.config.json')) {
  const raw = JSON.parse(await fs.readFile(configPath, 'utf8'))
  return normalizeConfig(raw, configPath)
}

export async function writeSampleConfig(configPath = path.resolve(process.cwd(), 'zhuge.config.json')) {
  const sample = {
    ...DEFAULT_CONFIG,
    profiles: {
      default: {
        description: 'Plan -> implement -> verify in small slices',
        phases: [
          {
            id: 'plan',
            run: {
              kind: 'shell',
              command: 'echo "[plan] choose the smallest shippable slice"',
            },
            timeoutMs: 600000,
            allowFailure: false,
          },
          {
            id: 'implement',
            run: {
              kind: 'shell',
              command: 'echo "[implement] run your agent or script here"',
            },
            timeoutMs: 1200000,
            allowFailure: false,
          },
          {
            id: 'verify',
            run: {
              kind: 'shell',
              command: 'npm test',
            },
            timeoutMs: 900000,
            allowFailure: false,
          },
        ],
      },
    },
  }

  await fs.writeFile(configPath, `${JSON.stringify(sample, null, 2)}\n`, 'utf8')
}
