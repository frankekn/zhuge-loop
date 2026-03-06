import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startAcpProcess } from '../src/acp.js'

async function writeExecutable(filePath, contents) {
  await fs.writeFile(filePath, contents, { mode: 0o755 })
}

test('sessionPrompt collects assistant text from session/update chunks', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-acp-'))
  const acpPath = path.join(repoDir, 'fake-kiro-acp-chunks.mjs')

  await writeExecutable(
    acpPath,
    `#!/usr/bin/env node
process.stdin.setEncoding('utf8')
let buffer = ''
function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n')
}
function handle(message) {
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { ok: true } })
    return
  }
  if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'sess-123' } })
    return
  }
  if (message.method === 'session/prompt') {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-123',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '[LINEAR_ACTIVE]' }
        }
      }
    })
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-123',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: ' issue_id=11111111-1111-4111-8111-111111111111' }
        }
      }
    })
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-123',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '\\nhello' }
        }
      }
    })
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
  }
}
process.stdin.on('data', (chunk) => {
  buffer += chunk
  while (true) {
    const idx = buffer.indexOf('\\n')
    if (idx < 0) break
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (!line) continue
    handle(JSON.parse(line))
  }
})
`
  )

  const client = startAcpProcess(acpPath, 'zhuge', {
    cwd: repoDir,
    env: process.env,
  })

  try {
    await client.initialize()
    const sessionId = await client.sessionNew(repoDir)
    const result = await client.sessionPrompt(sessionId, 'hello', 3_000)
    assert.equal(
      result.stdout,
      '[LINEAR_ACTIVE] issue_id=11111111-1111-4111-8111-111111111111\nhello'
    )
    assert.deepEqual(result.raw, { stopReason: 'end_turn' })
  } finally {
    await client.stop().catch(() => {})
  }
})
