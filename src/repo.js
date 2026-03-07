import { runCommand } from './runner.js'

function compactOneLine(text, maxLength = 80) {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
}

function safeRegex(pattern) {
  try {
    if (!pattern) return null
    return new RegExp(pattern)
  } catch {
    return null
  }
}

function normalizeRefName(value, key) {
  const ref = String(value ?? '').trim()
  if (!ref) throw new Error(`${key} is required`)
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) {
    throw new Error(`${key} contains unsupported characters: ${ref}`)
  }
  return ref
}

async function requireSuccess(command, cwd, timeoutMs, env = process.env) {
  const result = await runCommand(command, { cwd, timeoutMs, env })
  if (result.code === 0) {
    return String(result.out ?? '').trim()
  }
  throw new Error(String(result.err || result.out || `command failed: ${command}`).trim())
}

async function commandSucceeds(command, cwd, timeoutMs, env = process.env) {
  const result = await runCommand(command, { cwd, timeoutMs, env })
  return result.code === 0
}

async function isWorkingTreeClean(cwd, env = process.env) {
  const status = await requireSuccess('git status --porcelain=v1', cwd, 5_000, env).catch(() => '')
  return !status.trim()
}

function parseLines(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function normalizeRepoPath(filePath) {
  return String(filePath ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
}

function normalizeIgnoredPaths(paths) {
  return Array.isArray(paths)
    ? paths
        .map((filePath) => normalizeRepoPath(filePath))
        .filter(Boolean)
        .sort()
    : []
}

function shouldIgnorePath(filePath, ignoredPaths) {
  const normalized = normalizeRepoPath(filePath)
  if (!normalized) return false
  return ignoredPaths.some((ignoredPath) => (
    normalized === ignoredPath || normalized.startsWith(`${ignoredPath}/`)
  ))
}

function extractStatusPaths(line) {
  const raw = String(line ?? '').slice(3).trim()
  if (!raw) return []
  return raw
    .split(' -> ')
    .map((filePath) => normalizeRepoPath(filePath.replace(/^"|"$/g, '')))
    .filter(Boolean)
}

function filterStatusOutput(text, ignoredPaths) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => {
      const paths = extractStatusPaths(line)
      return paths.length === 0 || paths.some((filePath) => !shouldIgnorePath(filePath, ignoredPaths))
    })
    .join('\n')
}

export async function captureWorktreeSnapshot(repoDir, options = {}) {
  const env = options.env ?? process.env
  const ignoredPaths = normalizeIgnoredPaths(options.ignorePaths)
  const inside = await commandSucceeds('git rev-parse --is-inside-work-tree', repoDir, 5_000, env)
  if (!inside) return null

  const [head, branch, status] = await Promise.all([
    requireSuccess('git rev-parse HEAD', repoDir, 5_000, env).catch(() => ''),
    requireSuccess('git rev-parse --abbrev-ref HEAD', repoDir, 5_000, env).catch(() => ''),
    requireSuccess('git status --porcelain=v1', repoDir, 5_000, env).catch(() => ''),
  ])

  return {
    head: String(head ?? '').trim(),
    branch: String(branch ?? '').trim(),
    status: filterStatusOutput(status, ignoredPaths).trim(),
  }
}

export function sameWorktreeSnapshot(left, right) {
  if (!left || !right) return false
  return (
    String(left.head ?? '') === String(right.head ?? '') &&
    String(left.branch ?? '') === String(right.branch ?? '') &&
    String(left.status ?? '') === String(right.status ?? '')
  )
}

