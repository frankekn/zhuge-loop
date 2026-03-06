import { spawn } from 'node:child_process'
import { startAcpProcess } from './acp.js'
import { runKiroCliPhase } from './kiro.js'
import { nowIso, truncate } from './utils.js'

export function runCommand(command, options = {}) {
  const {
    cwd = process.cwd(),
    timeoutMs = 600_000,
    env = process.env,
  } = options

  const shell = process.env.SHELL || '/bin/bash'
  const startedAt = nowIso()
  const startedTime = Date.now()

  return new Promise((resolve) => {
    let child
    try {
      child = spawn(shell, ['-lc', command], {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      })
    } catch (error) {
      resolve({
        code: 1,
        timedOut: false,
        durationMs: Date.now() - startedTime,
        startedAt,
        endedAt: nowIso(),
        out: '',
        err: `spawn failed: ${error?.message ?? String(error)}`,
      })
      return
    }

    let out = ''
    let err = ''
    let timedOut = false
    let timeout = null

    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true
        err += `\n[TIMEOUT] command exceeded ${timeoutMs}ms\n`
        if (!child?.pid) return
        try {
          process.kill(-child.pid, 'SIGTERM')
        } catch {
          // ignore
        }
        setTimeout(() => {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch {
            // ignore
          }
        }, 3000)
      }, timeoutMs)
    }

    child.stdout.on('data', (chunk) => {
      out += chunk.toString()
    })

    child.stderr.on('data', (chunk) => {
      err += chunk.toString()
    })

    child.on('error', (error) => {
      if (timeout) clearTimeout(timeout)
      resolve({
        code: 1,
        timedOut,
        durationMs: Date.now() - startedTime,
        startedAt,
        endedAt: nowIso(),
        out: truncate(out),
        err: truncate(`${err}\nspawn error: ${error?.message ?? String(error)}`),
      })
    })

    child.on('close', (code) => {
      if (timeout) clearTimeout(timeout)
      resolve({
        code: timedOut ? 124 : (code ?? 0),
        timedOut,
        durationMs: Date.now() - startedTime,
        startedAt,
        endedAt: nowIso(),
        out: truncate(out),
        err: truncate(err),
      })
    })
  })
}

function isTimeoutError(error) {
  return /timeout/i.test(error?.message ?? String(error))
}

function createFailedResult(startedAt, startedTime, error, extra = {}) {
  const timedOut = isTimeoutError(error)
  return {
    code: timedOut ? 124 : 1,
    timedOut,
    durationMs: Date.now() - startedTime,
    startedAt,
    endedAt: nowIso(),
    out: '',
    err: truncate(error?.message ?? String(error)),
    ...extra,
  }
}

export async function runPhase(phase, options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    kiro = {},
  } = options
  const phaseRun = phase.run ?? (phase.command ? { kind: 'shell', command: phase.command } : null)

  if (phaseRun?.kind === 'shell') {
    const result = await runCommand(phaseRun.command, {
      cwd,
      env,
      timeoutMs: phase.timeoutMs,
    })

    return {
      ...result,
      kind: 'shell',
    }
  }

  if (phaseRun?.kind !== 'kiro') {
    return createFailedResult(nowIso(), Date.now(), new Error(`Unsupported phase kind: ${phaseRun?.kind ?? 'unknown'}`))
  }

  const startedAt = nowIso()
  const startedTime = Date.now()
  const metadataEvents = []
  let sessionId = null
  let contextUsagePercentage = null
  let acpClient = null

  const collectMetadata = (event) => {
    if (event?.kind !== 'notification' || event.method !== '_kiro.dev/metadata') return
    const payload = event.params ?? {}
    metadataEvents.push(payload)
    if (payload.sessionId && !sessionId) {
      sessionId = String(payload.sessionId)
    }
    if (typeof payload.contextUsagePercentage === 'number') {
      contextUsagePercentage = payload.contextUsagePercentage
    }
  }

  const finalize = (result, extra = {}) => ({
    ...result,
    kind: 'kiro',
    agent: phaseRun.agent,
    adapterRequested: 'acp',
    metadata: {
      sessionId,
      contextUsagePercentage,
      metadataEvents,
    },
    ...extra,
  })

  try {
    acpClient = startAcpProcess(kiro.acpCommand, phaseRun.agent, {
      cwd,
      env,
      trustAllTools: kiro.trustAllTools,
      onEvent: collectMetadata,
    })

    await acpClient.initialize()
    sessionId = await acpClient.sessionNew(cwd)
    const acpResult = await acpClient.sessionPrompt(sessionId, phaseRun.prompt, phase.timeoutMs)

    return finalize(
      {
        code: 0,
        timedOut: false,
        durationMs: Date.now() - startedTime,
        startedAt,
        endedAt: nowIso(),
        out: truncate(acpResult.stdout),
        err: truncate(acpResult.stderr),
      },
      {
        adapterUsed: 'acp',
        fallbackUsed: false,
      }
    )
  } catch (error) {
    const fallbackAllowed = kiro.fallbackToCli !== false
    if (!fallbackAllowed) {
      return finalize(createFailedResult(startedAt, startedTime, error), {
        adapterUsed: 'acp',
        fallbackUsed: false,
      })
    }

    const fallbackResult = await runKiroCliPhase(phaseRun.agent, phaseRun.prompt, {
      command: kiro.cliCommand,
      cwd,
      env,
      timeoutMs: phase.timeoutMs,
      trustAllTools: kiro.trustAllTools,
    })

    return finalize(
      {
        ...fallbackResult,
        durationMs: Date.now() - startedTime,
        startedAt,
        endedAt: nowIso(),
        err: truncate(
          [`[ACP FALLBACK] ${error?.message ?? String(error)}`, fallbackResult.err]
            .filter(Boolean)
            .join('\n')
        ),
      },
      {
        adapterUsed: 'cli',
        fallbackUsed: true,
      }
    )
  } finally {
    if (acpClient) {
      await acpClient.stop().catch(() => {})
    }
  }
}
