import { spawn } from 'node:child_process'
import { resolve as resolvePath } from 'node:path'

export const DEFAULT_LINEAR_PROMPT_PHASE_IDS = ['strategist', 'coordinator']
const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql'

function resolveLinearApiKey(config, options = {}) {
  const env = options.env ?? process.env
  const envApiKey = String(env.LINEAR_API_KEY ?? process.env.LINEAR_API_KEY ?? '').trim()
  const configApiKey = String(config?.integrations?.linear?.apiKey ?? '').trim()
  return envApiKey || configApiKey
}

function hasLinearAuth(config, options = {}) {
  return Boolean(resolveLinearApiKey(config, options))
}

function normalizeTaskStatus(status) {
  return String(status ?? '').trim().toLowerCase()
}

function normalizeIdentifier(value) {
  return String(value ?? '').trim().toUpperCase()
}

function filterActiveLinearTasks(tasks) {
  const keepStatuses = new Set([
    'todo',
    'in progress',
    'backlog',
    'triage',
    'coordinating',
    'executing',
    'in review',
  ])
  return (tasks || []).filter((task) => keepStatuses.has(normalizeTaskStatus(task?.status)))
}

export function normalizeTitle(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

function normalizeLinearIssue(issue) {
  if (!issue || typeof issue !== 'object') return null

  const id = String(issue.id ?? '').trim()
  const title = String(issue.title ?? '').trim()
  if (!id || !title) return null

  const identifier = String(issue.identifier ?? '').trim()
  return {
    id,
    identifier: identifier || undefined,
    title,
    status: String(issue.state?.name ?? issue.status ?? 'unknown'),
    priority: String(issue.priorityLabel ?? issue.priority ?? 'unset'),
  }
}

function tryParseJsonObject(raw) {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {
    // ignore
  }
  return null
}

function extractMarkerPayloads(text, marker) {
  const results = []
  const re = new RegExp(`^\\s*(?:[-*]\\s*)?\\[${marker}\\]\\s*(.+)$`, 'gim')
  for (const match of String(text ?? '').matchAll(re)) {
    const payload = String(match[1] ?? '').trim()
    if (payload) results.push(payload)
  }
  return results
}

function parseTaskTitleHint(payload) {
  const match = String(payload ?? '').match(/(?:task|title|name)\s*=\s*["'`]?([^"'`]+?)["'`]?(?:\s+\w+=|$)/i)
  if (match) return match[1].trim()
  return String(payload ?? '').trim()
}

function parseIdentifierHint(payload) {
  const match = String(payload ?? '').match(/identifier\s*=\s*["'`]?([A-Za-z]+-\d+(?:-[A-Za-z0-9]+)?)["'`]?/i)
  if (match) return match[1].trim().toUpperCase()
  return null
}

function createTaskLookup(tasks = []) {
  const byId = new Map()
  const byTitle = new Map()
  const byIdentifier = new Map()

  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue
    const id = String(task.id ?? '').trim()
    if (id && !byId.has(id)) byId.set(id, task)

    const title = normalizeTitle(task.title)
    if (title && !byTitle.has(title)) byTitle.set(title, task)

    const identifier = normalizeIdentifier(task.identifier)
    if (identifier && !byIdentifier.has(identifier)) byIdentifier.set(identifier, task)
  }

  return {
    byId,
    byTitle,
    byIdentifier,
  }
}

function addTaskToLookup(lookup, task) {
  if (!lookup || !task || typeof task !== 'object') return null

  const normalized = normalizeLinearIssue(task) ?? (() => {
    const id = String(task.id ?? '').trim()
    const title = String(task.title ?? '').trim()
    if (!id || !title) return null
    return {
      id,
      identifier: String(task.identifier ?? '').trim() || undefined,
      title,
      status: String(task.status ?? 'unknown'),
      priority: String(task.priority ?? 'unset'),
    }
  })()

  if (!normalized) return null

  lookup.byId.set(normalized.id, normalized)
  const title = normalizeTitle(normalized.title)
  if (title) lookup.byTitle.set(title, normalized)
  const identifier = normalizeIdentifier(normalized.identifier)
  if (identifier) lookup.byIdentifier.set(identifier, normalized)
  return normalized
}

function resolveMarkerTaskFromLookup(marker, lookup) {
  if (!marker || !lookup) return null

  if (marker.issueId) {
    return lookup.byId.get(String(marker.issueId).trim()) ?? null
  }

  if (marker.identifier) {
    return lookup.byIdentifier.get(normalizeIdentifier(marker.identifier)) ?? null
  }

  if (marker.title) {
    return lookup.byTitle.get(normalizeTitle(marker.title)) ?? null
  }

  return null
}

function parseCreatedTaskOutput(output, fallbackPayload = {}) {
  const raw = String(output ?? '').trim()
  if (!raw) return null

  const parsed = tryParseJsonObject(raw)
  if (parsed) {
    return normalizeLinearIssue({
      ...fallbackPayload,
      ...parsed,
      state: parsed.state ?? fallbackPayload.state,
      status: parsed.status ?? parsed.Status ?? fallbackPayload.status ?? fallbackPayload.Status,
      priority: parsed.priority ?? fallbackPayload.priority,
    })
  }

  const tasks = parseLinearTasksOutput(raw)
  if (tasks.length > 0) {
    return normalizeLinearIssue(tasks[0])
  }

  return null
}

function activeStatusForPhase(phaseId) {
  const normalized = String(phaseId ?? '').trim().toLowerCase()
  if (normalized === 'coordinator' || normalized === 'strategist') return 'Coordinating'
  if (normalized === 'executor' || normalized === 'implement') return 'Executing'
  if (normalized.includes('review')) return 'In Review'
  return null
}

export function shouldInjectLinearContext(config, phaseId) {
  if (!config.integrations?.linear?.enabled) return false
  const phaseIds = Array.isArray(config.integrations.linear.promptPhaseIds)
    ? config.integrations.linear.promptPhaseIds
    : DEFAULT_LINEAR_PROMPT_PHASE_IDS
  return phaseIds.includes(phaseId)
}

export function buildLinearContext(linearTasks, maxChars = 4_000) {
  const activeTasks = filterActiveLinearTasks(linearTasks)
  if (activeTasks.length === 0) return ''

  let keepCount = activeTasks.length
  let json = JSON.stringify(activeTasks, null, 2)

  while (keepCount > 1 && json.length > maxChars) {
    keepCount -= 1
    json = JSON.stringify(activeTasks.slice(0, keepCount), null, 2)
  }

  if (json.length > maxChars) {
    json = `${json.slice(0, maxChars)}…`
  }

  const suffix = keepCount < activeTasks.length
    ? ` (ACTIVE ONLY, TRUNCATED ${keepCount}/${activeTasks.length})`
    : ' (ACTIVE ONLY)'
  return `--- LINEAR TASKS${suffix} ---\n${json}\n--- END LINEAR TASKS ---`
}

export function parseLinearTasksOutput(output) {
  const tasks = []
  const lines = String(output ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  for (const line of lines) {
    if (line === 'No tasks found' || line === '"No tasks found"') continue
    try {
      const parsed = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object') continue
      const id = String(parsed.id ?? '').trim()
      const title = String(parsed.title ?? '').trim()
      if (!id || !title) continue
      tasks.push({
        id,
        identifier: String(parsed.identifier ?? '').trim() || undefined,
        title,
        status: String(parsed.status ?? 'unknown'),
        priority: String(parsed.priority ?? 'unset'),
      })
    } catch {
      // ignore
    }
  }

  return tasks
}

export function parseLinearMarkers(text) {
  const normalized = String(text ?? '').replace(/\x1b\[[0-9;]*[mGKHF]/g, '')
  const markers = []

  const re = /^\s*(?:[-*]\s*)?\[(LINEAR_ACTIVE|LINEAR_DONE|LINEAR_NEW_TASK)\]\s*(.+)$/gim
  for (const match of normalized.matchAll(re)) {
    const kind = String(match[1] ?? '').trim()
    const payload = String(match[2] ?? '').trim()
    if (!payload) continue

    if (kind === 'LINEAR_NEW_TASK') {
      const parsed = tryParseJsonObject(payload)
      if (parsed) markers.push({ type: 'new_task', payload: parsed })
      continue
    }

    const markerType = kind === 'LINEAR_ACTIVE' ? 'active' : 'done'
    const issueIdMatch = payload.match(/issue_id=([0-9a-f-]{36})/i)
    if (issueIdMatch) {
      markers.push({ type: markerType, issueId: issueIdMatch[1] })
      continue
    }

    const parsed = tryParseJsonObject(payload)
    if (parsed) {
      const issueId = String(parsed.issue_id ?? parsed.issueId ?? '').trim()
      if (issueId) {
        markers.push({ type: markerType, issueId })
        continue
      }
      const identifier = normalizeIdentifier(parsed.identifier)
      if (identifier) {
        markers.push({ type: markerType, identifier })
        continue
      }
      const title = String(parsed.task ?? parsed.title ?? parsed.name ?? '').trim()
      if (title) {
        markers.push({ type: markerType, title })
        continue
      }
    }

    const identifier = parseIdentifierHint(payload)
    if (identifier) {
      markers.push({ type: markerType, identifier })
      continue
    }

    const title = parseTaskTitleHint(payload)
    if (title) {
      markers.push({ type: markerType, title })
    }
  }

  return markers
}

export async function queryLinearTasks(config, options = {}) {
  if (!config.integrations?.linear?.enabled) return null
  if (!hasLinearAuth(config, options)) return null

  try {
    const output = await runLinearCli(config, ['query-tasks'], options)
    const tasks = parseLinearTasksOutput(output)
    const maxTasks = Number(config.integrations.linear.maxTasks ?? 10)
    return tasks.slice(0, Number.isFinite(maxTasks) ? maxTasks : 10)
  } catch (error) {
    console.warn(`[Linear] query-tasks failed: ${error?.message ?? String(error)}`)
    return null
  }
}

export async function processLinearMarkers(config, markers, phaseId, openTasks = [], options = {}) {
  if (!config.integrations?.linear?.enabled) return { processed: false, count: 0 }
  if (!hasLinearAuth(config, options)) return { processed: false, count: 0 }

  const lookup = createTaskLookup(openTasks)
  const activeStatus = activeStatusForPhase(phaseId)
  const tasks = [...lookup.byId.values()]

  let count = 0
  for (const marker of markers) {
    try {
      if (marker.type === 'new_task' && marker.payload) {
        const output = await runLinearCli(config, ['create-task', JSON.stringify(marker.payload)], options)
        const createdTask =
          parseCreatedTaskOutput(output, marker.payload) ??
          normalizeLinearIssue({
            ...marker.payload,
            id: tryParseJsonObject(output)?.id,
            status: marker.payload.Status ?? marker.payload.status,
          })
        const addedTask = addTaskToLookup(lookup, createdTask)
        if (addedTask) tasks.push(addedTask)
        count += 1
        continue
      }

      if (marker.type === 'active') {
        const task = resolveMarkerTaskFromLookup(marker, lookup)
        if (task?.id && activeStatus) {
          await runLinearCli(config, ['update-task', task.id, JSON.stringify({ Status: activeStatus })], options)
          addTaskToLookup(lookup, { ...task, status: activeStatus })
          count += 1
        }
        continue
      }

      if (marker.type === 'done') {
        const task = resolveMarkerTaskFromLookup(marker, lookup)
        if (task?.id) {
          await runLinearCli(config, ['update-task', task.id, JSON.stringify({ Status: 'Done' })], options)
          addTaskToLookup(lookup, { ...task, status: 'Done' })
          count += 1
        }
      }
    } catch (error) {
      console.warn(`[Linear] Failed to process marker ${marker.type}: ${error?.message ?? String(error)}`)
    }
  }

  return {
    processed: count > 0,
    count,
    tasks: [...lookup.byId.values()],
  }
}

export async function resolveLinearTaskReference(config, marker, tasks = [], options = {}) {
  if (!marker) return null

  const lookup = createTaskLookup(tasks)
  const matched = resolveMarkerTaskFromLookup(marker, lookup)
  if (matched) return matched

  if (marker.issueId) {
    const normalizedIssueId = String(marker.issueId).trim()
    const fetched = await queryLinearIssueById(config, normalizedIssueId, options)
    if (fetched) return fetched
    return { id: normalizedIssueId }
  }

  if (marker.identifier) {
    return { identifier: normalizeIdentifier(marker.identifier) }
  }

  if (marker.title) {
    const fallback = { title: String(marker.title).trim() }
    const keyMatch = fallback.title.match(/([A-Z]+-\d+)/)
    if (keyMatch) fallback.identifier = keyMatch[1]
    return fallback
  }

  return null
}

export async function queryLinearIssueById(config, issueId, options = {}) {
  if (!config.integrations?.linear?.enabled) return null

  const normalizedIssueId = String(issueId ?? '').trim()
  if (!normalizedIssueId) return null

  const apiKey = resolveLinearApiKey(config, options)
  if (!apiKey) return null

  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return null

  try {
    const response = await fetchImpl(LINEAR_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: apiKey,
      },
      body: JSON.stringify({
        query: `
          query ZhugeLoopIssue($id: String!) {
            issue(id: $id) {
              id
              identifier
              title
              priority
              state {
                name
              }
            }
          }
        `,
        variables: {
          id: normalizedIssueId,
        },
      }),
    })

    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      const errorMessage =
        payload?.errors?.map((entry) => entry?.message).filter(Boolean).join('; ') ||
        `HTTP ${response.status}`
      throw new Error(errorMessage)
    }

    if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
      throw new Error(payload.errors.map((entry) => entry?.message).filter(Boolean).join('; '))
    }

    return normalizeLinearIssue(payload?.data?.issue)
  } catch (error) {
    console.warn(`[Linear] issue lookup failed for ${normalizedIssueId}: ${error?.message ?? String(error)}`)
    return null
  }
}

export async function runLinearCli(config, args, options = {}) {
  return new Promise((resolve, reject) => {
    const cliPath = resolvePath(config.repoDir, config.integrations.linear.cliPath)
    const proc = spawn(cliPath, args, {
      cwd: config.repoDir,
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
      stdio: 'pipe',
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim())
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `exit code ${code}`))
      }
    })

    proc.on('error', reject)
  })
}