export async function listFilesChangedSinceSnapshot(repoDir, snapshot, options = {}) {
  if (!snapshot?.head) {
    return { reliable: false, files: [] }
  }

  const env = options.env ?? process.env
  const ignoredPaths = normalizeIgnoredPaths(options.ignorePaths)
  if (String(snapshot.status ?? '').trim()) {
    return { reliable: false, files: [] }
  }

  const current = await captureWorktreeSnapshot(repoDir, {
    env,
    ignorePaths: ignoredPaths,
  })
  if (!current) {
    return { reliable: false, files: [] }
  }

  const files = new Set()
  const commands = []

  if (snapshot.head !== current.head) {
    commands.push(`git diff --name-only ${JSON.stringify(snapshot.head)} ${JSON.stringify(current.head)}`)
  }

  commands.push('git diff --name-only')
  commands.push('git diff --cached --name-only')
  commands.push('git ls-files --others --exclude-standard')

  for (const command of commands) {
    const output = await requireSuccess(command, repoDir, 10_000, env).catch(() => '')
    for (const filePath of parseLines(output)) {
      if (shouldIgnorePath(filePath, ignoredPaths)) continue
      files.add(filePath)
    }
  }

  return {
    reliable: true,
    files: [...files].sort(),
  }
}

function formatAutoCommitMessage(ctx = {}) {
  const phaseId = compactOneLine(ctx.phaseId || 'phase', 24).toLowerCase()
  const identifier = compactOneLine(ctx.activeTask?.identifier, 32)

  if (identifier) {
    return `${identifier}: sync ${phaseId} changes`
  }

  const title = compactOneLine(ctx.activeTask?.title, 48)
  if (title) {
    const keyMatch = title.match(/([A-Z]+-\d+)/)
    if (keyMatch) {
      return `${keyMatch[1]}: sync ${phaseId} changes`
    }
    return `chore: sync ${phaseId} changes for ${title}`
  }

  return `chore: sync ${phaseId} changes`
}

function validateCommitMessage(config, subject) {
  const raw = String(subject ?? '').trim()
  if (!raw) return { ok: false, reason: 'empty commit subject' }

  const maxLength = Number(config.repoPolicy?.commitMessageMaxLen ?? 96)
  if (Number.isFinite(maxLength) && raw.length > maxLength) {
    return { ok: false, reason: `commit subject too long (${raw.length} > ${maxLength})` }
  }

  const lower = raw.toLowerCase()
  const bannedHints = ['autosave', 'auto-commit', 'wip', 'tmp']
  if (bannedHints.some((hint) => lower.includes(hint))) {
    return { ok: false, reason: 'commit subject looks like an autosave/WIP' }
  }

  if (config.repoPolicy?.requireConventionalCommits) {
    const re = /^(?:(feat|fix|chore|refactor|test|docs|style|perf|build|ci|revert)(\([^)]+\))?:\s.+|AIR-[\w-]+:\s.+)/
    if (!re.test(raw)) {
      return { ok: false, reason: 'commit subject must follow Conventional Commits' }
    }
  }

  const issueRe = safeRegex(config.repoPolicy?.requireIssueKeyRegex)
  if (issueRe && !issueRe.test(raw)) {
    return { ok: false, reason: `commit subject must include issue key (${config.repoPolicy.requireIssueKeyRegex})` }
  }

  return { ok: true }
}

