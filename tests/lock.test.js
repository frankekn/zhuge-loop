import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { acquireLock, releaseLock } from '../src/lock.js'

test('acquireLock recovers stale lock', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-lock-test-'))
  const lockPath = path.join(dir, 'zhuge.lock')

  await fs.writeFile(lockPath, JSON.stringify({ pid: 99999999, token: 'stale' }))

  const handle = await acquireLock(lockPath)
  assert.ok(handle.token)

  await releaseLock(handle)
  await fs.access(lockPath).then(
    () => assert.fail('lock file should be removed'),
    () => assert.ok(true)
  )
})

test('acquireLock rejects active lock', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-lock-test-'))
  const lockPath = path.join(dir, 'zhuge.lock')

  await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, token: 'active' }))

  await assert.rejects(() => acquireLock(lockPath), /LOCKED/)
})
