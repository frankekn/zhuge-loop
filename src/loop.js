import fs from 'node:fs/promises'
import path from 'node:path'
import { collectRepoContext, composeKiroPrompt, truncateHandoff } from './context.js'
import { acquireLock, releaseLock } from './lock.js'
import {
  buildLinearContext,
  parseLinearMarkers,
  processLinearMarkers,
  queryLinearTasks,
  resolveLinearTaskReference,
  normalizeTitle as normalizeLinearTitle,
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

function normalizeLinearIdentifier(value) {
  return String(value ?? '').trim().toUpperCase()
}

function summarizeTaskRef(task) {
  if (!task) return null
  return {
    id: String(task.id ?? '').trim() || undefined,
    identifier: normalizeLinearIdentifier(task.identifier) || undefined,
    title: String(task.title ?? '').trim() || undefined,
    status: String(task.status ?? '').trim() || undefined,
    priority: String(task.priority ?? '').trim() || undefined,
  }
}

function isTaskDone(task) {
  return String(task?.status ?? '').trim().toLowerCase() === 'done'
}

function tasksMatch(left, right) {
  if (!left || !right) return false

  const leftId = String(left.id ?? '').trim()
  const rightId = String(right.id ?? '').trim()
  if (leftId && rightId && leftId === rightId) return true

  const leftIdentifier = normalizeLinearIdentifier(left.identifier)
  const rightIdentifier = normalizeLinearIdentifier(right.identifier)
  if (leftIdentifier && rightIdentifier && leftIdentifier === rightIdentifier) return true

  const leftTitle = normalizeLinearTitle(left.title)
  const rightTitle = normalizeLinearTitle(right.title)
  return Boolean(leftTitle && rightTitle && leftTitle === rightTitle)
}

function canBindCanonicalTask(phaseId) {
  const normalized = String(phaseId ?? '').trim().toLowerCase()
  return normalized === 'strategist' || normalized === 'executor' || isReviewerPhase(phaseId)
}

function hasReviewerValidationFailure(result) {
  const stderr = String(result?.err ?? '')
  return (
    /tool validation failed/i.test(stderr) ||
    /path does not exist/i.test(stderr) ||
    /required input/i.test(stderr)
  )
}

async function listRepoFiles(repoDir) {
  const result = await runCommand('command -v rg >/dev/null 2>&1 && rg --files || git ls-files', {
    cwd: repoDir,
    timeoutMs: 30_000,
  })

  if (result.code !== 0) {
    return []
  }

  return String(result.out ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function escapeShellArg(value) {
  return JSON.stringify(String(value))
}

function isVitestFile(filePath) {
  return /(^|\/)(__tests__\/.*|[^/]+\.(test|spec)\.[^/]+)$/.test(String(filePath ?? ''))
}

function isLikelySourceFile(filePath) {
  return /\.(?:[cm]?[jt]sx?|vue)$/.test(String(filePath ?? ''))
}

function basenameWithoutCompoundExt(filePath) {
  const name = path.basename(String(filePath ?? ''))
  return name.replace(/\.(test|spec)\.[^.]+$/i, '').replace(/\.[^.]+$/i, '')
}

function sourcePathStem(filePath) {
  return String(filePath ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\.[^.]+$/i, '')
}

function testPathStem(filePath) {
  return String(filePath ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\.(test|spec)\.[^.]+$/i, '')
}

function candidateTestStemsForSource(filePath) {
  const stem = sourcePathStem(filePath)
  if (!stem) return []

  const candidates = new Set([stem])
  const base = path.posix.basename(stem)
  candidates.add(`tests/${base}`)
  candidates.add(`test/${base}`)

  if (stem.startsWith('src/')) {
    const mirrored = stem.slice(4)
    candidates.add(`tests/${mirrored}`)
    candidates.add(`test/${mirrored}`)
    candidates.add(`__tests__/${mirrored}`)
  }

  return [...candidates]
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort()
}

function resolveVitestTargetsForChanges(changedFiles, repoFiles) {
  const testFiles = repoFiles.filter((filePath) => isVitestFile(filePath))
  const repoFileSet = new Set(repoFiles)
  const selected = new Set()
  const testsByStem = new Map()

  for (const candidate of testFiles) {
    const stem = testPathStem(candidate)
    if (!stem) continue
    const matches = testsByStem.get(stem) ?? []
    matches.push(candidate)
    testsByStem.set(stem, matches)
  }

  for (const filePath of changedFiles) {
    if (isVitestFile(filePath) && repoFileSet.has(filePath)) {
      selected.add(filePath)
      continue
    }

    if (!isLikelySourceFile(filePath)) continue

    const directory = path.posix.dirname(filePath)
    const base = basenameWithoutCompoundExt(filePath)
    for (const stem of candidateTestStemsForSource(filePath)) {
      for (const match of testsByStem.get(stem) ?? []) {
        selected.add(match)
      }
    }
    const localMatches = testFiles.filter((candidate) => {
      const candidateDir = path.posix.dirname(candidate)
      const candidateBase = basenameWithoutCompoundExt(candidate)
      return candidateDir === directory && candidateBase === base
    })
    for (const match of localMatches) selected.add(match)

    const directoryGuardrails = testFiles.filter((candidate) => {
      if (path.posix.dirname(candidate) !== directory) return false
      return /(guardrail|wiring)/i.test(path.posix.basename(candidate))
    })
    for (const match of directoryGuardrails) selected.add(match)
  }

  if (changedFiles.some((filePath) => /(^|\/)src\/(?:linear|loop)\.js$/.test(filePath))) {
    for (const candidate of ['tests/linear.test.js', 'tests/loop.test.js']) {
      if (repoFileSet.has(candidate)) selected.add(candidate)
    }
  }

  return uniqueSorted([...selected])
}

async function buildVitestChangedCommand(config, snapshot, ignoredRepoPaths = []) {
  const changeSet = await listFilesChangedSinceSnapshot(config.repoDir, snapshot, {
    env: process.env,
    ignorePaths: ignoredRepoPaths,
  })

  if (!changeSet.reliable) {
    return {
      ok: false,
      error: 'unable_to_resolve_changed_files',
      changedFiles: [],
      resolvedTests: [],
    }
  }

  const repoFiles = await listRepoFiles(config.repoDir)
  const resolvedTests = resolveVitestTargetsForChanges(changeSet.files, repoFiles)
  if (resolvedTests.length === 0) {
    return {
      ok: false,
      error: 'no_resolved_tests_for_changed_files',
      changedFiles: changeSet.files,
      resolvedTests: [],
    }
  }

  return {
    ok: true,
    command: `pnpm test --run ${resolvedTests.map((filePath) => escapeShellArg(filePath)).join(' ')}`,
    changedFiles: changeSet.files,
    resolvedTests,
  }
}

function seedCanonicalTask(state, tasks = []) {
  const current = Array.isArray(tasks) ? tasks : []
  const persisted = summarizeTaskRef(state?.activeTask)
  if (persisted) {
    const matched = current.find((task) => tasksMatch(task, persisted) && !isTaskDone(task))
    if (matched) return matched
  }

  const inFlight = current.filter((task) => {
    const status = String(task?.status ?? '').trim().toLowerCase()
    return status === 'coordinating' || status === 'executing' || status === 'in review'
  })

  return inFlight.length === 1 ? inFlight[0] : null
}

function createFailureTurnResult(state, profileName, phaseResults, turnStart, errorSummary, extra = {}) {
  return {
    turn: state.turn,
    timestamp: nowIso(),
    profile: profileName,
    ok: false,
    durationMs: Date.now() - turnStart,
    phases: phaseResults,
    errorSummary,
    canonicalActiveTask: extra.canonicalActiveTask ?? null,
    linearWarnings: extra.linearWarnings ?? [],
    transportDegraded: Boolean(extra.transportDegraded),
    deliverySummary: extra.deliverySummary ?? { committed: false, pushed: false, error: null },
    verificationSummary: extra.verificationSummary ?? {},
  }
}

function describeLinearMarker(marker) {
  if (!marker) return 'unknown'
  if (marker.issueId) return `issue_id=${marker.issueId}`
  if (marker.identifier) return `identifier=${marker.identifier}`
  if (marker.title) return `title=${marker.title}`
  return marker.type ?? 'unknown'
}

function selectCanonicalActiveCandidate(phaseId, candidates, canonicalActiveTask, linearWarnings) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null
  }

  const matchingCanonical = canonicalActiveTask
    ? candidates.filter((candidate) => tasksMatch(candidate.task, canonicalActiveTask))
    : []

  if (canonicalActiveTask) {
    for (const candidate of candidates) {
      if (!tasksMatch(candidate.task, canonicalActiveTask)) {
        linearWarnings.push(
          `${phaseId}: ignored LINEAR_ACTIVE for ${describeLinearMarker(candidate.marker)} because canonical task is locked`
        )
      }
    }

    if (matchingCanonical.length > 1) {
      for (const ignored of matchingCanonical.slice(0, -1)) {
        linearWarnings.push(
          `${phaseId}: ignored earlier LINEAR_ACTIVE for ${describeLinearMarker(ignored.marker)} in favor of the last canonical marker`
        )
      }
    }

    return matchingCanonical.at(-1) ?? null
  }

  if (!canBindCanonicalTask(phaseId)) {
    for (const candidate of candidates) {
      linearWarnings.push(
        `${phaseId}: ignored LINEAR_ACTIVE for ${describeLinearMarker(candidate.marker)} because this phase cannot bind the canonical task`
      )
    }
    return null
  }

  if (candidates.length > 1) {
    for (const ignored of candidates.slice(0, -1)) {
      linearWarnings.push(
        `${phaseId}: ignored earlier LINEAR_ACTIVE for ${describeLinearMarker(ignored.marker)} in favor of the last valid marker`
      )
    }
  }

  return candidates.at(-1) ?? null
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
  const phaseResults = []
  const ignoredRepoPaths = internalRepoPaths(config)
  const deliverySummary = {
    committed: false,
    pushed: false,
    subject: null,
    branch: null,
    error: null,
  }
  const verificationSummary = {}
  const linearWarnings = []
  const pendingDoneMarkers = []
  let transportDegraded = false
  let handoff = ''
  let reviewerAssessment = {
    reliable: false,
    lowRisk: false,
    files: [],
  }
  let repoContext = ''
  let linearTasks = null
  let linearContext = ''
  let repoContextPath = path.join(turnDir, 'repo-context.txt')
  let linearContextPath = path.join(turnDir, 'linear-context.txt')
  let canonicalActiveTask = null
  let turnSnapshot = null
  const linearResolutionCache = new Map()

  const refreshLinearContext = async () => {
    linearContext = buildLinearContext(
      linearTasks,
      Number(config.integrations?.linear?.contextMaxChars ?? 4_000)
    )
    await fs.writeFile(linearContextPath, linearContext, 'utf8')
  }
  const rememberResolvedTask = (task) => {
    if (!task?.id) return task
    linearResolutionCache.set(task.id, task)
    return task
  }
  const rememberResolvedTasks = (tasks = []) => {
    for (const task of tasks) rememberResolvedTask(task)
  }
  const resolveTaskReference = async (marker, tasks = linearTasks ?? []) => {
    if (marker?.issueId) {
      const cached = linearResolutionCache.get(String(marker.issueId).trim())
      if (cached) return cached
    }

    const resolved = await resolveLinearTaskReference(config, marker, tasks, {
      env: process.env,
    })
    return rememberResolvedTask(resolved)
  }
  const checkpointDirtyWorktree = async (reasonLabel = 'recovery') => {
    if (!config.repoPolicy?.autoCommitAfterEachPhase) return

    const snapshot = await captureWorktreeSnapshot(config.repoDir, {
      env: process.env,
      ignorePaths: ignoredRepoPaths,
    })
    if (!snapshot?.status?.trim()) return

    if (config.integrations?.linear?.enabled && !canonicalActiveTask) {
      deliverySummary.checkpointError = 'checkpoint skipped: no canonical task binding'
      return
    }

    const checkpointResult = await commitWorkingTreeIfDirty(config, {
      env: process.env,
      activeTask: canonicalActiveTask,
      phaseId: reasonLabel,
      turnLabel,
      ignorePaths: ignoredRepoPaths,
    })
    if (checkpointResult.committed) {
      deliverySummary.checkpointCommitted = true
      deliverySummary.checkpointSubject = checkpointResult.subject
      return
    }

    deliverySummary.checkpointError = checkpointResult.skippedReason ?? 'checkpoint commit skipped'
  }

  try {
    if (config.repoPolicy?.pushBranch) {
      await ensureOnDeliveryBranch(config, {
        env: process.env,
        turnLabel,
      })
    }

    turnSnapshot = await captureWorktreeSnapshot(config.repoDir, {
      env: process.env,
      ignorePaths: ignoredRepoPaths,
    })
    if (turnSnapshot?.status?.trim()) {
      const turnResult = createFailureTurnResult(
        state,
        profileName,
        phaseResults,
        turnStart,
        'Working tree dirty at turn start'
      )
      await writeJson(path.join(turnDir, 'result.json'), turnResult)
      await writeTurnResultMarkdown(turnDir, turnResult)
      return turnResult
    }

    const prefetchedInputs = prefetchedStrategist
      ? {
          repoContext: prefetchedStrategist.repoContext,
          linearTasks: prefetchedStrategist.linearTasks,
          linearContext: prefetchedStrategist.linearContext,
        }
      : null
    const loadedInputs = await loadTurnInputs(config, {
      env: process.env,
      ...(prefetchedInputs ?? {}),
    })
    repoContext = loadedInputs.repoContext
    linearTasks = loadedInputs.linearTasks
    linearContext = loadedInputs.linearContext
    rememberResolvedTasks(linearTasks ?? [])

    await fs.writeFile(repoContextPath, repoContext, 'utf8')
    await fs.writeFile(linearContextPath, linearContext, 'utf8')

    canonicalActiveTask = seedCanonicalTask(state, linearTasks ?? [])
    rememberResolvedTask(canonicalActiveTask)

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
      canonicalActiveTask: summarizeTaskRef(canonicalActiveTask),
    }
    await writeJson(path.join(turnDir, 'context.json'), context)

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
          const skippedPhase = {
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
          }
          phaseResults.push(skippedPhase)
          verificationSummary[phase.id] = {
            ok: true,
            skipped: true,
            code: 0,
          }
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
      let resolvedTests = []
      let changedFiles = []

      if (usePrefetchedStrategist) {
        if (prefetchedStrategist.prompt != null) {
          promptPath = path.join(turnDir, `${prefix}-${phase.id}.prompt.txt`)
          await fs.writeFile(promptPath, prefetchedStrategist.prompt, 'utf8')
        }
        result = prefetchedStrategist.result
      } else if (phaseRun?.kind === 'kiro') {
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
      } else if (phaseRun?.kind === 'vitestChanged') {
        const vitestPlan = await buildVitestChangedCommand(config, turnSnapshot, ignoredRepoPaths)
        resolvedTests = vitestPlan.resolvedTests
        changedFiles = vitestPlan.changedFiles
        if (!vitestPlan.ok) {
          result = {
            kind: 'shell',
            code: 1,
            timedOut: false,
            durationMs: 0,
            startedAt: nowIso(),
            endedAt: nowIso(),
            out: '',
            err: vitestPlan.error,
          }
        } else {
          phaseToRun = {
            ...phase,
            run: {
              kind: 'shell',
              command: vitestPlan.command,
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

      if (isReviewerPhase(phase.id) && result.code === 0 && hasReviewerValidationFailure(result)) {
        result = {
          ...result,
          code: 1,
          err: [String(result.err ?? '').trim(), '[REVIEWER_VALIDATION_FAILURE] reviewer transport returned invalid tool usage']
            .filter(Boolean)
            .join('\n'),
        }
      }

      const phaseResult = {
        id: phase.id,
        kind: result.kind ?? phaseRun?.kind,
        command:
          phaseRun?.kind === 'shell'
            ? phaseRun.command
            : phaseRun?.kind === 'vitestChanged'
              ? phaseToRun.run.command
              : undefined,
        agent: phaseRun?.kind === 'kiro' ? phaseRun.agent : undefined,
        code: result.code,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        allowFailure: Boolean(phase.allowFailure),
        adapterUsed: result.adapterUsed,
        fallbackUsed: result.fallbackUsed,
        prefetched: Boolean(usePrefetchedStrategist),
      }

      if (phaseRun?.kind === 'vitestChanged') phaseResult.kind = 'vitestChanged'
      if (phaseRun?.kind === 'vitestChanged') {
        phaseResult.resolvedTests = resolvedTests
        phaseResult.changedFiles = changedFiles
      }
      if (result.fallbackUsed) {
        phaseResult.transportDegraded = true
        transportDegraded = true
      }

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

      if (result.code === 0) {
        const markers = parseLinearMarkers(result.out)
        if (markers.length > 0) {
          phaseResult.linearMarkers = markers
        }

        const activeCandidates = []
        let linearContextDirty = false
        for (const marker of markers) {
          if (marker.type === 'new_task') {
            const processed = await processLinearMarkers(config, [marker], phase.id, linearTasks ?? [], {
              env: process.env,
            })
            if (Array.isArray(processed.tasks)) {
              linearTasks = processed.tasks
              rememberResolvedTasks(linearTasks)
            } else {
              linearTasks = (await queryLinearTasks(config, { env: process.env })) ?? linearTasks
              rememberResolvedTasks(linearTasks ?? [])
            }
            linearContextDirty = true
            continue
          }

          if (marker.type === 'active') {
            const task = await resolveTaskReference(marker, linearTasks ?? [])
            activeCandidates.push({ marker, task })
            continue
          }

          if (marker.type === 'done') {
            pendingDoneMarkers.push({ phaseId: phase.id, marker })
          }
        }

        const selectedActiveCandidate = selectCanonicalActiveCandidate(
          phase.id,
          activeCandidates.filter((candidate) => candidate.task),
          canonicalActiveTask,
          linearWarnings
        )
        if (selectedActiveCandidate) {
          const processed = await processLinearMarkers(
            config,
            [selectedActiveCandidate.marker],
            phase.id,
            linearTasks ?? [],
            { env: process.env }
          )
          if (Array.isArray(processed.tasks)) {
            linearTasks = processed.tasks
            rememberResolvedTasks(linearTasks)
          } else {
            linearTasks = (await queryLinearTasks(config, { env: process.env })) ?? linearTasks
            rememberResolvedTasks(linearTasks ?? [])
          }
          canonicalActiveTask =
            await resolveTaskReference(selectedActiveCandidate.marker, linearTasks ?? []) ??
            rememberResolvedTask(selectedActiveCandidate.task) ??
            canonicalActiveTask
          linearContextDirty = true
        }

        if (linearContextDirty) {
          await refreshLinearContext()
        }
      }

      handoff = truncateHandoff(result.out)

      if (config.reviewerPolicy === 'risk-based' && isExecutorPhase(phase.id) && result.code === 0) {
        reviewerAssessment = await assessReviewerRisk(config, executorSnapshot, {
          env: process.env,
          ignorePaths: ignoredRepoPaths,
        })
      }

      if (isReviewerPhase(phase.id) || ['typecheck', 'vitest', 'build'].includes(phase.id)) {
        verificationSummary[phase.id] = {
          ok: result.code === 0,
          code: result.code,
          transportDegraded: Boolean(phaseResult.transportDegraded),
          resolvedTests,
          changedFiles,
        }
      }

      phaseResults.push(phaseResult)

      if (result.code !== 0 && !phase.allowFailure) {
        await checkpointDirtyWorktree('recovery')
        const baseError = phaseRun?.kind === 'vitestChanged'
          ? `Phase ${phase.id} failed: ${String(result.err ?? result.out ?? '').trim() || `code ${result.code}`}`
          : `Phase ${phase.id} failed with code ${result.code}`
        const turnResult = createFailureTurnResult(
          state,
          profileName,
          phaseResults,
          turnStart,
          baseError,
          {
            canonicalActiveTask: summarizeTaskRef(canonicalActiveTask),
            linearWarnings,
            transportDegraded,
            deliverySummary,
            verificationSummary,
          }
        )
        await writeJson(path.join(turnDir, 'result.json'), turnResult)
        await writeTurnResultMarkdown(turnDir, turnResult)
        return turnResult
      }
    }

    const finalSnapshot = await captureWorktreeSnapshot(config.repoDir, {
      env: process.env,
      ignorePaths: ignoredRepoPaths,
    })
    const worktreeDirty = Boolean(finalSnapshot?.status?.trim())
    if (worktreeDirty && config.integrations?.linear?.enabled && !canonicalActiveTask) {
      const turnResult = createFailureTurnResult(
        state,
        profileName,
        phaseResults,
        turnStart,
        'Working tree changed without a canonical Linear task binding',
        {
          canonicalActiveTask: null,
          linearWarnings,
          transportDegraded,
          deliverySummary,
          verificationSummary,
        }
      )
      await writeJson(path.join(turnDir, 'result.json'), turnResult)
      await writeTurnResultMarkdown(turnDir, turnResult)
      return turnResult
    }

    if (worktreeDirty && (config.repoPolicy?.autoCommitAfterEachPhase || config.repoPolicy?.autoPushAfterEachPhase)) {
      const commitResult = await commitWorkingTreeIfDirty(config, {
        env: process.env,
        activeTask: canonicalActiveTask,
        deliveryScope: 'turn',
        turnLabel,
        ignorePaths: ignoredRepoPaths,
      })
      if (!commitResult.committed && config.repoPolicy?.autoCommitAfterEachPhase) {
        throw new Error(commitResult.skippedReason ?? 'delivery commit did not complete')
      }
      if (commitResult.committed) {
        deliverySummary.committed = true
        deliverySummary.subject = commitResult.subject
      }
      const pushResult = await pushBranchIfNeeded(config, {
        env: process.env,
        turnLabel,
      })
      if (pushResult.pushed) {
        deliverySummary.pushed = true
        deliverySummary.branch = pushResult.branch
      }
    }

    if (canonicalActiveTask && pendingDoneMarkers.length > 0) {
      const matchingDoneMarkers = []
      for (const entry of pendingDoneMarkers) {
        const resolvedTask = await resolveTaskReference(entry.marker, linearTasks ?? [])
        if (resolvedTask && tasksMatch(resolvedTask, canonicalActiveTask)) {
          matchingDoneMarkers.push(entry)
        } else {
          linearWarnings.push(
            `${entry.phaseId}: ignored LINEAR_DONE for ${describeLinearMarker(entry.marker)} because it does not match the canonical task`
          )
        }
      }

      const selectedDoneMarker = matchingDoneMarkers.at(-1) ?? null
      if (selectedDoneMarker) {
        const processed = await processLinearMarkers(
          config,
          [selectedDoneMarker.marker],
          selectedDoneMarker.phaseId,
          linearTasks ?? [],
          { env: process.env }
        )
        if (Array.isArray(processed.tasks)) {
          linearTasks = processed.tasks
          rememberResolvedTasks(linearTasks)
        } else {
          linearTasks = (await queryLinearTasks(config, { env: process.env })) ?? linearTasks
          rememberResolvedTasks(linearTasks ?? [])
        }
        canonicalActiveTask =
          await resolveTaskReference(selectedDoneMarker.marker, linearTasks ?? []) ??
          rememberResolvedTask({ ...canonicalActiveTask, status: 'Done' })
        deliverySummary.done = true
        await refreshLinearContext()
      }
    } else if (!canonicalActiveTask && pendingDoneMarkers.length > 0) {
      for (const entry of pendingDoneMarkers) {
        linearWarnings.push(
          `${entry.phaseId}: ignored LINEAR_DONE for ${describeLinearMarker(entry.marker)} because no canonical task was bound`
        )
      }
    }

    const turnResult = {
      turn: state.turn,
      timestamp: nowIso(),
      profile: profileName,
      ok: true,
      durationMs: Date.now() - turnStart,
      phases: phaseResults,
      errorSummary: null,
      canonicalActiveTask: summarizeTaskRef(canonicalActiveTask),
      linearWarnings,
      transportDegraded,
      deliverySummary,
      verificationSummary,
    }

    await writeJson(path.join(turnDir, 'result.json'), turnResult)
    await writeTurnResultMarkdown(turnDir, turnResult)
    return turnResult
  } catch (error) {
    await checkpointDirtyWorktree('recovery').catch(() => {})
    deliverySummary.error = error?.message ?? String(error)
    const turnResult = createFailureTurnResult(
      state,
      profileName,
      phaseResults,
      turnStart,
      `Runtime error: ${deliverySummary.error}`,
      {
        canonicalActiveTask: summarizeTaskRef(canonicalActiveTask),
        linearWarnings,
        transportDegraded,
        deliverySummary,
        verificationSummary,
      }
    )
    await writeJson(path.join(turnDir, 'result.json'), turnResult)
    await writeTurnResultMarkdown(turnDir, turnResult)
    return turnResult
  }
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
