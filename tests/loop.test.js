import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runLoop } from '../src/loop.js'

function buildConfig(repoDir, command, extra = {}) {
  return {
    name: 'test-loop',
    repoDir,
    runtimeDir: path.join(repoDir, '.zhuge-loop'),
    statePath: path.join(repoDir, '.zhuge-loop/state.json'),
    logsDir: path.join(repoDir, '.zhuge-loop/logs'),
    haltLogPath: path.join(repoDir, '.zhuge-loop/HALT.log'),
    lockPath: path.join(repoDir, '.zhuge-loop/loop.lock'),
    sleepMs: 10,
    maxConsecutiveFailures: 3,
    keepRecentTurns: 20,
    profileRotation: ['default'],
    profiles: {
      default: {
        description: 'test profile',
        phases: [
          {
            id: 'phase',
            command,
            timeoutMs: 3000,
            allowFailure: false,
          },
        ],
      },
    },
    ...extra,
  }
}

test('runLoop --once completes one successful turn', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-success-'))
  const config = buildConfig(repoDir, `node -e "console.log('ok')"`)

  const result = await runLoop(config, { once: true })
  assert.equal(result.exitCode, 0)
  assert.equal(result.state.turn, 1)
  assert.equal(result.state.consecutiveFailures, 0)
  assert.equal(result.state.results[0].ok, true)
})

test('runLoop --once returns non-zero when turn fails', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-once-fail-'))
  const config = buildConfig(repoDir, `node -e "process.exit(7)"`)

  const result = await runLoop(config, { once: true })
  assert.equal(result.exitCode, 2)
  assert.equal(result.state.turn, 1)
  assert.equal(result.state.consecutiveFailures, 1)
  assert.equal(result.state.results[0].ok, false)
})

test('runLoop halts when failure fuse is reached', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-fail-'))
  const config = buildConfig(repoDir, `node -e "process.exit(1)"`, {
    maxConsecutiveFailures: 2,
  })

  const result = await runLoop(config, { once: false })
  assert.equal(result.exitCode, 50)
  assert.equal(result.state.turn, 2)
  assert.equal(result.state.consecutiveFailures, 2)

  const haltLog = await fs.readFile(config.haltLogPath, 'utf8')
  assert.match(haltLog, /HALT/)
})
