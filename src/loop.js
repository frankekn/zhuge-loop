import fs from 'node:fs/promises'
import path from 'node:path'
import { collectRepoContext, composeKiroPrompt, truncateHandoff } from './context.js'
import { acquireLock, releaseLock } from './lock.js'
import {
  buildLinearContext,
  parseLinearMarkers,
  processLinearMarkers,
  queryLinearIssueById,
  queryLinearTasks,
  shouldInjectLinearContext,
} from './linear.js'
import {
  captureWorktreeSnapshot,
  commitWorkingTreeIfDirty,
  ensureOnDeliveryBranch,
  listFilesChangedSinceSnapshot,
  pushBranchIfNeeded,
  sameWorktreeSnapshot,
} from './repo.js'
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
      phase.prefetched ? 'prefetched=true' : null,
      phase.skipped ? `skipped=${phase.skipReason ?? true}` : null,
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

function isReviewerPhase(phaseId) {
  const normalized = String(phaseId ?? '').trim().toLowerCase()
  return normalized.includes('reviewer') || normalized.includes('review')
}

function isExecutorPhase(phaseId) {
  const normalized = String(phaseId ?? '').trim().toLowerCase()
  return normalized.includes('executor') || normalized.includes('implement')
}

function isLowRiskChangedFile(filePath) {
  const normalized = String(filePath ?? '').trim().toLowerCase()
  if (!normalized) return false

  const ext = path.extname(normalized)
  if (['.css', '.scss', '.sass', '.less', '.styl', '.pcss'].includes(ext)) {
    return true
  }

  if (
    normalized.includes('.style.') ||
    normalized.includes('.styles.') ||
    /(^|\/)(style|styles)(\/|$)/.test(normalized)
  ) {
    return true
  }

  if (
    /(^|\/)(__tests__|tests?|specs?)(\/|$)/.test(normalized) ||
    /(^|\/)[^/]+\.(test|spec)\.[^/]+$/.test(normalized)
  ) {
    return true
  }

  return false
}

async function assessReviewerRisk(config, snapshot, options = {}) {
  const changeSet = await listFilesChangedSinceSnapshot(config.repoDir, snapshot, {
    env: options.env ?? process.env,
    ignorePaths: options.ignorePaths ?? [],
  })

  return {
    ...changeSet,
    lowRisk:
      changeSet.reliable &&
      changeSet.files.length > 0 &&
      changeSet.files.every((filePath) => isLowRiskChangedFile(filePath)),
  }
}

function internalRepoPaths(config) {
  const repoDir = path.resolve(config.repoDir)
  const trackedPaths = [
    config.runtimeDir,
    config.statePath,
    config.logsDir,
    config.haltLogPath,
    config.lockPath,
  ]

  return [...new Set(
    trackedPaths
      .map((filePath) => {
        if (!filePath) return null
        const relativePath = path.relative(repoDir, path.resolve(filePath))
        if (!relativePath || relativePath.startsWith('..')) return null
        return relativePath.replace(/\\/g, '/')
      })
      .filter(Boolean)
  )]
}

function isPipelineEnabled(config) {
  return config.pipeline === true || Boolean(config.pipeline?.enabled)
}

async function loadTurnInputs(config, options = {}) {
  const repoContext = options.repoContext ?? await collectRepoContext(config, runCommand, {
    env: options.env ?? process.env,
  })
  const linearTasks = options.linearTasks ?? await queryLinearTasks(config, {
    env: options.env ?? process.env,
  })
  const linearContext = options.linearContext ?? buildLinearContext(
    linearTasks,
    Number(config.integrations?.linear?.contextMaxChars ?? 4_000)
  )

  return {
    repoContext,
    linearTasks,
    linearContext,
  }
}

function strategistPhaseDescriptor(profile) {
  const phase = profile?.phases?.[0]
  if (!phase) return null
  const normalized = String(phase.id ?? '').trim().toLowerCase()
  if (!normalized.includes('strategist')) return null
  return {
    phase,
    index: 0,
  }
}

