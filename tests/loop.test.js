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
  const toolsDir = path.join(repoDir, 'tools')
  const cliPath = path.join(toolsDir, 'linear-cli.mjs')
  const statePath = path.join(repoDir, 'linear-state.json')
  const logPath = path.join(repoDir, 'linear-log.jsonl')

  await fs.mkdir(toolsDir, { recursive: true })
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
    assert.match(headSubject, /^AIR-580: sync reviewer changes$/)
    assert.match(remoteBranch, /refs\/heads\/agent-dev/)
    assert.deepEqual(
      linearLog.map((entry) => entry.patch?.Status ?? entry.command),
      ['Executing', 'Done']
    )
    assert.equal(result.state.results[0].phases[0].commitSubject, 'AIR-580: sync executor changes')
    assert.equal(result.state.results[0].phases[0].pushedBranch, 'agent-dev')
    assert.equal(result.state.results[0].phases[1].commitSubject, 'AIR-580: sync reviewer changes')
    assert.equal(result.state.results[0].phases[1].pushedBranch, 'agent-dev')
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
    const previousSubject = await runLocalCommand('git log -1 --skip=1 --pretty=%s', repoDir)

    assert.equal(result.state.results[0].phases[0].commitSubject, 'AIR-581: sync strategist changes')
    assert.equal(result.state.results[0].phases[1].commitSubject, 'AIR-581: sync executor changes')
    assert.equal(result.state.results[0].phases[2].commitSubject, 'AIR-581: sync reviewer changes')
    assert.equal(headSubject, 'AIR-581: sync reviewer changes')
    assert.equal(previousSubject, 'AIR-581: sync executor changes')
  } finally {
    if (previousApiKey == null) delete process.env.LINEAR_API_KEY
    else process.env.LINEAR_API_KEY = previousApiKey
  }
})
