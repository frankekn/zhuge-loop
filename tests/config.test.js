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
  assert.equal(config.profiles.default.phases[0].run.kind, 'shell')
  assert.equal(config.profiles.default.phases[0].run.command, 'echo ok')
  assert.equal(config.context.commands[0].name, 'git-status')
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

test('normalizeConfig accepts explicit phase.run for shell and kiro', () => {
  const config = normalizeConfig(
    {
      profileRotation: ['default'],
      profiles: {
        default: {
          phases: [
            {
              id: 'shell',
              run: { kind: 'shell', command: 'echo shell' },
              timeoutMs: 1000,
            },
            {
              id: 'kiro',
              run: { kind: 'kiro', agent: 'zhuge', prompt: 'hello' },
              timeoutMs: 1000,
            },
          ],
        },
      },
    },
    path.resolve('/tmp/zhuge.config.json')
  )

  assert.equal(config.profiles.default.phases[0].run.kind, 'shell')
  assert.equal(config.profiles.default.phases[1].run.kind, 'kiro')
  assert.equal(config.profiles.default.phases[1].run.agent, 'zhuge')
  assert.equal(config.kiro.acpCommand, 'kiro-acp')
})

test('normalizeConfig accepts vitestChanged phase kind', () => {
  const config = normalizeConfig(
    {
      profileRotation: ['default'],
      profiles: {
        default: {
          phases: [
            {
              id: 'vitest',
              run: { kind: 'vitestChanged' },
              timeoutMs: 1000,
            },
          ],
        },
      },
    },
    path.resolve('/tmp/zhuge.config.json')
  )

  assert.equal(config.profiles.default.phases[0].run.kind, 'vitestChanged')
})

test('normalizeConfig accepts custom context commands', () => {
  const config = normalizeConfig(
    {
      context: {
        commands: [
          {
            name: 'repo-summary',
            command: 'git status --short',
            timeoutMs: 2000,
            maxLines: 10,
          },
        ],
      },
      profileRotation: ['default'],
      profiles: {
        default: {
          phases: [{ id: 'shell', command: 'echo ok', timeoutMs: 1000 }],
        },
      },
    },
    path.resolve('/tmp/zhuge.config.json')
  )

  assert.deepEqual(config.context.commands, [
    {
      name: 'repo-summary',
      command: 'git status --short',
      timeoutMs: 2000,
      maxLines: 10,
    },
  ])
})

test('normalizeConfig defaults reviewerPolicy to always and accepts risk-based', () => {
  const defaulted = normalizeConfig(
    {
      profileRotation: ['default'],
      profiles: {
        default: {
          phases: [{ id: 'shell', command: 'echo ok', timeoutMs: 1000 }],
        },
      },
    },
    path.resolve('/tmp/zhuge.config.json')
  )
  assert.equal(defaulted.reviewerPolicy, 'always')

  const riskBased = normalizeConfig(
    {
      reviewerPolicy: 'risk-based',
      profileRotation: ['default'],
      profiles: {
        default: {
          phases: [{ id: 'shell', command: 'echo ok', timeoutMs: 1000 }],
        },
      },
    },
    path.resolve('/tmp/zhuge.config.json')
  )
  assert.equal(riskBased.reviewerPolicy, 'risk-based')
})

test('normalizeConfig accepts pipeline as boolean or object', () => {
  const booleanConfig = normalizeConfig(
    {
      pipeline: true,
      profileRotation: ['default'],
      profiles: {
        default: {
          phases: [{ id: 'shell', command: 'echo ok', timeoutMs: 1000 }],
        },
      },
    },
    path.resolve('/tmp/zhuge.config.json')
  )
  assert.equal(booleanConfig.pipeline.enabled, true)

  const objectConfig = normalizeConfig(
    {
      pipeline: { enabled: true },
      profileRotation: ['default'],
      profiles: {
        default: {
          phases: [{ id: 'shell', command: 'echo ok', timeoutMs: 1000 }],
        },
      },
    },
    path.resolve('/tmp/zhuge.config.json')
  )
  assert.equal(objectConfig.pipeline.enabled, true)
})

