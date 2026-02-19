import fs from 'node:fs/promises'
import path from 'node:path'
import { mkdirp, nowIso } from './utils.js'

function parseLockContent(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    return true
  }
}

async function readExistingLock(lockPath) {
  try {
    const raw = await fs.readFile(lockPath, 'utf8')
    return parseLockContent(raw)
  } catch {
    return null
  }
}

export async function acquireLock(lockPath) {
  await mkdirp(path.dirname(lockPath))
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const payload = {
    pid: process.pid,
    token,
    startedAt: nowIso(),
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.writeFile(lockPath, `${JSON.stringify(payload)}\n`, { flag: 'wx' })
      return { lockPath, token }
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error
      }

      const existing = await readExistingLock(lockPath)
      const existingPid = existing?.pid
      if (isProcessAlive(existingPid)) {
        const since = existing?.startedAt ? ` since ${existing.startedAt}` : ''
        throw new Error(`LOCKED: another instance is running (pid=${existingPid}${since}). Lock: ${lockPath}`)
      }

      await fs.unlink(lockPath).catch(() => {})
    }
  }

  throw new Error(`LOCK_FAILED: could not acquire ${lockPath}`)
}

export async function releaseLock(lockHandle) {
  if (!lockHandle?.lockPath || !lockHandle?.token) return

  const current = await readExistingLock(lockHandle.lockPath)
  if (!current || current.token !== lockHandle.token) {
    return
  }

  await fs.unlink(lockHandle.lockPath).catch(() => {})
}