export async function ensureOnDeliveryBranch(config, options = {}) {
  const pushBranch = config.repoPolicy?.pushBranch
  if (!pushBranch) return null

  const cwd = config.repoDir
  const env = options.env ?? process.env
  const turnLabel = options.turnLabel ?? 'turn'
  const branchName = normalizeRefName(pushBranch, 'repoPolicy.pushBranch')

  await requireSuccess('git rev-parse --is-inside-work-tree', cwd, 5_000, env)

  const localExists = await commandSucceeds(`git rev-parse --verify --quiet refs/heads/${branchName}`, cwd, 5_000, env)
  if (!localExists) {
    await requireSuccess('git fetch --prune origin', cwd, 30_000, env).catch(() => '')
    const hasOriginMain = await commandSucceeds('git rev-parse --verify --quiet refs/remotes/origin/main', cwd, 5_000, env)
    const hasMain = await commandSucceeds('git rev-parse --verify --quiet refs/heads/main', cwd, 5_000, env)
    if (!hasOriginMain && !hasMain) {
      throw new Error(`cannot create ${branchName}: neither origin/main nor main exists`)
    }
    const startRef = hasOriginMain ? 'origin/main' : 'main'
    await requireSuccess(`git checkout -b ${branchName} ${startRef}`, cwd, 15_000, env)
    console.log(`[${turnLabel}] Created ${branchName} from ${startRef}`)
  }

  const currentBranch = await requireSuccess('git rev-parse --abbrev-ref HEAD', cwd, 5_000, env)
  if (currentBranch !== branchName) {
    await requireSuccess(`git checkout ${branchName}`, cwd, 15_000, env)
    console.log(`[${turnLabel}] Switched to ${branchName}`)
  }

  await commandSucceeds(`git branch --set-upstream-to=origin/${branchName} ${branchName}`, cwd, 5_000, env)

  const clean = await isWorkingTreeClean(cwd, env)
  if (!clean) {
    const onDirty = config.repoPolicy?.onDirty ?? 'warn'
    if (onDirty === 'auto-stash') {
      await requireSuccess('git stash push --include-untracked -m "zhuge-loop auto-stash"', cwd, 20_000, env)
      console.log(`[${turnLabel}] Auto-stashed dirty working tree before continuing`)
    } else {
      console.warn(`[${turnLabel}] Working tree dirty; skipping fetch/rebase update for ${branchName}`)
      return branchName
    }
  }

  await requireSuccess('git fetch --prune origin', cwd, 30_000, env).catch(() => '')
  const remoteExists = await commandSucceeds(`git rev-parse --verify --quiet refs/remotes/origin/${branchName}`, cwd, 5_000, env)
  if (remoteExists) {
    await requireSuccess(`git rebase origin/${branchName}`, cwd, 60_000, env)
    await commandSucceeds(`git branch --set-upstream-to=origin/${branchName} ${branchName}`, cwd, 5_000, env)
  }

  return branchName
}

export async function commitWorkingTreeIfDirty(config, ctx = {}) {
  if (!config.repoPolicy?.autoCommitAfterEachPhase) {
    return { committed: false }
  }

  const cwd = config.repoDir
  const env = ctx.env ?? process.env
  const clean = await isWorkingTreeClean(cwd, env)
  if (clean) return { committed: false }

  await requireSuccess('git add -A', cwd, 10_000, env)
  const stagedNames = await requireSuccess('git diff --cached --name-only', cwd, 5_000, env).catch(() => '')
  if (!String(stagedNames).trim()) {
    throw new Error('working tree is dirty but nothing is staged for commit')
  }

  const subject = formatAutoCommitMessage(ctx)
  const validation = validateCommitMessage(config, subject)
  if (!validation.ok) {
    // Auto-commit messages may lack issue keys when no activeTask is available.
    // Warn and skip instead of crashing to prevent restart loops.
    console.warn(`[${ctx.turnLabel ?? 'turn'}] Skipping auto-commit (${validation.reason}): ${subject}`)
    await requireSuccess('git reset HEAD', cwd, 5_000, env).catch(() => {})
    return { committed: false, skippedReason: validation.reason }
  }

  await requireSuccess(`git commit -m ${JSON.stringify(subject)}`, cwd, 120_000, env)
  console.log(`[${ctx.turnLabel ?? 'turn'}] Committed working tree: ${subject}`)
  return { committed: true, subject }
}

export async function pushBranchIfNeeded(config, ctx = {}) {
  if (!config.repoPolicy?.autoPushAfterEachPhase) {
    return { pushed: false }
  }

  const pushBranch = config.repoPolicy?.pushBranch
  if (!pushBranch) {
    return { pushed: false }
  }

  const cwd = config.repoDir
  const env = ctx.env ?? process.env
  const branchName = normalizeRefName(pushBranch, 'repoPolicy.pushBranch')
  await requireSuccess(`git push -u origin ${branchName}`, cwd, 60_000, env)
  console.log(`[${ctx.turnLabel ?? 'turn'}] Pushed ${branchName} to origin/${branchName}`)
  return { pushed: true, branch: branchName }
}
