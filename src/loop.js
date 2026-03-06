import fs from 'node:fs/promises'
import path from 'node:path'
import { collectRepoContext, composeKiroPrompt, truncateHandoff } from './context.js'
import { acquireLock, releaseLock } from './lock.js'
import {
  buildLinearContext,
  parseLinearMarkers,
  processLinearMarkers,
  queryLinearTasks,
  shouldInjectLinearContext,
} from './linear.js'
import { commitWorkingTreeIfDirty, ensureOnDeliveryBranch, pushBranchIfNeeded } from './repo.js'
import { runCommand, runPhase } from './runner.js'
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
    const details = [
      phase.kind ? `kind=${phase.kind}` : null,
      phase.agent ? `agent=${phase.agent}` : null,
      phase.adapterUsed ? `adapter=${phase.adapterUsed}` : null,
      `code=${phase.code}`,
      `duration=${phase.durationMs}ms`,
      phase.timedOut ? 'timeout=true' : null,
      phase.fallbackUsed ? 'fallback=true' : null,
    ].filter(Boolean)
    lines.push(`- ${phase.id}: ${details.join(', ')}`)
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
  const turnLabel = `Turn ${state.turn}`

  if (config.repoPolicy?.pushBranch) {
    await ensureOnDeliveryBranch(config, {
      env: process.env,
      turnLabel,
    })
  }

  const repoContext = await collectRepoContext(config, runCommand, {
    env: process.env,
  })
  const repoContextPath = path.join(turnDir, 'repo-context.txt')
  await fs.writeFile(repoContextPath, repoContext, 'utf8')
  let linearTasks = await queryLinearTasks(config, {
    env: process.env,
  })
  let linearContext = buildLinearContext(
    linearTasks,
    Number(config.integrations?.linear?.contextMaxChars ?? 4_000)
  )
  const linearContextPath = path.join(turnDir, 'linear-context.txt')
  await fs.writeFile(linearContextPath, linearContext, 'utf8')

  const context = {
    turn: state.turn,
    timestamp: nowIso(),
    profileName,
    profileDescription: profile.description ?? '',
    repoContextPath,
    linearContextPath,
    contextCommands: config.context?.commands ?? [],
    phases: profile.phases,
  }
  await writeJson(path.join(turnDir, 'context.json'), context)

  const phaseResults = []
  let ok = true
  let errorSummary = null
  let handoff = ''
  let activeTask = null

  const resolveActiveTask = (marker, tasks) => {
    if (!marker) return null
    if (marker.issueId) {
      return tasks?.find((task) => task.id === marker.issueId) ?? { id: marker.issueId }
    }
    if (marker.identifier) {
      const normalized = String(marker.identifier).trim().toUpperCase()
      return tasks?.find((task) => String(task.identifier ?? '').trim().toUpperCase() === normalized) ?? {
        identifier: normalized,
      }
    }
    if (marker.title) {
      const normalized = String(marker.title).trim().toLowerCase()
      return tasks?.find((task) => String(task.title ?? '').trim().toLowerCase() === normalized) ?? {
        title: String(marker.title).trim(),
      }
    }
    return null
  }

  for (let index = 0; index < profile.phases.length; index += 1) {
    const phase = profile.phases[index]
    const phaseRun = phase.run ?? (phase.command ? { kind: 'shell', command: phase.command } : null)
    const prefix = String(index + 1).padStart(2, '0')
    const handoffPath = path.join(turnDir, `${prefix}-${phase.id}.handoff.txt`)
    await fs.writeFile(handoffPath, handoff, 'utf8')

    let promptPath = null
    let phaseToRun = phase
    if (phaseRun?.kind === 'kiro') {
      const prompt = composeKiroPrompt(phaseRun.prompt, {
        repoContext,
        linearContext: shouldInjectLinearContext(config, phase.id) ? linearContext : '',
        handoff,
      })
      promptPath = path.join(turnDir, `${prefix}-${phase.id}.prompt.txt`)
      await fs.writeFile(promptPath, prompt, 'utf8')
      phaseToRun = {
        ...phase,
        run: {
          ...phaseRun,
          prompt,
        },
      }
    }

    const result = await runPhase(phaseToRun, {
      cwd: config.repoDir,
      env: {
        ...process.env,
        ZHUGE_TURN: String(state.turn),
        ZHUGE_PROFILE: profileName,
        ZHUGE_PHASE: phase.id,
        ZHUGE_REPO_CONTEXT: repoContext,
        ZHUGE_REPO_CONTEXT_PATH: repoContextPath,
        ZHUGE_LINEAR_CONTEXT: linearContext,
        ZHUGE_LINEAR_CONTEXT_PATH: linearContextPath,
        ZHUGE_HANDOFF: handoff,
        ZHUGE_HANDOFF_PATH: handoffPath,
      },
      kiro: config.kiro,
    })

    const phaseResult = {
      id: phase.id,
      kind: result.kind ?? phaseRun?.kind,
      command: phaseRun?.kind === 'shell' ? phaseRun.command : undefined,
      agent: phaseRun?.kind === 'kiro' ? phaseRun.agent : undefined,
      code: result.code,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      allowFailure: Boolean(phase.allowFailure),
      adapterUsed: result.adapterUsed,
      fallbackUsed: result.fallbackUsed,
    }

    const markers = parseLinearMarkers(result.out)
    if (markers.length > 0) {
      phaseResult.linearMarkers = markers
      await processLinearMarkers(config, markers, phase.id, linearTasks ?? [], {
        env: process.env,
      })
      linearTasks = (await queryLinearTasks(config, {
        env: process.env,
      })) ?? linearTasks
      linearContext = buildLinearContext(
        linearTasks,
        Number(config.integrations?.linear?.contextMaxChars ?? 4_000)
      )
      await fs.writeFile(linearContextPath, linearContext, 'utf8')

      const resolvedActiveTask = resolveActiveTask(
        markers.find((marker) => marker.type === 'active'),
        linearTasks
      )
      if (resolvedActiveTask) {
        activeTask = resolvedActiveTask
      }
    }

    phaseResults.push(phaseResult)

    await fs.writeFile(path.join(turnDir, `${prefix}-${phase.id}.stdout.log`), result.out, 'utf8')
    await fs.writeFile(path.join(turnDir, `${prefix}-${phase.id}.stderr.log`), result.err, 'utf8')
    if (result.kind === 'kiro' && phaseRun?.kind === 'kiro') {
      const metadataPath = path.join(turnDir, `${prefix}-${phase.id}.meta.json`)
      phaseResult.metadataPath = metadataPath
      await writeJson(metadataPath, {
        kind: 'kiro',
        agent: phaseRun.agent,
        adapterRequested: result.adapterRequested ?? 'acp',
        adapterUsed: result.adapterUsed ?? 'acp',
        fallbackUsed: Boolean(result.fallbackUsed),
        timedOut: Boolean(result.timedOut),
        durationMs: result.durationMs,
        sessionId: result.metadata?.sessionId ?? null,
        contextUsagePercentage: result.metadata?.contextUsagePercentage ?? null,
        metadataEvents: Array.isArray(result.metadata?.metadataEvents) ? result.metadata.metadataEvents : [],
        repoContextPath,
        linearContextPath,
        handoffPath,
        promptPath,
        repoContextIncluded: Boolean(repoContext),
        linearContextIncluded: Boolean(shouldInjectLinearContext(config, phase.id) && linearContext),
        handoffIncluded: Boolean(handoff),
      })
    }

    handoff = truncateHandoff(result.out)

    if (result.code === 0) {
      const commitResult = await commitWorkingTreeIfDirty(config, {
        env: process.env,
        activeTask,
        phaseId: phase.id,
        turnLabel,
      })
      if (commitResult.committed) {
        phaseResult.commitSubject = commitResult.subject
        const pushResult = await pushBranchIfNeeded(config, {
          env: process.env,
          turnLabel,
        })
        if (pushResult.pushed) {
          phaseResult.pushedBranch = pushResult.branch
        }
      }
    }

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
        const recentErrors = state.results
          .slice(-config.maxConsecutiveFailures)
          .filter((r) => !r.ok)
          .map((r) => `  turn ${r.turn}: ${r.errorSummary ?? 'unknown'}`)
          .join('\n')
        const line = `${nowIso()} HALT: consecutive failures reached ${state.consecutiveFailures}/${config.maxConsecutiveFailures}\nRecent failures:\n${recentErrors}\n`
        await appendText(config.haltLogPath, line)
        return { exitCode: 50, state }
      }

      if (once) {
        return { exitCode: turnResult.ok ? 0 : 2, state }
      }

      if (stopRequested) {
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
