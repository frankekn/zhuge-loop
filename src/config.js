import fs from 'node:fs/promises'
import path from 'node:path'
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
  profileRotation: ['default'],
  profiles: {
    default: {
      description: 'Minimal profile example',
      phases: [
        {
          id: 'heartbeat',
          command: 'echo "replace this command in zhuge.config.json"',
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

function validatePhases(profileName, phases) {
  if (!Array.isArray(phases) || phases.length === 0) {
    throw new Error(`profiles.${profileName}.phases must be a non-empty array`)
  }
  for (const phase of phases) {
    assertNonEmptyString(phase.id, `profiles.${profileName}.phases[].id`)
    assertNonEmptyString(phase.command, `profiles.${profileName}.phases[].command`)
    const timeoutMs = phase.timeoutMs ?? 600_000
    assertPositiveInteger(timeoutMs, `profiles.${profileName}.phases[${phase.id}].timeoutMs`)
    if (phase.allowFailure != null && typeof phase.allowFailure !== 'boolean') {
      throw new Error(`profiles.${profileName}.phases[${phase.id}].allowFailure must be boolean`)
    }
  }
}

export function normalizeConfig(raw, configPath = path.resolve(process.cwd(), 'zhuge.config.json')) {
  const merged = {
    ...DEFAULT_CONFIG,
    ...raw,
    profiles: raw?.profiles ?? DEFAULT_CONFIG.profiles,
    profileRotation: raw?.profileRotation ?? DEFAULT_CONFIG.profileRotation,
  }

  const configDir = path.dirname(configPath)
  const repoDir = resolveFrom(configDir, merged.repoDir)

  const normalized = {
    ...merged,
    repoDir,
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

  for (const profileName of normalized.profileRotation) {
    if (!normalized.profiles[profileName]) {
      throw new Error(`profileRotation references missing profile: ${profileName}`)
    }
  }

  for (const [profileName, profile] of Object.entries(normalized.profiles)) {
    validatePhases(profileName, profile.phases)
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
            command: 'echo "[plan] choose the smallest shippable slice"',
            timeoutMs: 600000,
            allowFailure: false,
          },
          {
            id: 'implement',
            command: 'echo "[implement] run your agent or script here"',
            timeoutMs: 1200000,
            allowFailure: false,
          },
          {
            id: 'verify',
            command: 'npm test',
            timeoutMs: 900000,
            allowFailure: false,
          },
        ],
      },
    },
  }

  await fs.writeFile(configPath, `${JSON.stringify(sample, null, 2)}\n`, 'utf8')
}
