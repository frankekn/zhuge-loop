import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { normalizeConfig } from '../src/config.js'

test('normalizeConfig resolves repo/runtime paths', () => {
  const config = normalizeConfig(
    {
      repoDir: './repo',
      profileRotation: ['default'],
      profiles: {
        default: {
          phases: [{ id: 'a', command: 'echo ok', timeoutMs: 1000 }],
        },
      },
    },
    '/tmp/example/zhuge.config.json'
  )

  assert.equal(config.repoDir, '/tmp/example/repo')
  assert.equal(config.runtimeDir, '/tmp/example/repo/.zhuge-loop')
  assert.equal(config.statePath, '/tmp/example/repo/.zhuge-loop/state.json')
})

test('normalizeConfig rejects missing profile in rotation', () => {
  assert.throws(() => {
    normalizeConfig(
      {
        profileRotation: ['missing'],
        profiles: {
          default: {
            phases: [{ id: 'x', command: 'echo ok', timeoutMs: 1000 }],
          },
        },
      },
      path.resolve('/tmp/zhuge.config.json')
    )
  }, /missing profile/)
})
