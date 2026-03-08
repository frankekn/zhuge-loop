import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runLoop } from '../src/loop.js'

function buildLoopConfig(repoDir, phases, extra = {}) {
  const {
    context: extraContext,
    repoPolicy: extraRepoPolicy,
    integrations: extraIntegrations,
    kiro: extraKiro,
    ...rest
  } = extra

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
    context: {
      commands: [],
      ...(extraContext ?? {}),
    },
    repoPolicy: {
      onDirty: 'warn',
      pushBranch: null,
      autoCommitAfterEachPhase: false,
      autoPushAfterEachPhase: false,
      forbidEmoji: false,
      requireConventionalCommits: false,
      commitMessageMaxLen: 96,
      requireIssueKeyRegex: '',
      ...(extraRepoPolicy ?? {}),
    },
    integrations: {
      linear: {
        enabled: false,
        cliPath: './tools/linear-cli.sh',
        promptPhaseIds: ['strategist', 'coordinator'],
        maxTasks: 10,
        contextMaxChars: 4000,
        ...(extraIntegrations?.linear ?? {}),
      },
    },
    kiro: {
      acpCommand: 'kiro-acp',
      cliCommand: 'kiro-cli-chat',
      trustAllTools: true,
      fallbackToCli: true,
      ...(extraKiro ?? {}),
    },
    profileRotation: ['default'],
    profiles: {
      default: {
        description: 'test profile',
        phases,
      },
    },
    ...rest,
  }
}

function buildShellPhase(id, command, extra = {}) {
  return {
    id,
    command,
    timeoutMs: 3000,
    allowFailure: false,
    ...extra,
  }
}

function buildKiroPhase(id, prompt, extra = {}) {
  return {
    id,
    run: {
      kind: 'kiro',
      agent: 'zhuge',
      prompt,
      ...(extra.run ?? {}),
    },
    timeoutMs: 3000,
    allowFailure: false,
    ...extra,
  }
}

async function writeExecutable(filePath, contents) {
  await fs.writeFile(filePath, contents, { mode: 0o755 })
}

