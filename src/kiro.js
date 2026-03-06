import { spawn } from 'node:child_process'
import { nowIso, truncate } from './utils.js'

const MAX_FALLBACK_PROMPT_CHARS = 30_000

function clampPrompt(prompt) {
  const text = String(prompt ?? '')
  if (text.length <= MAX_FALLBACK_PROMPT_CHARS) return text
  return `${text.slice(0, MAX_FALLBACK_PROMPT_CHARS)}\n\n[TRUNCATED: prompt exceeded ${MAX_FALLBACK_PROMPT_CHARS} chars]`
}

function shouldRetryWithArgv(errorText) {
  const text = String(errorText ?? '')
  if (!text) return false

  if (/Usage:\s*kiro-cli-chat\s+chat/i.test(text)) return true
  if (/Input must be supplied when running in non-interactive mode/i.test(text)) return true

  const lower = text.toLowerCase()
  const hasNonInteractive = lower.includes('non-interactive')
  const hasMissingInput =
    (lower.includes('input') || lower.includes('prompt')) &&
    (lower.includes('required') ||
      lower.includes('missing') ||
      lower.includes('must be supplied') ||
      lower.includes('must be provided') ||
      lower.includes('not provided') ||
      lower.includes('no input'))
  const hasUnsupportedStdin =
    lower.includes('stdin') &&
    (lower.includes('unsupported') || lower.includes('not supported') || lower.includes('ignored'))

  return (hasNonInteractive && hasMissingInput) || hasUnsupportedStdin
}

function finalizeResult({ startedAt, startedTime, stdout, stderr, exitCode, timedOut }) {
  return {
    code: timedOut ? 124 : exitCode,
    timedOut,
    durationMs: Date.now() - startedTime,
    startedAt,
    endedAt: nowIso(),
    out: truncate(stdout),
    err: truncate(stderr),
  }
}

function runOnce(command, args, prompt, options) {
  const {
    cwd = process.cwd(),
    timeoutMs = 600_000,
    env = process.env,
    stdinMode = true,
  } = options

  const startedAt = nowIso()
  const startedTime = Date.now()

  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio: [stdinMode ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        detached: true,
      })
    } catch (error) {
      resolve(
        finalizeResult({
          startedAt,
          startedTime,
          stdout: '',
          stderr: `spawn failed: ${error?.message ?? String(error)}`,
          exitCode: 1,
          timedOut: false,
        })
      )
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let finished = false

    const finish = (result) => {
      if (finished) return
      finished = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }

    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          try {
            process.kill(-child.pid, 'SIGTERM')
          } catch {
            // ignore
          }
          try {
            child.kill('SIGTERM')
          } catch {
            // ignore
          }
          setTimeout(() => {
            try {
              process.kill(-child.pid, 'SIGKILL')
            } catch {
              // ignore
            }
            try {
              child.kill('SIGKILL')
            } catch {
              // ignore
            }
          }, 5000)
        }, timeoutMs)
      : null

    child.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    child.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    child.on('error', (error) => {
      finish(
        finalizeResult({
          startedAt,
          startedTime,
          stdout,
          stderr: `${stderr}\nspawn error: ${error?.message ?? String(error)}`,
          exitCode: 1,
          timedOut,
        })
      )
    })

    child.on('close', (code) => {
      finish(
        finalizeResult({
          startedAt,
          startedTime,
          stdout,
          stderr,
          exitCode: code ?? 0,
          timedOut,
        })
      )
    })

    if (stdinMode) {
      try {
        child.stdin.write(String(prompt ?? ''))
        child.stdin.end()
      } catch (error) {
        finish(
          finalizeResult({
            startedAt,
            startedTime,
            stdout,
            stderr: `${stderr}\nstdin error: ${error?.message ?? String(error)}`,
            exitCode: 1,
            timedOut,
          })
        )
      }
    }
  })
}

export async function runKiroCliPhase(agent, prompt, options = {}) {
  const command = String(options.command ?? 'kiro-cli-chat').trim() || 'kiro-cli-chat'
  const trustAllTools = options.trustAllTools !== false
  const args = ['chat', '--agent', agent, '--no-interactive']
  if (trustAllTools) args.push('--trust-all-tools')

  const initial = await runOnce(command, args, prompt, {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    stdinMode: true,
  })

  if (initial.code === 0 || initial.timedOut) {
    return initial
  }

  if (!shouldRetryWithArgv(`${initial.err}\n${initial.out}`)) {
    return initial
  }

  const argvArgs = [...args, '--', clampPrompt(prompt)]
  return runOnce(command, argvArgs, prompt, {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    stdinMode: false,
  })
}
