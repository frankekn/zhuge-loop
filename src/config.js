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

function buildSoloPreset(name, verifyCommand, implementCommand) {
  return {
    name,
    sleepMs: 120_000,
    maxConsecutiveFailures: 3,
    keepRecentTurns: 30,
    profileRotation: ['default'],
    profiles: {
      default: {
        description: 'Plan -> implement -> verify in small slices',
        phases: [
          { id: 'plan', command: 'echo "[plan] choose the smallest shippable slice"', timeoutMs: 600_000, allowFailure: false },
          { id: 'implement', command: implementCommand ?? 'echo "[implement] run your agent or script here"', timeoutMs: 1_200_000, allowFailure: false },
          { id: 'verify', command: verifyCommand, timeoutMs: 900_000, allowFailure: false },
        ],
      },
    },
  }
}

export const PRESETS = Object.freeze({
  'zhuge-solo': buildSoloPreset('zhuge-solo', 'npm test'),
  'zhuge-team': {
    name: 'zhuge-team',
    sleepMs: 120_000,
    maxConsecutiveFailures: 3,
    keepRecentTurns: 30,
    profileRotation: ['zhuge', 'zhaoyun', 'guanyu'],
    profiles: {
      zhuge: {
        description: '\u8AF8\u845B\u4EAE (\u5354\u8ABF)\uFF1A\u62C6\u4EFB\u52D9\u3001\u5B9A\u65B9\u5411',
        phases: [
          { id: 'plan', command: 'echo "[zhuge] break the task into small slices"', timeoutMs: 600_000, allowFailure: false },
        ],
      },
      zhaoyun: {
        description: '\u8D99\u96F2 (\u5BE6\u4F5C)\uFF1A\u53EF\u9760\u4EA4\u4ED8\u6BCF\u4E00\u884C',
        phases: [
          { id: 'implement', command: 'echo "[zhaoyun] implement the next slice"', timeoutMs: 1_200_000, allowFailure: false },
          { id: 'verify', command: 'npm test', timeoutMs: 900_000, allowFailure: false },
        ],
      },
      guanyu: {
        description: '\u95DC\u7FBD (\u5BE9\u67E5)\uFF1A\u54C1\u8CEA\u4E0D\u59A5\u5354',
        phases: [
          { id: 'review', command: 'echo "[guanyu] review recent changes"', timeoutMs: 600_000, allowFailure: false },
        ],
      },
    },
  },
  'node-lib': buildSoloPreset('node-lib', 'npm test'),
  'react-vite': buildSoloPreset('react-vite', 'npx vitest run'),
  'python': buildSoloPreset('python', 'pytest'),
  'generic': buildSoloPreset('generic', 'echo ok'),
  'claude-code': buildSoloPreset('claude-code', 'npm test', 'claude --dangerously-skip-permissions -p "implement the next task"'),
  'kiro': buildSoloPreset('kiro', 'npm test', 'kiro task run'),
})

const TEST_COMMANDS = {
  'node-lib': 'npm test',
  'react-vite': 'npx vitest run',
  'python': 'pytest',
  'generic': 'echo ok',
}

export function testCommandForProjectType(projectType) {
  return TEST_COMMANDS[projectType] ?? 'echo ok'
}

export async function detectProjectType(repoDir) {
  const exists = async (name) => {
    try {
      await fs.access(path.join(repoDir, name))
      return true
    } catch {
      return false
    }
  }

  if (await exists('vite.config.ts') || await exists('vite.config.js') || await exists('vite.config.mjs')) {
    return 'react-vite'
  }
  if (await exists('package.json')) {
    return 'node-lib'
  }
  if (await exists('pyproject.toml') || await exists('requirements.txt')) {
    return 'python'
  }
  return 'generic'
}

export function patchVerifyCommand(config, testCommand) {
  const patched = structuredClone(config)
  for (const profile of Object.values(patched.profiles)) {
    for (const phase of profile.phases) {
      if (phase.id === 'verify') {
        phase.command = testCommand
      }
    }
  }
  return patched
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}. Check your zhuge.config.json.`)
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string, got ${JSON.stringify(value)}. Check your zhuge.config.json.`)
  }
}

function validatePhases(profileName, phases) {
  if (!Array.isArray(phases) || phases.length === 0) {
    throw new Error(`profiles.${profileName}.phases must be a non-empty array. Each profile needs at least one phase with {id, command}.`)
  }
  for (const phase of phases) {
    assertNonEmptyString(phase.id, `profiles.${profileName}.phases[].id`)
    assertNonEmptyString(phase.command, `profiles.${profileName}.phases[].command`)
    const timeoutMs = phase.timeoutMs ?? 600_000
    assertPositiveInteger(timeoutMs, `profiles.${profileName}.phases[${phase.id}].timeoutMs`)
    if (phase.allowFailure !== null && phase.allowFailure !== undefined && typeof phase.allowFailure !== 'boolean') {
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

export async function writeSampleConfig(configPath, presetName) {
  const preset = presetName ? PRESETS[presetName] : null
  if (presetName && !preset) {
    throw new Error(`Unknown preset: ${presetName}. Available: ${Object.keys(PRESETS).join(', ')}`)
  }

  const sample = preset
    ? structuredClone(preset)
    : buildSoloPreset('zhuge-loop', 'npm test')

  await fs.writeFile(configPath, `${JSON.stringify(sample, null, 2)}\n`, 'utf8')
}