async function prefetchStrategistPhase(config, state, options = {}) {
  const profileName = nextProfileName(state, config.profileRotation)
  const profile = config.profiles[profileName]
  const descriptor = strategistPhaseDescriptor(profile)
  if (!descriptor) return null

  const env = options.env ?? process.env
  const ignoredRepoPaths = options.ignorePaths ?? internalRepoPaths(config)
  const snapshotBefore = await captureWorktreeSnapshot(config.repoDir, {
    env,
    ignorePaths: ignoredRepoPaths,
  })
  const inputs = await loadTurnInputs(config, { env })
  const phaseRun = descriptor.phase.run ?? (descriptor.phase.command ? { kind: 'shell', command: descriptor.phase.command } : null)

  let prompt = null
  let phaseToRun = descriptor.phase
  if (phaseRun?.kind === 'kiro') {
    prompt = composeKiroPrompt(phaseRun.prompt, {
      repoContext: inputs.repoContext,
      linearContext: shouldInjectLinearContext(config, descriptor.phase.id) ? inputs.linearContext : '',
      handoff: '',
    })
    phaseToRun = {
      ...descriptor.phase,
      run: {
        ...phaseRun,
        prompt,
      },
    }
  }

  const result = await runPhase(phaseToRun, {
    cwd: config.repoDir,
    env: {
      ...env,
      ZHUGE_TURN: String(state.turn),
      ZHUGE_PROFILE: profileName,
      ZHUGE_PHASE: descriptor.phase.id,
      ZHUGE_REPO_CONTEXT: inputs.repoContext,
      ZHUGE_REPO_CONTEXT_PATH: '',
      ZHUGE_LINEAR_CONTEXT: inputs.linearContext,
      ZHUGE_LINEAR_CONTEXT_PATH: '',
      ZHUGE_HANDOFF: '',
      ZHUGE_HANDOFF_PATH: '',
    },
    kiro: config.kiro,
  })

  if (result.code !== 0) {
    return null
  }

  const snapshotAfter = await captureWorktreeSnapshot(config.repoDir, {
    env,
    ignorePaths: ignoredRepoPaths,
  })
  if (snapshotBefore && snapshotAfter && !sameWorktreeSnapshot(snapshotBefore, snapshotAfter)) {
    console.warn(`[Turn ${state.turn}] Discarding strategist prefetch because worktree changed during prefetch`)
    return null
  }

  return {
    turn: state.turn,
    profileName,
    phaseId: descriptor.phase.id,
    phaseIndex: descriptor.index,
    repoContext: inputs.repoContext,
    linearContext: inputs.linearContext,
    linearTasks: Array.isArray(inputs.linearTasks) ? structuredClone(inputs.linearTasks) : inputs.linearTasks,
    prompt,
    result,
    snapshot: snapshotAfter ?? snapshotBefore ?? null,
  }
}

