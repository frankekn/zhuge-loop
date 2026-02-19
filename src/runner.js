import { spawn } from 'node:child_process'
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
