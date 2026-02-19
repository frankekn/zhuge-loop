import fs from 'node:fs/promises'
import path from 'node:path'
import { acquireLock, releaseLock } from './lock.js'
import { runCommand } from './runner.js'
import { loadState, saveState, recordTurnResult } from './state.js'
import {
  appendText,
  mkdirp,
  nowIso,
  sleep,
  timestampForPath,
  writeJson,
} from './utils.js'

function nextProfileName(state, profileRotation) {
  return profileRotation[state.turn % profileRotation.length]
}

async function writeTurnResultMarkdown(turnDir, turnResult) {
  const lines = [
    `# Turn ${turnResult.turn}`,
    '',
    `- Timestamp: ${turnResult.timestamp}`,
    `- Profile: ${turnResult.profile}`,
    `- Status: ${turnResult.ok ? 'success' : 'failure'}`,
    `- Duration: ${turnResult.durationMs}ms`,
    '',
    '## Phases',
    '',
  ]

  for (const phase of turnResult.phases) {
    lines.push(`- ${phase.id}: code=${phase.code}, duration=${phase.durationMs}ms${phase.timedOut ? ', timeout=true' : ''}`)
  }

  if (!turnResult.ok) {
    lines.push('')
    lines.push('## Error')
    lines.push('')
    lines.push(turnResult.errorSummary ?? 'Unknown error')
  }

  await fs.writeFile(path.join(turnDir, 'result.md'), `${lines.join('\n')}\n`, 'utf8')
}

async function cleanOldTurnLogs(logsDir, keepRecentTurns) {
  const entries = await fs.readdir(logsDir, { withFileTypes: true }).catch(() => [])
  const turnDirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('turn-'))
    .map((entry) => entry.name)
    .sort()

  const stale = turnDirs.slice(0, Math.max(0, turnDirs.length - keepRecentTurns))
  await Promise.all(
    stale.map((dirName) => fs.rm(path.join(logsDir, dirName), { recursive: true, force: true }))
  )
}

async function runTurn(config, state, turnDir) {
  const profileName = nextProfileName(state, config.profileRotation)
  const profile = config.profiles[profileName]
  const turnStart = Date.now()

  const context = {
    turn: state.turn,
    timestamp: nowIso(),
    profileName,
    profileDescription: profile.description ?? '',
    phases: profile.phases,
  }
  await writeJson(path.join(turnDir, 'context.json'), context)

  const phaseResults = []
  let ok = true
  let errorSummary = null

  for (let index = 0; index < profile.phases.length; index += 1) {
    const phase = profile.phases[index]
    const result = await runCommand(phase.command, {
      cwd: config.repoDir,
      timeoutMs: phase.timeoutMs,
      env: {
        ...process.env,
        ZHUGE_TURN: String(state.turn),
        ZHUGE_PROFILE: profileName,
        ZHUGE_PHASE: phase.id,
      },
    })

    const phaseResult = {
      id: phase.id,
      command: phase.command,
      code: result.code,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      allowFailure: Boolean(phase.allowFailure),
    }
    phaseResults.push(phaseResult)

    const prefix = String(index + 1).padStart(2, '0')
    await fs.writeFile(path.join(turnDir, `${prefix}-${phase.id}.stdout.log`), result.out, 'utf8')
    await fs.writeFile(path.join(turnDir, `${prefix}-${phase.id}.stderr.log`), result.err, 'utf8')

    if (result.code !== 0 && !phase.allowFailure) {
      ok = false
      errorSummary = `Phase ${phase.id} failed with code ${result.code}`
      break
    }
  }

  const turnResult = {
    turn: state.turn,
    timestamp: nowIso(),
    profile: profileName,
    ok,
    durationMs: Date.now() - turnStart,
    phases: phaseResults,
    errorSummary,
  }

  await writeJson(path.join(turnDir, 'result.json'), turnResult)
  await writeTurnResultMarkdown(turnDir, turnResult)

  return turnResult
}

export async function runLoop(config, options = {}) {
  const once = Boolean(options.once)

  await mkdirp(config.runtimeDir)
  await mkdirp(config.logsDir)

  const lock = await acquireLock(config.lockPath)
  let stopRequested = false

  const onSignal = () => {
    stopRequested = true
  }

  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  try {
    let state = await loadState(config.statePath)

    while (true) {
      const turnDir = path.join(
        config.logsDir,
        `turn-${String(state.turn).padStart(6, '0')}-${timestampForPath(nowIso())}`
      )
      await mkdirp(turnDir)

      const turnResult = await runTurn(config, state, turnDir)
      state = recordTurnResult(state, turnResult, config.keepRecentTurns)
      await saveState(config.statePath, state)
      await cleanOldTurnLogs(config.logsDir, config.keepRecentTurns)

      if (!turnResult.ok && state.consecutiveFailures >= config.maxConsecutiveFailures) {
        const line = `${nowIso()} HALT: consecutive failures reached ${state.consecutiveFailures}/${config.maxConsecutiveFailures}\n`
        await appendText(config.haltLogPath, line)
        return { exitCode: 50, state }
      }

      if (once || stopRequested) {
        return { exitCode: 0, state }
      }

      await sleep(config.sleepMs)
    }
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    await releaseLock(lock)
  }
}