async function runTurn(config, state, turnDir, options = {}) {
  const profileName = nextProfileName(state, config.profileRotation)
  const profile = config.profiles[profileName]
  const turnStart = Date.now()
  const turnLabel = `Turn ${state.turn}`
  const prefetchedStrategist =
    options.prefetchedStrategist?.turn === state.turn &&
    options.prefetchedStrategist?.profileName === profileName
      ? options.prefetchedStrategist
      : null

  if (config.repoPolicy?.pushBranch) {
    await ensureOnDeliveryBranch(config, {
      env: process.env,
      turnLabel,
    })
  }

  const prefetchedInputs = prefetchedStrategist
    ? {
        repoContext: prefetchedStrategist.repoContext,
        linearTasks: prefetchedStrategist.linearTasks,
        linearContext: prefetchedStrategist.linearContext,
      }
    : null
  const {
    repoContext,
    linearTasks: initialLinearTasks,
    linearContext: initialLinearContext,
  } = await loadTurnInputs(config, {
    env: process.env,
    ...(prefetchedInputs ?? {}),
  })
  const repoContextPath = path.join(turnDir, 'repo-context.txt')
  await fs.writeFile(repoContextPath, repoContext, 'utf8')
  let linearTasks = initialLinearTasks
  let linearContext = initialLinearContext
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
    prefetchedStrategistUsed: Boolean(prefetchedStrategist),
  }
  await writeJson(path.join(turnDir, 'context.json'), context)

  const phaseResults = []
  let ok = true
  let errorSummary = null
  let handoff = ''
  let activeTask = null
  let reviewerAssessment = {
    reliable: false,
    lowRisk: false,
    files: [],
  }
  const ignoredRepoPaths = internalRepoPaths(config)
  const linearTaskCache = new Map()
  const rememberLinearTask = (task) => {
    if (!task?.id) return task
    linearTaskCache.set(task.id, task)
    return task
  }
  const rememberLinearTasks = (tasks) => {
    for (const task of tasks ?? []) rememberLinearTask(task)
  }
  rememberLinearTasks(linearTasks)
  if (linearTasks && linearTasks.length > 0) {
    const seeded = linearTasks.find((task) => {
      const status = String(task.status ?? '').trim().toLowerCase()
      return status === 'executing' || status === 'in review'
    })
    if (seeded) activeTask = rememberLinearTask(seeded)
  }

  const resolveActiveTask = async (marker, tasks) => {
    if (!marker) return null
    rememberLinearTasks(tasks)
    if (marker.issueId) {
      const normalizedIssueId = String(marker.issueId).trim()
      const cached = linearTaskCache.get(normalizedIssueId)
      if (cached) return cached
      const fetched = await queryLinearIssueById(config, normalizedIssueId, {
        env: process.env,
      })
      if (fetched) return rememberLinearTask(fetched)
      return { id: normalizedIssueId }
    }
    if (marker.identifier) {
      const normalized = String(marker.identifier).trim().toUpperCase()
      const found = tasks?.find((task) => String(task.identifier ?? '').trim().toUpperCase() === normalized)
      return found ? rememberLinearTask(found) : { identifier: normalized }
    }
    if (marker.title) {
      const normalized = String(marker.title).trim().toLowerCase()
      const found = tasks?.find((task) => String(task.title ?? '').trim().toLowerCase() === normalized)
      if (found) return rememberLinearTask(found)
      const fallback = { title: String(marker.title).trim() }
      const keyMatch = fallback.title.match(/([A-Z]+-\d+)/)
      if (keyMatch) fallback.identifier = keyMatch[1]
      return fallback
    }
    return null
  }

  for (let index = 0; index < profile.phases.length; index += 1) {
    const phase = profile.phases[index]
    const phaseRun = phase.run ?? (phase.command ? { kind: 'shell', command: phase.command } : null)
    const prefix = String(index + 1).padStart(2, '0')
    const handoffPath = path.join(turnDir, `${prefix}-${phase.id}.handoff.txt`)
    await fs.writeFile(handoffPath, handoff, 'utf8')

    if (isReviewerPhase(phase.id)) {
      const shouldSkip =
        config.reviewerPolicy === 'skip' ||
        (config.reviewerPolicy === 'risk-based' && reviewerAssessment.lowRisk)
      if (shouldSkip) {
        console.log(`[Turn ${state.turn}] Skipping reviewer (policy: ${config.reviewerPolicy})`)
        phaseResults.push({
          id: phase.id,
          kind: phaseRun?.kind,
          command: phaseRun?.kind === 'shell' ? phaseRun.command : undefined,
          agent: phaseRun?.kind === 'kiro' ? phaseRun.agent : undefined,
          code: 0,
          timedOut: false,
          durationMs: 0,
          allowFailure: Boolean(phase.allowFailure),
          skipped: true,
          skipReason: config.reviewerPolicy,
        })
        await fs.writeFile(path.join(turnDir, `${prefix}-${phase.id}.stdout.log`), '', 'utf8')
        await fs.writeFile(path.join(turnDir, `${prefix}-${phase.id}.stderr.log`), '', 'utf8')
        continue
      }
    }

    const usePrefetchedStrategist =
      prefetchedStrategist &&
      prefetchedStrategist.phaseIndex === index &&
      prefetchedStrategist.phaseId === phase.id

    let promptPath = null
    let phaseToRun = phase
    let result = null
    if (usePrefetchedStrategist) {
      if (prefetchedStrategist.prompt != null) {
        promptPath = path.join(turnDir, `${prefix}-${phase.id}.prompt.txt`)
        await fs.writeFile(promptPath, prefetchedStrategist.prompt, 'utf8')
      }
      result = prefetchedStrategist.result
    } else {
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
    }

    const executorSnapshot =
      config.reviewerPolicy === 'risk-based' && isExecutorPhase(phase.id)
        ? await captureWorktreeSnapshot(config.repoDir, {
            env: process.env,
            ignorePaths: ignoredRepoPaths,
          })
        : null

    if (!result) {
      result = await runPhase(phaseToRun, {
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
    }

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
      prefetched: Boolean(usePrefetchedStrategist),
    }

    const markers = parseLinearMarkers(result.out)
    const activeMarker = markers.find((marker) => marker.type === 'active')
    if (markers.length > 0) {
      phaseResult.linearMarkers = markers
      await processLinearMarkers(config, markers, phase.id, linearTasks ?? [], {
        env: process.env,
      })
      linearTasks = (await queryLinearTasks(config, {
        env: process.env,
      })) ?? linearTasks
      rememberLinearTasks(linearTasks)
      linearContext = buildLinearContext(
        linearTasks,
        Number(config.integrations?.linear?.contextMaxChars ?? 4_000)
      )
      await fs.writeFile(linearContextPath, linearContext, 'utf8')
    }
    activeTask = await resolveActiveTask(activeMarker, linearTasks) ?? activeTask

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

    if (config.reviewerPolicy === 'risk-based' && isExecutorPhase(phase.id) && result.code === 0) {
      reviewerAssessment = await assessReviewerRisk(config, executorSnapshot, {
        env: process.env,
        ignorePaths: ignoredRepoPaths,
      })
    }

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
  const pipelineEnabled = isPipelineEnabled(config)
  const ignoredRepoPaths = internalRepoPaths(config)

  await mkdirp(config.runtimeDir)
  await mkdirp(config.logsDir)

  let lock = await acquireLock(config.lockPath)
  let stopRequested = false
  let prefetchedStrategist = null

  const onSignal = () => {
    stopRequested = true
  }

  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  try {
    let state = await loadState(config.statePath)

    while (true) {
      state = await loadState(config.statePath)
      let turnPrefetch = null
      if (pipelineEnabled && prefetchedStrategist?.turn === state.turn) {
        const currentSnapshot = await captureWorktreeSnapshot(config.repoDir, {
          env: process.env,
          ignorePaths: ignoredRepoPaths,
        })
        const canUsePrefetch =
          prefetchedStrategist.snapshot == null ||
          sameWorktreeSnapshot(prefetchedStrategist.snapshot, currentSnapshot)

        if (canUsePrefetch) {
          turnPrefetch = prefetchedStrategist
        } else {
          console.log(`[Turn ${state.turn}] Discarding stale strategist prefetch`)
        }
        prefetchedStrategist = null
      } else if (prefetchedStrategist && prefetchedStrategist.turn !== state.turn) {
        prefetchedStrategist = null
      }

      const turnDir = path.join(
        config.logsDir,
        `turn-${String(state.turn).padStart(6, '0')}-${timestampForPath(nowIso())}`
      )
      await mkdirp(turnDir)

      const turnResult = await runTurn(config, state, turnDir, {
        prefetchedStrategist: turnPrefetch,
      })
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

      if (pipelineEnabled) {
        await releaseLock(lock)
        lock = null
        try {
          prefetchedStrategist = await prefetchStrategistPhase(config, state, {
            env: process.env,
            ignorePaths: ignoredRepoPaths,
          })
        } catch (error) {
          prefetchedStrategist = null
          console.warn(`[Turn ${state.turn}] Strategist prefetch failed: ${error?.message ?? String(error)}`)
        }

        if (stopRequested) {
          return { exitCode: 0, state }
        }

        lock = await acquireLock(config.lockPath)
      }

      await sleep(config.sleepMs)
    }
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    if (lock) {
      await releaseLock(lock)
    }
  }
}
