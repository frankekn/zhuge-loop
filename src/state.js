import { readJson, writeJson } from './utils.js'

const STATE_VERSION = 1

export function createInitialState() {
  return {
    version: STATE_VERSION,
    turn: 0,
    consecutiveFailures: 0,
    lastProfile: null,
    lastTurnAt: null,
    lastError: null,
    activeTask: null,
    lastDeliveryError: null,
    lastTransportDegradedAt: null,
    results: [],
  }
}

export async function loadState(statePath) {
  const fallback = createInitialState()
  const state = await readJson(statePath, fallback)
  if (!state || typeof state !== 'object') return fallback

  return {
    ...fallback,
    ...state,
    results: Array.isArray(state.results) ? state.results : [],
  }
}

export async function saveState(statePath, state) {
  await writeJson(statePath, state)
}

export function recordTurnResult(state, result, keepRecentTurns) {
  const nextActiveTask =
    String(result.canonicalActiveTask?.status ?? '').trim().toLowerCase() === 'done'
      ? null
      : (result.canonicalActiveTask ?? state.activeTask ?? null)

  const next = {
    ...state,
    turn: state.turn + 1,
    lastProfile: result.profile,
    lastTurnAt: result.timestamp,
    lastError: result.ok ? null : (result.errorSummary ?? 'turn failed'),
    activeTask: nextActiveTask,
    lastDeliveryError: result.deliverySummary?.error ?? null,
    lastTransportDegradedAt: result.transportDegraded ? result.timestamp : (state.lastTransportDegradedAt ?? null),
    consecutiveFailures: result.ok ? 0 : state.consecutiveFailures + 1,
    results: [...state.results, result],
  }

  if (next.results.length > keepRecentTurns) {
    next.results = next.results.slice(next.results.length - keepRecentTurns)
  }

  return next
}