test('normalizeConfig resolves repo policy and linear integration paths', () => {
  const config = normalizeConfig(
    {
      repoDir: './repo',
      repoPolicy: {
        pushBranch: 'agent-dev',
        autoCommitAfterEachPhase: true,
        autoPushAfterEachPhase: true,
        requireConventionalCommits: true,
        requireIssueKeyRegex: 'AIR-\\d+',
        commitMessageMaxLen: 120,
      },
      integrations: {
        linear: {
          enabled: true,
          cliPath: './tools/linear-cli.sh',
          apiKey: ' linear-token ',
          promptPhaseIds: ['strategist', 'reviewer'],
          maxTasks: 12,
          contextMaxChars: 5000,
        },
      },
      profileRotation: ['default'],
      profiles: {
        default: {
          phases: [{ id: 'shell', command: 'echo ok', timeoutMs: 1000 }],
        },
      },
    },
    '/tmp/example/zhuge.config.json'
  )

  assert.equal(config.repoPolicy.pushBranch, 'agent-dev')
  assert.equal(config.repoPolicy.autoCommitAfterEachPhase, true)
  assert.equal(config.repoPolicy.autoPushAfterEachPhase, true)
  assert.equal(config.integrations.linear.enabled, true)
  assert.equal(config.integrations.linear.cliPath, '/tmp/example/repo/tools/linear-cli.sh')
  assert.equal(config.integrations.linear.apiKey, 'linear-token')
  assert.deepEqual(config.integrations.linear.promptPhaseIds, ['strategist', 'reviewer'])
})

test('normalizeConfig rejects phase with both command and run', () => {
  assert.throws(() => {
    normalizeConfig(
      {
        profileRotation: ['default'],
        profiles: {
          default: {
            phases: [
              {
                id: 'bad',
                command: 'echo ok',
                run: { kind: 'shell', command: 'echo again' },
                timeoutMs: 1000,
              },
            ],
          },
        },
      },
      path.resolve('/tmp/zhuge.config.json')
    )
  }, /both command and run/)
})

test('normalizeConfig rejects invalid kiro phase shape', () => {
  assert.throws(() => {
    normalizeConfig(
      {
        profileRotation: ['default'],
        profiles: {
          default: {
            phases: [
              {
                id: 'kiro',
                run: { kind: 'kiro', prompt: 'missing agent' },
                timeoutMs: 1000,
              },
            ],
          },
        },
      },
      path.resolve('/tmp/zhuge.config.json')
    )
  }, /run.agent/)
})

test('normalizeConfig rejects invalid context command shape', () => {
  assert.throws(() => {
    normalizeConfig(
      {
        context: {
          commands: [
            {
              name: 'bad-context',
              command: '',
            },
          ],
        },
        profileRotation: ['default'],
        profiles: {
          default: {
            phases: [{ id: 'shell', command: 'echo ok', timeoutMs: 1000 }],
          },
        },
      },
      path.resolve('/tmp/zhuge.config.json')
    )
  }, /context\.commands\[0\]\.command/)
})

test('normalizeConfig rejects invalid linear prompt phase ids', () => {
  assert.throws(() => {
    normalizeConfig(
      {
        integrations: {
          linear: {
            enabled: true,
            promptPhaseIds: ['strategist', ''],
          },
        },
        profileRotation: ['default'],
        profiles: {
          default: {
            phases: [{ id: 'shell', command: 'echo ok', timeoutMs: 1000 }],
          },
        },
      },
      path.resolve('/tmp/zhuge.config.json')
    )
  }, /integrations\.linear\.promptPhaseIds\[1\]/)
})

test('normalizeConfig rejects invalid reviewerPolicy', () => {
  assert.throws(() => {
    normalizeConfig(
      {
        reviewerPolicy: 'sometimes',
        profileRotation: ['default'],
        profiles: {
          default: {
            phases: [{ id: 'shell', command: 'echo ok', timeoutMs: 1000 }],
          },
        },
      },
      path.resolve('/tmp/zhuge.config.json')
    )
  }, /reviewerPolicy/)
})

test('normalizeConfig rejects invalid pipeline shape', () => {
  assert.throws(() => {
    normalizeConfig(
      {
        pipeline: { enabled: 'yes' },
        profileRotation: ['default'],
        profiles: {
          default: {
            phases: [{ id: 'shell', command: 'echo ok', timeoutMs: 1000 }],
          },
        },
      },
      path.resolve('/tmp/zhuge.config.json')
    )
  }, /pipeline/)
})