async function createFakeKiroScripts(repoDir) {
  const cliPath = path.join(repoDir, 'fake-kiro-cli.mjs')
  const acpSuccessPath = path.join(repoDir, 'fake-kiro-acp-success.mjs')
  const acpFailPath = path.join(repoDir, 'fake-kiro-acp-fail.mjs')

  await writeExecutable(
    cliPath,
    `#!/usr/bin/env node
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', () => {
  console.log(\`CLI fallback output: \${input.trim()}\`)
})
`
  )

  await writeExecutable(
    acpSuccessPath,
    `#!/usr/bin/env node
process.stdin.setEncoding('utf8')
let buffer = ''
function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n')
}
function extractPrompt(message) {
  const prompt = message?.params?.prompt
  if (!Array.isArray(prompt)) return ''
  return prompt
    .map((item) => typeof item?.text === 'string' ? item.text : '')
    .filter(Boolean)
    .join('\\n')
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
      method: '_kiro.dev/metadata',
      params: { sessionId: 'sess-123', contextUsagePercentage: 42.5 }
    })
    send({ jsonrpc: '2.0', id: message.id, result: { text: extractPrompt(message) } })
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

  await writeExecutable(
    acpFailPath,
    `#!/usr/bin/env node
process.exit(1)
`
  )

  return { cliPath, acpSuccessPath, acpFailPath }
}

async function createFakeLinearCli(repoDir, tasks) {
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-linear-fixture-'))
  const cliPath = path.join(fixtureDir, 'linear-cli.mjs')
  const statePath = path.join(fixtureDir, 'linear-state.json')
  const logPath = path.join(fixtureDir, 'linear-log.jsonl')

  await fs.writeFile(statePath, `${JSON.stringify(tasks, null, 2)}\n`)
  await fs.writeFile(logPath, '', 'utf8')
  await writeExecutable(
    cliPath,
    `#!/usr/bin/env node
import fs from 'node:fs'
const statePath = ${JSON.stringify(statePath)}
const logPath = ${JSON.stringify(logPath)}
const [,, command, ...rest] = process.argv
const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'))
const writeState = (tasks) => fs.writeFileSync(statePath, JSON.stringify(tasks, null, 2) + '\\n')
const appendLog = (entry) => fs.appendFileSync(logPath, JSON.stringify(entry) + '\\n')
if (command === 'query-tasks') {
  for (const task of readState()) {
    process.stdout.write(JSON.stringify(task) + '\\n')
  }
  process.exit(0)
}
if (command === 'update-task') {
  const issueId = rest[0]
  const patch = JSON.parse(rest[1] || '{}')
  const tasks = readState().map((task) => task.id === issueId ? { ...task, status: patch.Status || task.status } : task)
  writeState(tasks)
  appendLog({ command, issueId, patch })
  process.exit(0)
}
if (command === 'create-task') {
  const payload = JSON.parse(rest[0] || '{}')
  const tasks = readState()
  const nextId = payload.id || 'created-' + String(tasks.length + 1)
  tasks.push({
    id: nextId,
    identifier: payload.identifier || '',
    title: payload.title || 'untitled',
    status: payload.status || payload.Status || 'Todo',
    priority: payload.priority || 'unset'
  })
  writeState(tasks)
  appendLog({ command, payload })
  process.stdout.write(JSON.stringify({ id: nextId }) + '\\n')
  process.exit(0)
}
appendLog({ command, rest })
process.exit(1)
`
  )

  return { cliPath, statePath, logPath }
}

async function createFakePnpm(logPath) {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-fake-pnpm-'))
  const pnpmPath = path.join(binDir, 'pnpm')
  await writeExecutable(
    pnpmPath,
    `#!/usr/bin/env node
import fs from 'node:fs'
const logPath = ${JSON.stringify(logPath)}
fs.appendFileSync(logPath, process.argv.slice(2).join(' ') + '\\n')
process.exit(0)
`
  )
  return { binDir, pnpmPath }
}

function runLocalCommand(command, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.SHELL || '/bin/bash', ['-lc', command], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(stderr.trim() || stdout.trim() || `exit code ${code}`))
    })
  })
}

async function captureConsoleLogs(fn) {
  const original = console.log
  const lines = []
  console.log = (...args) => {
    lines.push(args.map((arg) => String(arg)).join(' '))
  }

  try {
    const result = await fn()
    return { result, lines }
  } finally {
    console.log = original
  }
}

async function waitFor(check, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5_000
  const intervalMs = options.intervalMs ?? 25
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  throw new Error(`Timed out after ${timeoutMs}ms`)
}

async function initGitRepoWithRemote(repoDir) {
  const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-remote-'))
  await runLocalCommand('git init --bare', remoteDir)
  await runLocalCommand('git init -b main', repoDir)
  await runLocalCommand('git config user.name "Zhuge Loop Test"', repoDir)
  await runLocalCommand('git config user.email "zhuge-loop@example.com"', repoDir)
  await fs.writeFile(path.join(repoDir, 'README.md'), '# test repo\n')
  await runLocalCommand('git add README.md', repoDir)
  await runLocalCommand('git commit -m "chore: initial commit"', repoDir)
  await runLocalCommand(`git remote add origin ${JSON.stringify(remoteDir)}`, repoDir)
  await runLocalCommand('git push -u origin main', repoDir)
  return { remoteDir }
}

async function getOnlyTurnDir(logsDir) {
  const [turnDirName] = await fs.readdir(logsDir)
  return path.join(logsDir, turnDirName)
}

async function getTurnDirs(logsDir) {
  const entries = await fs.readdir(logsDir)
  return entries
    .filter((entry) => entry.startsWith('turn-'))
    .sort()
    .map((entry) => path.join(logsDir, entry))
}

test('runLoop --once completes one successful turn', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-success-'))
  const config = buildLoopConfig(repoDir, [buildShellPhase('phase', `node -e "console.log('ok')"`)])

  const result = await runLoop(config, { once: true })
  assert.equal(result.exitCode, 0)
  assert.equal(result.state.turn, 1)
  assert.equal(result.state.consecutiveFailures, 0)
  assert.equal(result.state.results[0].ok, true)
})

test('runLoop --once returns non-zero when turn fails', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-once-fail-'))
  const config = buildLoopConfig(repoDir, [buildShellPhase('phase', `node -e "process.exit(7)"`)])

  const result = await runLoop(config, { once: true })
  assert.equal(result.exitCode, 2)
  assert.equal(result.state.turn, 1)
  assert.equal(result.state.consecutiveFailures, 1)
  assert.equal(result.state.results[0].ok, false)
})

test('runLoop halts when failure fuse is reached', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-fail-'))
  const config = buildLoopConfig(
    repoDir,
    [buildShellPhase('phase', `node -e "process.exit(1)"`)],
    { maxConsecutiveFailures: 2 }
  )

  const result = await runLoop(config, { once: false })
  assert.equal(result.exitCode, 50)
  assert.equal(result.state.turn, 2)
  assert.equal(result.state.consecutiveFailures, 2)

  const haltLog = await fs.readFile(config.haltLogPath, 'utf8')
  assert.match(haltLog, /HALT/)
})

test('runLoop executes kiro phase via ACP and writes metadata artifact', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-kiro-acp-'))
  const { cliPath, acpSuccessPath } = await createFakeKiroScripts(repoDir)
  const config = buildLoopConfig(
    repoDir,
    [buildKiroPhase('plan', 'test prompt')],
    {
      kiro: {
        acpCommand: acpSuccessPath,
        cliCommand: cliPath,
      },
    }
  )

  const result = await runLoop(config, { once: true })
  assert.equal(result.exitCode, 0)
  assert.equal(result.state.results[0].phases[0].kind, 'kiro')
  assert.equal(result.state.results[0].phases[0].adapterUsed, 'acp')
  assert.equal(result.state.results[0].phases[0].fallbackUsed, false)

  const turnDir = await getOnlyTurnDir(config.logsDir)
  const meta = JSON.parse(await fs.readFile(path.join(turnDir, '01-plan.meta.json'), 'utf8'))
  assert.equal(meta.adapterUsed, 'acp')
  assert.equal(meta.sessionId, 'sess-123')
  assert.equal(meta.contextUsagePercentage, 42.5)
})

test('runLoop falls back to kiro CLI when ACP fails', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-kiro-fallback-'))
  const { cliPath, acpFailPath } = await createFakeKiroScripts(repoDir)
  const config = buildLoopConfig(
    repoDir,
    [buildKiroPhase('plan', 'fallback prompt')],
    {
      kiro: {
        acpCommand: acpFailPath,
        cliCommand: cliPath,
      },
    }
  )

  const result = await runLoop(config, { once: true })
  assert.equal(result.exitCode, 0)
  assert.equal(result.state.results[0].phases[0].adapterUsed, 'cli')
  assert.equal(result.state.results[0].phases[0].fallbackUsed, true)

  const turnDir = await getOnlyTurnDir(config.logsDir)
  const stdout = await fs.readFile(path.join(turnDir, '01-plan.stdout.log'), 'utf8')
  const meta = JSON.parse(await fs.readFile(path.join(turnDir, '01-plan.meta.json'), 'utf8'))

  assert.match(stdout, /CLI fallback output: fallback prompt/)
  assert.equal(meta.adapterUsed, 'cli')
  assert.equal(meta.fallbackUsed, true)
})

test('runLoop injects repo context and handoff into later kiro phases', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-context-'))
  const { cliPath, acpSuccessPath } = await createFakeKiroScripts(repoDir)
  const config = buildLoopConfig(
    repoDir,
    [
      buildShellPhase('prepare', `printf '[HANDOFF] carry this forward'`),
      buildKiroPhase('review', 'second phase prompt'),
    ],
    {
      context: {
        commands: [
          {
            name: 'repo-summary',
            command: `printf 'repo context line\\n'`,
            timeoutMs: 1000,
            maxLines: 10,
          },
        ],
      },
      kiro: {
        acpCommand: acpSuccessPath,
        cliCommand: cliPath,
      },
    }
  )

  const result = await runLoop(config, { once: true })
  assert.equal(result.exitCode, 0)

  const turnDir = await getOnlyTurnDir(config.logsDir)
  const repoContext = await fs.readFile(path.join(turnDir, 'repo-context.txt'), 'utf8')
  const handoff = await fs.readFile(path.join(turnDir, '02-review.handoff.txt'), 'utf8')
  const prompt = await fs.readFile(path.join(turnDir, '02-review.prompt.txt'), 'utf8')
  const meta = JSON.parse(await fs.readFile(path.join(turnDir, '02-review.meta.json'), 'utf8'))

  assert.match(repoContext, /repo-summary/)
  assert.match(repoContext, /repo context line/)
  assert.equal(handoff, 'carry this forward')
  assert.match(prompt, /--- REPO CONTEXT ---/)
  assert.match(prompt, /repo context line/)
  assert.match(prompt, /--- HANDOFF FROM PREVIOUS PHASE ---/)
  assert.match(prompt, /carry this forward/)
  assert.equal(meta.repoContextIncluded, true)
  assert.equal(meta.handoffIncluded, true)
})

test('runLoop injects linear context into configured kiro phases', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-linear-context-'))
  const { cliPath, acpSuccessPath } = await createFakeKiroScripts(repoDir)
  const issueId = '11111111-1111-4111-8111-111111111111'
  const { cliPath: linearCliPath } = await createFakeLinearCli(repoDir, [
    {
      id: issueId,
      identifier: 'AIR-580',
      title: 'Fix dashboard overlap',
      status: 'Todo',
      priority: 'P1',
    },
  ])

  const previousApiKey = process.env.LINEAR_API_KEY
  process.env.LINEAR_API_KEY = 'test-linear-key'

  try {
    const config = buildLoopConfig(
      repoDir,
      [buildKiroPhase('strategist', 'Choose the next slice')],
      {
        kiro: {
          acpCommand: acpSuccessPath,
          cliCommand: cliPath,
        },
        integrations: {
          linear: {
            enabled: true,
            cliPath: linearCliPath,
            promptPhaseIds: ['strategist'],
          },
        },
      }
    )

    const result = await runLoop(config, { once: true })
    assert.equal(result.exitCode, 0)

    const turnDir = await getOnlyTurnDir(config.logsDir)
    const linearContext = await fs.readFile(path.join(turnDir, 'linear-context.txt'), 'utf8')
    const prompt = await fs.readFile(path.join(turnDir, '01-strategist.prompt.txt'), 'utf8')
    const meta = JSON.parse(await fs.readFile(path.join(turnDir, '01-strategist.meta.json'), 'utf8'))

    assert.match(linearContext, /AIR-580/)
    assert.match(prompt, /--- LINEAR TASKS/)
    assert.match(prompt, /Fix dashboard overlap/)
    assert.equal(meta.linearContextIncluded, true)
  } finally {
    if (previousApiKey == null) delete process.env.LINEAR_API_KEY
    else process.env.LINEAR_API_KEY = previousApiKey
  }
})

test('runLoop exposes repo context and handoff env vars to shell phases', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-shell-env-'))
  const config = buildLoopConfig(
    repoDir,
    [
      buildShellPhase('prepare', `printf '[HANDOFF] shell handoff'`),
      buildShellPhase(
        'inspect',
        `node -e "console.log(JSON.stringify({repoContext: process.env.ZHUGE_REPO_CONTEXT, handoff: process.env.ZHUGE_HANDOFF, repoContextPath: process.env.ZHUGE_REPO_CONTEXT_PATH, handoffPath: process.env.ZHUGE_HANDOFF_PATH}))"`
      ),
    ],
    {
      context: {
        commands: [
          {
            name: 'repo-summary',
            command: `printf 'context from shell env\\n'`,
            timeoutMs: 1000,
            maxLines: 10,
          },
        ],
      },
    }
  )

  const result = await runLoop(config, { once: true })
  assert.equal(result.exitCode, 0)

  const turnDir = await getOnlyTurnDir(config.logsDir)
  const inspectOutput = await fs.readFile(path.join(turnDir, '02-inspect.stdout.log'), 'utf8')
  const parsed = JSON.parse(inspectOutput.trim())
  assert.match(parsed.repoContext, /context from shell env/)
  assert.equal(parsed.handoff, 'shell handoff')
  assert.equal(parsed.repoContextPath, path.join(turnDir, 'repo-context.txt'))
  assert.equal(parsed.handoffPath, path.join(turnDir, '02-inspect.handoff.txt'))
})

test('runLoop skips reviewer phase when reviewerPolicy is skip', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-reviewer-skip-'))
  const config = buildLoopConfig(
    repoDir,
    [
      buildShellPhase(
        'executor',
        `node -e "const fs=require('fs'); fs.writeFileSync('feature.txt','executor\\n')"`
      ),
      buildShellPhase(
        'reviewer',
        `node -e "const fs=require('fs'); fs.appendFileSync('feature.txt','reviewer\\n'); process.exit(9)"`
      ),
    ],
    {
      reviewerPolicy: 'skip',
    }
  )

  const { result, lines } = await captureConsoleLogs(() => runLoop(config, { once: true }))
  assert.equal(result.exitCode, 0)
  assert.equal(result.state.results[0].phases[1].skipped, true)
  assert.equal(result.state.results[0].phases[1].skipReason, 'skip')
  assert.match(lines.join('\n'), /\[Turn 0\] Skipping reviewer \(policy: skip\)/)

  const turnDir = await getOnlyTurnDir(config.logsDir)
  const stdout = await fs.readFile(path.join(turnDir, '02-reviewer.stdout.log'), 'utf8')
  const resultMd = await fs.readFile(path.join(turnDir, 'result.md'), 'utf8')
  const feature = await fs.readFile(path.join(repoDir, 'feature.txt'), 'utf8')
  assert.equal(stdout, '')
  assert.match(resultMd, /skipped=skip/)
  assert.equal(feature, 'executor\n')
})

test('runLoop preserves reviewer phase when reviewerPolicy is always', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-reviewer-always-'))
  const config = buildLoopConfig(
    repoDir,
    [
      buildShellPhase(
        'executor',
        `node -e "const fs=require('fs'); fs.writeFileSync('feature.txt','executor\\n')"`
      ),
      buildShellPhase(
        'reviewer',
        `node -e "const fs=require('fs'); fs.appendFileSync('feature.txt','reviewer\\n')"`
      ),
    ],
    {
      reviewerPolicy: 'always',
    }
  )

  const result = await runLoop(config, { once: true })
  assert.equal(result.exitCode, 0)
  assert.equal(result.state.results[0].phases[1].skipped, undefined)

  const feature = await fs.readFile(path.join(repoDir, 'feature.txt'), 'utf8')
  assert.equal(feature, 'executor\nreviewer\n')
})

test('runLoop skips reviewer in risk-based mode for style-only executor changes', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-reviewer-risk-'))
  await initGitRepoWithRemote(repoDir)
  const config = buildLoopConfig(
    repoDir,
    [
      buildShellPhase(
        'executor',
        `node -e "const fs=require('fs'); fs.mkdirSync('src',{recursive:true}); fs.writeFileSync('src/app.css','body{}\\n')"`
      ),
      buildShellPhase(
        'reviewer',
        `node -e "process.exit(5)"`
      ),
    ],
    {
      reviewerPolicy: 'risk-based',
    }
  )

  const { result, lines } = await captureConsoleLogs(() => runLoop(config, { once: true }))
  assert.equal(result.exitCode, 0)
  assert.equal(result.state.results[0].phases[1].skipped, true)
  assert.equal(result.state.results[0].phases[1].skipReason, 'risk-based')
  assert.match(lines.join('\n'), /\[Turn 0\] Skipping reviewer \(policy: risk-based\)/)
})

test('runLoop reuses prefetched strategist on the next turn when pipeline is enabled', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-pipeline-prefetch-'))
  const strategistEventsPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-pipeline-events-')),
    'strategist-events.log'
  )
  const config = buildLoopConfig(
    repoDir,
    [
      buildShellPhase(
        'strategist',
        `STRATEGIST_EVENTS=${JSON.stringify(strategistEventsPath)} node -e "const fs=require('fs'); fs.appendFileSync(process.env.STRATEGIST_EVENTS, process.env.ZHUGE_TURN + '\\n'); console.log('[HANDOFF] prefetched-turn-' + process.env.ZHUGE_TURN)"`
      ),
      buildShellPhase(
        'executor',
        `node -e "console.log('executor handoff=' + process.env.ZHUGE_HANDOFF)"`
      ),
      buildShellPhase(
        'reviewer',
        `node -e "if (process.env.ZHUGE_TURN==='1') process.exit(1); console.log('review ok')"`
      ),
    ],
    {
      pipeline: true,
      maxConsecutiveFailures: 1,
      sleepMs: 100,
    }
  )

  const result = await runLoop(config, { once: false })
  assert.equal(result.exitCode, 50)
  assert.equal(result.state.turn, 2)
  assert.equal(result.state.results[1].phases[0].prefetched, true)

  const turnDirs = await getTurnDirs(config.logsDir)
  const secondTurnDir = turnDirs[1]
  const secondTurnContext = JSON.parse(await fs.readFile(path.join(secondTurnDir, 'context.json'), 'utf8'))
  const secondTurnStrategistOut = await fs.readFile(path.join(secondTurnDir, '01-strategist.stdout.log'), 'utf8')
  const secondTurnExecutorOut = await fs.readFile(path.join(secondTurnDir, '02-executor.stdout.log'), 'utf8')
  const strategistEvents = (await fs.readFile(strategistEventsPath, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)

  assert.equal(secondTurnContext.prefetchedStrategistUsed, true)
  assert.match(secondTurnStrategistOut, /prefetched-turn-1/)
  assert.match(secondTurnExecutorOut, /executor handoff=prefetched-turn-1/)
  assert.deepEqual(strategistEvents, ['0', '1'])
})

test('runLoop discards stale strategist prefetch when the worktree changes', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-pipeline-stale-'))
  await initGitRepoWithRemote(repoDir)
  const strategistEventsPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-pipeline-stale-events-')),
    'strategist-events.log'
  )
  const config = buildLoopConfig(
    repoDir,
    [
      buildShellPhase(
        'strategist',
        `STRATEGIST_EVENTS=${JSON.stringify(strategistEventsPath)} node -e "const fs=require('fs'); fs.appendFileSync(process.env.STRATEGIST_EVENTS, process.env.ZHUGE_TURN + '\\n'); console.log('[HANDOFF] stale-turn-' + process.env.ZHUGE_TURN)"`
      ),
      buildShellPhase(
        'executor',
        `node -e "console.log('executor handoff=' + process.env.ZHUGE_HANDOFF)"`
      ),
      buildShellPhase(
        'reviewer',
        `node -e "if (process.env.ZHUGE_TURN==='1') process.exit(1); console.log('review ok')"`
      ),
    ],
    {
      pipeline: { enabled: true },
      maxConsecutiveFailures: 1,
      sleepMs: 250,
    }
  )

  const { result, lines } = await captureConsoleLogs(async () => {
    const loopPromise = runLoop(config, { once: false })

    await waitFor(async () => {
      const raw = await fs.readFile(strategistEventsPath, 'utf8').catch(() => '')
      const strategistRuns = raw
        .trim()
        .split('\n')
        .filter(Boolean).length
      const lockPresent = await fs.access(config.lockPath).then(() => true).catch(() => false)
      return strategistRuns >= 2 && lockPresent
    })

    await fs.writeFile(path.join(repoDir, 'stale-change.js'), 'console.log("changed")\n')
    await runLocalCommand('git add stale-change.js && git commit -m "chore: stale snapshot"', repoDir)
    return loopPromise
  })

  assert.equal(result.exitCode, 50)
  assert.equal(result.state.turn, 2)
  assert.equal(result.state.results[1].phases[0].prefetched, false)
  assert.match(lines.join('\n'), /\[Turn 1\] Discarding stale strategist prefetch/)

  const turnDirs = await getTurnDirs(config.logsDir)
  const secondTurnContext = JSON.parse(await fs.readFile(path.join(turnDirs[1], 'context.json'), 'utf8'))
  const strategistEvents = (await fs.readFile(strategistEventsPath, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)

  assert.equal(secondTurnContext.prefetchedStrategistUsed, false)
  assert.deepEqual(strategistEvents, ['0', '1', '1'])
})

test('runLoop processes linear markers and auto-commits/pushes to delivery branch', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-git-linear-'))
  const issueId = '22222222-2222-4222-8222-222222222222'
  const { remoteDir } = await initGitRepoWithRemote(repoDir)
  const { cliPath: linearCliPath, logPath } = await createFakeLinearCli(repoDir, [
    {
      id: issueId,
      identifier: 'AIR-580',
      title: 'Fix dashboard overlap',
      status: 'Todo',
      priority: 'P1',
    },
  ])

  const previousApiKey = process.env.LINEAR_API_KEY
  process.env.LINEAR_API_KEY = 'test-linear-key'

  try {
    const config = buildLoopConfig(
      repoDir,
      [
        buildShellPhase(
          'executor',
          `node -e "const fs=require('fs'); fs.writeFileSync('feature.txt','executor\\n'); console.log('[LINEAR_ACTIVE] issue_id=${issueId}')"`
        ),
        buildShellPhase(
          'reviewer',
          `node -e "const fs=require('fs'); fs.appendFileSync('feature.txt','reviewer\\n'); console.log('[LINEAR_DONE] issue_id=${issueId}')"`
        ),
      ],
      {
        repoPolicy: {
          pushBranch: 'agent-dev',
          onDirty: 'warn',
          autoCommitAfterEachPhase: true,
          autoPushAfterEachPhase: true,
          requireConventionalCommits: true,
          commitMessageMaxLen: 100,
          requireIssueKeyRegex: 'AIR-\\d+',
        },
        integrations: {
          linear: {
            enabled: true,
            cliPath: linearCliPath,
            promptPhaseIds: ['strategist'],
          },
        },
      }
    )

    const result = await runLoop(config, { once: true })
    assert.equal(result.exitCode, 0)

    const branch = await runLocalCommand('git rev-parse --abbrev-ref HEAD', repoDir)
    const headSubject = await runLocalCommand('git log -1 --pretty=%s', repoDir)
    const remoteBranch = await runLocalCommand(`git --git-dir=${JSON.stringify(remoteDir)} show-ref --verify refs/heads/agent-dev`, repoDir)
    const linearLog = (await fs.readFile(logPath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))

    assert.equal(branch, 'agent-dev')
    assert.match(headSubject, /^AIR-580: sync turn changes$/)
    assert.match(remoteBranch, /refs\/heads\/agent-dev/)
    assert.deepEqual(
      linearLog.map((entry) => entry.patch?.Status ?? entry.command),
      ['Executing', 'Done']
    )
    assert.equal(result.state.results[0].deliverySummary.subject, 'AIR-580: sync turn changes')
    assert.equal(result.state.results[0].deliverySummary.branch, 'agent-dev')
  } finally {
    if (previousApiKey == null) delete process.env.LINEAR_API_KEY
    else process.env.LINEAR_API_KEY = previousApiKey
  }
})

test('runLoop carries activeTask across later phases without new linear markers', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-active-task-carry-'))
  const issueId = '33333333-3333-4333-8333-333333333333'
  await initGitRepoWithRemote(repoDir)
  const { cliPath: linearCliPath } = await createFakeLinearCli(repoDir, [
    {
      id: issueId,
      identifier: 'AIR-581',
      title: 'Carry active task across executor and reviewer',
      status: 'Todo',
      priority: 'P1',
    },
  ])

  const previousApiKey = process.env.LINEAR_API_KEY
  process.env.LINEAR_API_KEY = 'test-linear-key'

  try {
    const config = buildLoopConfig(
      repoDir,
      [
        buildShellPhase(
          'strategist',
          `node -e "console.log('[LINEAR_ACTIVE] issue_id=${issueId}')"`
        ),
        buildShellPhase(
          'executor',
          `node -e "const fs=require('fs'); fs.writeFileSync('feature.txt','executor\\n')"`
        ),
        buildShellPhase(
          'reviewer',
          `node -e "const fs=require('fs'); fs.appendFileSync('feature.txt','reviewer\\n')"`
        ),
      ],
      {
        repoPolicy: {
          onDirty: 'warn',
          autoCommitAfterEachPhase: true,
          autoPushAfterEachPhase: false,
          requireConventionalCommits: true,
          commitMessageMaxLen: 100,
          requireIssueKeyRegex: 'AIR-\\d+',
        },
        integrations: {
          linear: {
            enabled: true,
            cliPath: linearCliPath,
            promptPhaseIds: ['strategist'],
          },
        },
      }
    )

    const result = await runLoop(config, { once: true })
    assert.equal(result.exitCode, 0)

    const headSubject = await runLocalCommand('git log -1 --pretty=%s', repoDir)
    assert.equal(result.state.results[0].deliverySummary.subject, 'AIR-581: sync turn changes')
    assert.equal(headSubject, 'AIR-581: sync turn changes')
  } finally {
    if (previousApiKey == null) delete process.env.LINEAR_API_KEY
    else process.env.LINEAR_API_KEY = previousApiKey
  }
})

test('runLoop seeds activeTask from executing linear tasks at turn start', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-active-task-seed-'))
  const issueId = '44444444-4444-4444-8444-444444444444'
  await initGitRepoWithRemote(repoDir)
  const { cliPath: linearCliPath } = await createFakeLinearCli(repoDir, [
    {
      id: issueId,
      identifier: 'AIR-737',
      title: 'Seed active task at turn start',
      status: 'Executing',
      priority: 'P1',
    },
  ])

  const previousApiKey = process.env.LINEAR_API_KEY
  process.env.LINEAR_API_KEY = 'test-linear-key'

  try {
    const config = buildLoopConfig(
      repoDir,
      [
        buildShellPhase(
          'strategist',
          `node -e "console.log('no marker from strategist')"`
        ),
        buildShellPhase(
          'executor',
          `node -e "const fs=require('fs'); fs.writeFileSync('feature.txt','executor\\n')"`
        ),
        buildShellPhase(
          'reviewer',
          `node -e "const fs=require('fs'); fs.appendFileSync('feature.txt','reviewer\\n'); console.log('[LINEAR_ACTIVE] issue_id=${issueId}')"`
        ),
      ],
      {
        repoPolicy: {
          onDirty: 'warn',
          autoCommitAfterEachPhase: true,
          autoPushAfterEachPhase: false,
          requireConventionalCommits: true,
          commitMessageMaxLen: 100,
          requireIssueKeyRegex: 'AIR-\\d+',
        },
        integrations: {
          linear: {
            enabled: true,
            cliPath: linearCliPath,
            promptPhaseIds: ['strategist'],
          },
        },
      }
    )

    const result = await runLoop(config, { once: true })
    assert.equal(result.exitCode, 0)

    const headSubject = await runLocalCommand('git log -1 --pretty=%s', repoDir)
    assert.equal(result.state.results[0].deliverySummary.subject, 'AIR-737: sync turn changes')
    assert.equal(headSubject, 'AIR-737: sync turn changes')
  } finally {
    if (previousApiKey == null) delete process.env.LINEAR_API_KEY
    else process.env.LINEAR_API_KEY = previousApiKey
  }
})

test('runLoop resolves activeTask identifier for done issues missing from queryLinearTasks', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-done-active-task-'))
  const issueId = '66666666-6666-4666-8666-666666666666'
  await initGitRepoWithRemote(repoDir)
  const { cliPath: linearCliPath } = await createFakeLinearCli(repoDir, [
    {
      id: '77777777-7777-4777-8777-777777777777',
      identifier: 'AIR-100',
      title: 'Unrelated open task',
      status: 'Todo',
      priority: 'P2',
    },
  ])

  const previousApiKey = process.env.LINEAR_API_KEY
  const previousFetch = globalThis.fetch
  let fetchCount = 0
  process.env.LINEAR_API_KEY = 'test-linear-key'
  globalThis.fetch = async (url, init = {}) => {
    fetchCount += 1
    assert.equal(url, 'https://api.linear.app/graphql')
    assert.equal(init.method, 'POST')
    assert.equal(init.headers?.Authorization, 'test-linear-key')

    const payload = JSON.parse(String(init.body ?? '{}'))
    assert.equal(payload.variables?.id, issueId)

    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          issue: {
            id: issueId,
            identifier: 'AIR-990',
            title: 'Done issue missing from query-tasks results',
            priority: 1,
            state: { name: 'Done' },
          },
        },
      }),
    }
  }

  try {
    const config = buildLoopConfig(
      repoDir,
      [
        buildShellPhase(
          'strategist',
          `node -e "const fs=require('fs'); fs.writeFileSync('feature.txt','strategist\\n'); console.log('[LINEAR_ACTIVE] issue_id=${issueId}'); console.log('[LINEAR_DONE] issue_id=${issueId}')"`
        ),
      ],
      {
        repoPolicy: {
          onDirty: 'warn',
          autoCommitAfterEachPhase: true,
          autoPushAfterEachPhase: false,
          requireConventionalCommits: true,
          commitMessageMaxLen: 100,
          requireIssueKeyRegex: 'AIR-\\d+',
        },
        integrations: {
          linear: {
            enabled: true,
            cliPath: linearCliPath,
            promptPhaseIds: ['strategist'],
          },
        },
      }
    )

    const result = await runLoop(config, { once: true })
    assert.equal(result.exitCode, 0)
    assert.equal(result.state.results[0].deliverySummary.subject, 'AIR-990: sync turn changes')
    assert.equal(fetchCount, 1)

    const headSubject = await runLocalCommand('git log -1 --pretty=%s', repoDir)
    assert.equal(headSubject, 'AIR-990: sync turn changes')
  } finally {
    if (previousApiKey == null) delete process.env.LINEAR_API_KEY
    else process.env.LINEAR_API_KEY = previousApiKey
    globalThis.fetch = previousFetch
  }
})

test('resolveActiveTask extracts identifier from title when linearTasks has no match', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-title-id-'))
  await initGitRepoWithRemote(repoDir)
  // Create a fake Linear CLI with tasks that do NOT match the title in the marker
  const { cliPath: linearCliPath } = await createFakeLinearCli(repoDir, [
    {
      id: '55555555-5555-5555-8555-555555555555',
      identifier: 'AIR-100',
      title: 'Unrelated task',
      status: 'Todo',
      priority: 'P2',
    },
  ])

  const previousApiKey = process.env.LINEAR_API_KEY
  process.env.LINEAR_API_KEY = 'test-linear-key'

  try {
    const config = buildLoopConfig(
      repoDir,
      [
        // Strategist outputs a title-based marker with an issue key embedded
        // but linearTasks won't have a matching title → fallback path
        buildShellPhase(
          'strategist',
          `node -e "console.log('[LINEAR_ACTIVE] title=AIR-769: Dashboard top-bar redesign')"`
        ),
        buildShellPhase(
          'executor',
          `node -e "const fs=require('fs'); fs.writeFileSync('dashboard.txt','work\\n')"`
        ),
      ],
      {
        repoPolicy: {
          onDirty: 'warn',
          autoCommitAfterEachPhase: true,
          autoPushAfterEachPhase: false,
          requireConventionalCommits: true,
          commitMessageMaxLen: 100,
          requireIssueKeyRegex: 'AIR-\\d+',
        },
        integrations: {
          linear: {
            enabled: true,
            cliPath: linearCliPath,
            promptPhaseIds: ['strategist'],
          },
        },
      }
    )

    const result = await runLoop(config, { once: true })
    assert.equal(result.exitCode, 0)

    assert.equal(result.state.results[0].deliverySummary.subject, 'AIR-769: sync turn changes')
  } finally {
    if (previousApiKey == null) delete process.env.LINEAR_API_KEY
    else process.env.LINEAR_API_KEY = previousApiKey
  }
})

test('runLoop binds same-phase LINEAR_NEW_TASK and LINEAR_ACTIVE title markers', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-new-task-bind-'))
  const { cliPath: linearCliPath, logPath, statePath } = await createFakeLinearCli(repoDir, [])

  const previousApiKey = process.env.LINEAR_API_KEY
  process.env.LINEAR_API_KEY = 'test-linear-key'

  try {
    const config = buildLoopConfig(
      repoDir,
      [
        buildShellPhase(
          'strategist',
          `node -e "console.log('[LINEAR_NEW_TASK] ' + JSON.stringify({title:'Fresh task', status:'Todo'})); console.log('[LINEAR_ACTIVE] title=Fresh task')"`
        ),
      ],
      {
        integrations: {
          linear: {
            enabled: true,
            cliPath: linearCliPath,
            promptPhaseIds: ['strategist'],
          },
        },
      }
    )

    const result = await runLoop(config, { once: true })
    assert.equal(result.exitCode, 0)
    assert.equal(result.state.results[0].canonicalActiveTask.title, 'Fresh task')

    const linearLog = (await fs.readFile(logPath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    const linearState = JSON.parse(await fs.readFile(statePath, 'utf8'))

    assert.equal(linearLog[0].command, 'create-task')
    assert.equal(linearLog[1].command, 'update-task')
    assert.equal(linearLog[1].issueId, 'created-1')
    assert.equal(linearLog[1].patch.Status, 'Coordinating')
    assert.equal(linearState[0].status, 'Coordinating')
  } finally {
    if (previousApiKey == null) delete process.env.LINEAR_API_KEY
    else process.env.LINEAR_API_KEY = previousApiKey
  }
})

test('runLoop defers LINEAR_DONE until delivery succeeds', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-done-deferred-'))
  const issueId = '88888888-8888-4888-8888-888888888888'
  await initGitRepoWithRemote(repoDir)
  const { cliPath: linearCliPath, logPath } = await createFakeLinearCli(repoDir, [
    {
      id: issueId,
      identifier: 'AIR-888',
      title: 'Defer done until delivery',
      status: 'Todo',
      priority: 'P1',
    },
  ])

  const previousApiKey = process.env.LINEAR_API_KEY
  process.env.LINEAR_API_KEY = 'test-linear-key'

  try {
    const config = buildLoopConfig(
      repoDir,
      [
        buildShellPhase(
          'executor',
          `node -e "const fs=require('fs'); fs.writeFileSync('feature.txt',process.env.ZHUGE_TURN + '\\n'); console.log('[LINEAR_ACTIVE] issue_id=${issueId}')"`
        ),
        buildShellPhase(
          'reviewer',
          `node -e "console.log('[LINEAR_DONE] issue_id=${issueId}')"`
        ),
        buildShellPhase(
          'build',
          `node -e "process.exit(7)"`
        ),
      ],
      {
        repoPolicy: {
          onDirty: 'warn',
          autoCommitAfterEachPhase: true,
          autoPushAfterEachPhase: false,
          requireConventionalCommits: true,
          commitMessageMaxLen: 100,
          requireIssueKeyRegex: 'AIR-\\d+',
        },
        integrations: {
          linear: {
            enabled: true,
            cliPath: linearCliPath,
            promptPhaseIds: ['executor', 'reviewer'],
          },
        },
      }
    )

    const result = await runLoop(config, { once: true })
    assert.equal(result.exitCode, 2)

    const linearLog = (await fs.readFile(logPath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))

    assert.deepEqual(linearLog.map((entry) => entry.patch?.Status ?? entry.command), ['Executing'])
    const headSubject = await runLocalCommand('git log -1 --pretty=%s', repoDir)
    assert.equal(headSubject, 'AIR-888: sync recovery changes')
    assert.equal(result.state.results[0].deliverySummary.checkpointCommitted, true)
  } finally {
    if (previousApiKey == null) delete process.env.LINEAR_API_KEY
    else process.env.LINEAR_API_KEY = previousApiKey
  }
})

test('runLoop fails immediately when the turn starts with a dirty worktree', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-dirty-start-'))
  await initGitRepoWithRemote(repoDir)
  await fs.writeFile(path.join(repoDir, 'dirty.txt'), 'pending\n')

  const config = buildLoopConfig(
    repoDir,
    [buildShellPhase('executor', `node -e "process.exit(9)"`)]
  )

  const result = await runLoop(config, { once: true })
  assert.equal(result.exitCode, 2)
  assert.equal(result.state.results[0].errorSummary, 'Working tree dirty at turn start')
  assert.deepEqual(result.state.results[0].phases, [])
})

test('runLoop resolves and runs vitestChanged targets from changed source files', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-vitest-changed-'))
  await initGitRepoWithRemote(repoDir)
  const pnpmLogPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-pnpm-log-')), 'pnpm.log')
  const { binDir } = await createFakePnpm(pnpmLogPath)
  const previousPath = process.env.PATH
  process.env.PATH = `${binDir}:${previousPath ?? ''}`

  try {
    const config = buildLoopConfig(
      repoDir,
      [
        buildShellPhase(
          'executor',
          `node -e "const fs=require('fs'); fs.mkdirSync('src',{recursive:true}); fs.writeFileSync('src/feature.ts','export const feature = 1\\n'); fs.writeFileSync('src/feature.test.ts','import { test } from \\'node:test\\'\\n')"`
        ),
        {
          id: 'vitest',
          run: { kind: 'vitestChanged' },
          timeoutMs: 3000,
          allowFailure: false,
        },
      ]
    )

    const result = await runLoop(config, { once: true })
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.state.results[0].phases[1].resolvedTests, ['src/feature.test.ts'])

    const pnpmLog = await fs.readFile(pnpmLogPath, 'utf8')
    assert.match(pnpmLog, /test --run src\/feature\.test\.ts/)
  } finally {
    process.env.PATH = previousPath
  }
})

test('runLoop resolves mirrored tests/*.test.* files for vitestChanged', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-vitest-mirrored-'))
  await initGitRepoWithRemote(repoDir)
  const pnpmLogPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-pnpm-log-')), 'pnpm.log')
  const { binDir } = await createFakePnpm(pnpmLogPath)
  const previousPath = process.env.PATH
  process.env.PATH = `${binDir}:${previousPath ?? ''}`

  try {
    const config = buildLoopConfig(
      repoDir,
      [
        buildShellPhase(
          'executor',
          `node -e "const fs=require('fs'); fs.mkdirSync('src',{recursive:true}); fs.mkdirSync('tests',{recursive:true}); fs.writeFileSync('src/feature.ts','export const feature = 1\\n'); fs.writeFileSync('tests/feature.test.ts','import { test } from \\'node:test\\'\\n')"`
        ),
        {
          id: 'vitest',
          run: { kind: 'vitestChanged' },
          timeoutMs: 3000,
          allowFailure: false,
        },
      ]
    )

    const result = await runLoop(config, { once: true })
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.state.results[0].phases[1].resolvedTests, ['tests/feature.test.ts'])

    const pnpmLog = await fs.readFile(pnpmLogPath, 'utf8')
    assert.match(pnpmLog, /test --run tests\/feature\.test\.ts/)
  } finally {
    process.env.PATH = previousPath
  }
})

test('runLoop fails vitestChanged when no tests resolve for changed files', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-vitest-empty-'))
  await initGitRepoWithRemote(repoDir)

  const config = buildLoopConfig(
    repoDir,
    [
      buildShellPhase(
        'executor',
        `node -e "const fs=require('fs'); fs.mkdirSync('src',{recursive:true}); fs.writeFileSync('src/feature.ts','export const feature = 1\\n')"`
      ),
      {
        id: 'vitest',
        run: { kind: 'vitestChanged' },
        timeoutMs: 3000,
        allowFailure: false,
      },
    ]
  )

  const result = await runLoop(config, { once: true })
  assert.equal(result.exitCode, 2)
  assert.match(result.state.results[0].errorSummary, /no_resolved_tests_for_changed_files/)
  assert.deepEqual(result.state.results[0].phases[1].resolvedTests, [])
})

test('runLoop accepts reviewer-only LINEAR_ACTIVE binding when earlier phases omitted it', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-reviewer-bind-'))
  const issueId = '99999999-9999-4999-8999-999999999999'
  await initGitRepoWithRemote(repoDir)
  const { cliPath: linearCliPath } = await createFakeLinearCli(repoDir, [
    {
      id: issueId,
      identifier: 'AIR-999',
      title: 'Reviewer fallback binding',
      status: 'Todo',
      priority: 'P1',
    },
  ])

  const previousApiKey = process.env.LINEAR_API_KEY
  process.env.LINEAR_API_KEY = 'test-linear-key'

  try {
    const config = buildLoopConfig(
      repoDir,
      [
        buildShellPhase(
          'executor',
          `node -e "const fs=require('fs'); fs.writeFileSync('feature.txt','executor\\n')"`
        ),
        buildShellPhase(
          'reviewer',
          `node -e "console.log('[LINEAR_ACTIVE] issue_id=${issueId}')"`
        ),
      ],
      {
        repoPolicy: {
          onDirty: 'warn',
          autoCommitAfterEachPhase: true,
          autoPushAfterEachPhase: false,
          requireConventionalCommits: true,
          commitMessageMaxLen: 100,
          requireIssueKeyRegex: 'AIR-\\d+',
        },
        integrations: {
          linear: {
            enabled: true,
            cliPath: linearCliPath,
            promptPhaseIds: ['executor', 'reviewer'],
          },
        },
      }
    )

    const result = await runLoop(config, { once: true })
    assert.equal(result.exitCode, 0)
    assert.equal(result.state.results[0].canonicalActiveTask.identifier, 'AIR-999')
    assert.equal(result.state.results[0].deliverySummary.subject, 'AIR-999: sync turn changes')
  } finally {
    if (previousApiKey == null) delete process.env.LINEAR_API_KEY
    else process.env.LINEAR_API_KEY = previousApiKey
  }
})

test('runLoop accepts review phase id for reviewer-only LINEAR_ACTIVE binding', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-review-alias-bind-'))
  const issueId = 'abababab-abab-4bab-8bab-abababababab'
  await initGitRepoWithRemote(repoDir)
  const { cliPath: linearCliPath } = await createFakeLinearCli(repoDir, [
    {
      id: issueId,
      identifier: 'AIR-998',
      title: 'Review alias fallback binding',
      status: 'Todo',
      priority: 'P1',
    },
  ])

  const previousApiKey = process.env.LINEAR_API_KEY
  process.env.LINEAR_API_KEY = 'test-linear-key'

  try {
    const config = buildLoopConfig(
      repoDir,
      [
        buildShellPhase(
          'implement',
          `node -e "const fs=require('fs'); fs.writeFileSync('feature.txt','implement\\n')"`
        ),
        buildShellPhase(
          'review',
          `node -e "console.log('[LINEAR_ACTIVE] issue_id=${issueId}')"`
        ),
      ],
      {
        repoPolicy: {
          onDirty: 'warn',
          autoCommitAfterEachPhase: true,
          autoPushAfterEachPhase: false,
          requireConventionalCommits: true,
          commitMessageMaxLen: 100,
          requireIssueKeyRegex: 'AIR-\\d+',
        },
        integrations: {
          linear: {
            enabled: true,
            cliPath: linearCliPath,
            promptPhaseIds: ['review'],
          },
        },
      }
    )

    const result = await runLoop(config, { once: true })
    assert.equal(result.exitCode, 0)
    assert.equal(result.state.results[0].canonicalActiveTask.identifier, 'AIR-998')
    assert.equal(result.state.results[0].deliverySummary.subject, 'AIR-998: sync turn changes')
  } finally {
    if (previousApiKey == null) delete process.env.LINEAR_API_KEY
    else process.env.LINEAR_API_KEY = previousApiKey
  }
})

test('runLoop checkpoints dirty worktree after later phase failure so the next turn can continue', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-failure-checkpoint-'))
  const issueId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  await initGitRepoWithRemote(repoDir)
  const { cliPath: linearCliPath } = await createFakeLinearCli(repoDir, [
    {
      id: issueId,
      identifier: 'AIR-700',
      title: 'Checkpoint failed turn changes',
      status: 'Todo',
      priority: 'P1',
    },
  ])
  const buildFlagPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-build-flag-')), 'fail-once.flag')

  const previousApiKey = process.env.LINEAR_API_KEY
  process.env.LINEAR_API_KEY = 'test-linear-key'

  try {
    const config = buildLoopConfig(
      repoDir,
      [
        buildShellPhase(
          'executor',
          `node -e "const fs=require('fs'); fs.writeFileSync('feature.txt','executor\\n'); console.log('[LINEAR_ACTIVE] issue_id=${issueId}')"`
        ),
        buildShellPhase(
          'build',
          `FLAG=${JSON.stringify(buildFlagPath)} node -e "const fs=require('fs'); if (!fs.existsSync(process.env.FLAG)) { fs.writeFileSync(process.env.FLAG,'1'); process.exit(7) } console.log('build ok')"`
        ),
      ],
      {
        repoPolicy: {
          onDirty: 'warn',
          autoCommitAfterEachPhase: true,
          autoPushAfterEachPhase: false,
          requireConventionalCommits: true,
          commitMessageMaxLen: 100,
          requireIssueKeyRegex: 'AIR-\\d+',
        },
        integrations: {
          linear: {
            enabled: true,
            cliPath: linearCliPath,
            promptPhaseIds: ['executor'],
          },
        },
      }
    )

    const first = await runLoop(config, { once: true })
    assert.equal(first.exitCode, 2)
    assert.equal(first.state.results[0].deliverySummary.checkpointCommitted, true)
    assert.equal(first.state.results[0].deliverySummary.checkpointSubject, 'AIR-700: sync recovery changes')

    const second = await runLoop(config, { once: true })
    assert.equal(second.exitCode, 0)
    assert.notEqual(second.state.results[1].errorSummary, 'Working tree dirty at turn start')
    assert.equal(second.state.results[1].deliverySummary.error, null)
  } finally {
    if (previousApiKey == null) delete process.env.LINEAR_API_KEY
    else process.env.LINEAR_API_KEY = previousApiKey
  }
})

test('runLoop checkpoints quoted filenames without mangling pathspecs', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-quoted-checkpoint-'))
  const issueId = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd'
  await initGitRepoWithRemote(repoDir)
  const { cliPath: linearCliPath } = await createFakeLinearCli(repoDir, [
    {
      id: issueId,
      identifier: 'AIR-701',
      title: 'Checkpoint quoted filename changes',
      status: 'Todo',
      priority: 'P1',
    },
  ])

  const previousApiKey = process.env.LINEAR_API_KEY
  process.env.LINEAR_API_KEY = 'test-linear-key'

  try {
    const config = buildLoopConfig(
      repoDir,
      [
        buildShellPhase(
          'executor',
          `node -e "const fs=require('fs'); fs.writeFileSync('a \\"b\\".txt','quoted\\n'); console.log('[LINEAR_ACTIVE] issue_id=${issueId}')"`
        ),
        buildShellPhase(
          'build',
          `node -e "process.exit(7)"`
        ),
      ],
      {
        repoPolicy: {
          onDirty: 'warn',
          autoCommitAfterEachPhase: true,
          autoPushAfterEachPhase: false,
          requireConventionalCommits: true,
          commitMessageMaxLen: 100,
          requireIssueKeyRegex: 'AIR-\\d+',
        },
        integrations: {
          linear: {
            enabled: true,
            cliPath: linearCliPath,
            promptPhaseIds: ['executor'],
          },
        },
      }
    )

    const result = await runLoop(config, { once: true })
    assert.equal(result.exitCode, 2)
    assert.equal(result.state.results[0].deliverySummary.checkpointCommitted, true)

    const showHead = await runLocalCommand('git show --name-only --pretty=format:%s HEAD', repoDir)
    assert.match(showHead, /^AIR-701: sync recovery changes/)
    assert.match(showHead, /a \\"b\\"\.\w+/)
  } finally {
    if (previousApiKey == null) delete process.env.LINEAR_API_KEY
    else process.env.LINEAR_API_KEY = previousApiKey
  }
})
