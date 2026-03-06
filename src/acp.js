import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'

function normalizeCommand(command) {
  const text = String(command ?? '').trim()
  return text || 'kiro-acp'
}

export function extractText(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)

  if (Array.isArray(value)) {
    return value
      .map((item) => extractText(item))
      .filter(Boolean)
      .join('\n')
  }

  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text
    if (Array.isArray(value.content)) {
      const fromContent = extractText(value.content)
      if (fromContent) return fromContent
    }
    if (Array.isArray(value.prompt)) {
      const fromPrompt = extractText(value.prompt)
      if (fromPrompt) return fromPrompt
    }
    if (value.result !== undefined) {
      const fromResult = extractText(value.result)
      if (fromResult) return fromResult
    }
    if (typeof value.message === 'string') return value.message
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export class AcpClient extends EventEmitter {
  constructor({ command, agent, cwd, env, trustAllTools = true, onEvent } = {}) {
    super()
    this.command = normalizeCommand(command)
    this.agent = String(agent ?? 'default')
    this.cwd = cwd
    this.env = env
    this.trustAllTools = Boolean(trustAllTools)
    this.onEvent = typeof onEvent === 'function' ? onEvent : null

    this.proc = null
    this.nextId = 1
    this.pending = new Map()
    this.stdoutBuffer = ''
    this.stopped = false
    this.stopPromise = null
  }

  start() {
    if (this.proc) return this.proc

    const args = ['--agent', this.agent]
    if (this.trustAllTools) args.push('--trust-all-tools')
    this.proc = spawn(this.command, args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })

    this.proc.stdout.setEncoding('utf8')
    this.proc.stderr.setEncoding('utf8')

    this.proc.stdout.on('data', (chunk) => {
      this.stdoutBuffer += chunk
      this._drainStdoutBuffer()
    })

    this.proc.stderr.on('data', (chunk) => {
      this.emit('stderr', chunk)
      this._emitEvent({
        kind: 'stderr',
        text: String(chunk),
      })
    })

    this.proc.on('error', (err) => {
      this._rejectAllPending(err)
      this.emit('error', err)
    })

    this.proc.on('close', (code, signal) => {
      const err = this.stopped
        ? null
        : new Error(`ACP process closed (code=${code ?? 'null'}, signal=${signal ?? 'null'})`)
      if (err) this._rejectAllPending(err)
      this.emit('close', { code, signal, stopped: this.stopped })
    })

    return this.proc
  }

  async initialize() {
    return this._sendRequest(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: {
          name: 'zhuge-loop',
          version: '0.1.0',
        },
      },
      30_000
    )
  }

  async sessionNew(cwd) {
    const result = await this._sendRequest(
      'session/new',
      {
        cwd,
        mcpServers: [],
      },
      30_000
    )
    const sessionId = result?.sessionId
    if (!sessionId) {
      throw new Error(`ACP session/new missing sessionId: ${extractText(result)}`)
    }
    return sessionId
  }

  async sessionPrompt(sessionId, prompt, timeoutMs) {
    let streamedText = ''
    const onEvent = (event) => {
      if (event?.kind !== 'notification' || event.method !== 'session/update') return
      const params = event.params ?? {}
      if (params.sessionId !== sessionId) return
      const update = params.update ?? {}
      if (update.sessionUpdate !== 'agent_message_chunk') return
      streamedText += extractText(update.content)
    }

    this.on('event', onEvent)
    const result = await this._sendRequest(
      'session/prompt',
      {
        sessionId,
        prompt: [{ type: 'text', text: String(prompt ?? '') }],
      },
      Number(timeoutMs) > 0 ? Number(timeoutMs) : 300_000
    ).finally(() => {
      this.off('event', onEvent)
    })

    const fallbackText = extractText(result)
    return {
      stdout: streamedText.trim() || fallbackText,
      stderr: '',
      raw: result,
    }
  }

  async stop({ timeoutMs = 8_000 } = {}) {
    if (this.stopPromise) return this.stopPromise
    this.stopped = true

    this.stopPromise = (async () => {
      const proc = this.proc
      if (!proc) return

      this._rejectAllPending(new Error('ACP client stopped'))

      try {
        proc.stdin.end()
      } catch {
        // ignore
      }

      try {
        process.kill(-proc.pid, 'SIGTERM')
      } catch {
        // ignore
      }

      try {
        proc.kill('SIGTERM')
      } catch {
        // ignore
      }

      const closed = await new Promise((resolve) => {
        let done = false
        const finish = () => {
          if (done) return
          done = true
          resolve(true)
        }

        proc.once('close', finish)
        setTimeout(() => {
          if (done) return
          try {
            process.kill(-proc.pid, 'SIGKILL')
          } catch {
            // ignore
          }
          try {
            proc.kill('SIGKILL')
          } catch {
            // ignore
          }
          finish()
        }, timeoutMs)
      })

      if (!closed) {
        throw new Error('ACP process did not close in time')
      }
    })()

    return this.stopPromise
  }

  _drainStdoutBuffer() {
    while (true) {
      const idx = this.stdoutBuffer.indexOf('\n')
      if (idx < 0) return
      const line = this.stdoutBuffer.slice(0, idx).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1)
      if (!line) continue
      this._handleLine(line)
    }
  }

  _handleLine(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      this.emit('stderr', `[ACP] invalid JSON line from stdout: ${line}`)
      return
    }

    if (Object.prototype.hasOwnProperty.call(msg, 'id') && !Object.prototype.hasOwnProperty.call(msg, 'method')) {
      const pending = this.pending.get(msg.id)
      if (!pending) return
      this.pending.delete(msg.id)
      clearTimeout(pending.timer)
      if (Object.prototype.hasOwnProperty.call(msg, 'error')) {
        pending.reject(new Error(`ACP error response (${msg.id}): ${extractText(msg.error)}`))
      } else {
        pending.resolve(msg.result)
      }
      return
    }

    if (Object.prototype.hasOwnProperty.call(msg, 'id') && typeof msg.method === 'string') {
      this._handleServerRequest(msg).catch((err) => {
        this._sendResponse(msg.id, null, {
          code: -32603,
          message: `internal error: ${err.message}`,
        })
      })
      return
    }

    if (typeof msg.method === 'string') {
      this._emitEvent({
        kind: 'notification',
        method: msg.method,
        params: msg.params,
      })
      this.emit('notification', msg)
    }
  }

  async _handleServerRequest(msg) {
    if (msg.method === 'session/request_permission') {
      await this._sendResponse(msg.id, { optionId: 'allow_always' })
      this._emitEvent({
        kind: 'permission',
        method: msg.method,
        params: msg.params,
        result: { optionId: 'allow_always' },
      })
      return
    }

    await this._sendResponse(msg.id, null, {
      code: -32601,
      message: `method not supported: ${msg.method}`,
    })
  }

  _sendResponse(id, result, error = null) {
    const payload = error
      ? { jsonrpc: '2.0', id, error }
      : { jsonrpc: '2.0', id, result }
    this._writeJson(payload)
  }

  _sendRequest(method, params, timeoutMs) {
    if (this.stopped) return Promise.reject(new Error('ACP client already stopped'))
    if (!this.proc) this.start()

    const id = this.nextId++
    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      params: params ?? {},
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`ACP request timeout: ${method} (${timeoutMs}ms)`))
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, timer })
      try {
        this._writeJson(payload)
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err)
      }
    })
  }

  _writeJson(payload) {
    if (!this.proc || !this.proc.stdin) throw new Error('ACP process stdin unavailable')
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  _rejectAllPending(err) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer)
      pending.reject(err)
      this.pending.delete(id)
    }
  }

  _emitEvent(event) {
    this.emit('event', event)
    if (this.onEvent) {
      try {
        this.onEvent(event)
      } catch {
        // ignore callback errors
      }
    }
  }
}

export function startAcpProcess(command, agent, opts = {}) {
  const client = new AcpClient({
    command,
    agent,
    cwd: opts.cwd,
    env: opts.env,
    trustAllTools: opts.trustAllTools,
    onEvent: opts.onEvent,
  })
  client.start()
  return client
}
