import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeConfig, PRESETS, detectProjectType, patchVerifyCommand, writeSampleConfig } from '../src/config.js'
import { runLoop } from '../src/loop.js'

const CLI_PATH = path.resolve(process.cwd(), 'src/cli.js')

async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), `zhuge-int-${prefix}-`))
}

async function runCli(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { cwd })
    let out = ''
    let err = ''

    child.stdout.on('data', (chunk) => {
      out += chunk.toString()
    })

    child.stderr.on('data', (chunk) => {
      err += chunk.toString()
    })

    child.on('close', (code) => {
      resolve({ code: code ?? 0, out, err })
    })
  })
}

// --- Preset validation ---

test('all presets pass normalizeConfig', () => {
  for (const [name, preset] of Object.entries(PRESETS)) {
    const copy = structuredClone(preset)
    const config = normalizeConfig(copy, '/tmp/test.json')
    assert.ok(config.profileRotation.length > 0, `${name} has non-empty profileRotation`)
    assert.ok(Object.keys(config.profiles).length > 0, `${name} has profiles`)
  }
})

test('patchVerifyCommand updates all verify phases', () => {
  const team = structuredClone(PRESETS['zhuge-team'])
  const patched = patchVerifyCommand(team, 'pytest')
  const zhaoyunVerify = patched.profiles.zhaoyun.phases.find((p) => p.id === 'verify')
  assert.equal(zhaoyunVerify.command, 'pytest')
})

test('patchVerifyCommand leaves non-verify phases unchanged', () => {
  const solo = structuredClone(PRESETS['zhuge-solo'])
  const patched = patchVerifyCommand(solo, 'custom-test')
  const plan = patched.profiles.default.phases.find((p) => p.id === 'plan')
  assert.match(plan.command, /plan/)
  const implement = patched.profiles.default.phases.find((p) => p.id === 'implement')
  assert.match(implement.command, /implement/)
})

// --- detectProjectType ---

test('detectProjectType identifies node-lib', async () => {
  const dir = await makeTempDir('node')
  await fs.writeFile(path.join(dir, 'package.json'), '{}')
  assert.equal(await detectProjectType(dir), 'node-lib')
})

test('detectProjectType identifies python', async () => {
  const dir = await makeTempDir('python')
  await fs.writeFile(path.join(dir, 'pyproject.toml'), '')
  assert.equal(await detectProjectType(dir), 'python')
})

test('detectProjectType identifies react-vite', async () => {
  const dir = await makeTempDir('vite')
  await fs.writeFile(path.join(dir, 'vite.config.ts'), '')
  await fs.writeFile(path.join(dir, 'package.json'), '{}')
  assert.equal(await detectProjectType(dir), 'react-vite')
})

test('detectProjectType defaults to generic', async () => {
  const dir = await makeTempDir('empty')
  assert.equal(await detectProjectType(dir), 'generic')
})

// --- writeSampleConfig with presets ---

test('writeSampleConfig writes valid preset config', async () => {
  const dir = await makeTempDir('preset')
  const configPath = path.join(dir, 'zhuge.config.json')
  await writeSampleConfig(configPath, 'zhuge-team')
  const raw = JSON.parse(await fs.readFile(configPath, 'utf8'))
  assert.equal(raw.name, 'zhuge-team')
  assert.deepEqual(raw.profileRotation, ['zhuge', 'zhaoyun', 'guanyu'])
  const config = normalizeConfig(raw, configPath)
  assert.ok(config.profiles.zhuge)
})

test('writeSampleConfig rejects unknown preset', async () => {
  const dir = await makeTempDir('bad-preset')
  const configPath = path.join(dir, 'zhuge.config.json')
  await assert.rejects(() => writeSampleConfig(configPath, 'nonexistent'), /Unknown preset/)
})

test('writeSampleConfig without preset writes default solo config', async () => {
  const dir = await makeTempDir('default')
  const configPath = path.join(dir, 'zhuge.config.json')
  await writeSampleConfig(configPath)
  const raw = JSON.parse(await fs.readFile(configPath, 'utf8'))
  assert.deepEqual(raw.profileRotation, ['default'])
  assert.ok(raw.profiles.default.phases.length === 3)
})

// --- Quickstart flow (init -> run --once) ---

test('quickstart flow: init preset then run --once succeeds', async () => {
  const repoDir = await makeTempDir('qs')
  const configPath = path.join(repoDir, 'zhuge.config.json')

  const preset = patchVerifyCommand(structuredClone(PRESETS['generic']), 'echo ok')
  await fs.writeFile(configPath, `${JSON.stringify(preset, null, 2)}\n`)

  const config = normalizeConfig(
    JSON.parse(await fs.readFile(configPath, 'utf8')),
    configPath
  )
  const result = await runLoop({ ...config, sleepMs: 10 }, { once: true })

  assert.equal(result.exitCode, 0)
  assert.equal(result.state.turn, 1)
  assert.equal(result.state.consecutiveFailures, 0)

  const stateOnDisk = JSON.parse(await fs.readFile(config.statePath, 'utf8'))
  assert.equal(stateOnDisk.turn, 1)
})

// --- Full init -> doctor -> run --once -> log/state assertions ---

test('full flow: init -> run --once produces expected logs and state', async () => {
  const repoDir = await makeTempDir('full')
  const configPath = path.join(repoDir, 'zhuge.config.json')

  const preset = structuredClone(PRESETS['generic'])
  await fs.writeFile(configPath, `${JSON.stringify(preset, null, 2)}\n`)

  const config = normalizeConfig(
    JSON.parse(await fs.readFile(configPath, 'utf8')),
    configPath
  )
  const result = await runLoop({ ...config, sleepMs: 10 }, { once: true })

  assert.equal(result.exitCode, 0)

  const logsEntries = await fs.readdir(config.logsDir)
  const turnDirs = logsEntries.filter((e) => e.startsWith('turn-'))
  assert.equal(turnDirs.length, 1, 'exactly one turn log directory')

  const turnDir = path.join(config.logsDir, turnDirs[0])
  const contextJson = JSON.parse(await fs.readFile(path.join(turnDir, 'context.json'), 'utf8'))
  assert.equal(contextJson.turn, 0)
  assert.equal(contextJson.profileName, 'default')

  const resultJson = JSON.parse(await fs.readFile(path.join(turnDir, 'result.json'), 'utf8'))
  assert.equal(resultJson.ok, true)
  assert.equal(resultJson.phases.length, 3)

  const resultMd = await fs.readFile(path.join(turnDir, 'result.md'), 'utf8')
  assert.match(resultMd, /Turn 0/)
  assert.match(resultMd, /success/)
})

test('zhuge-team preset runs correct profile rotation', async () => {
  const repoDir = await makeTempDir('team')
  const configPath = path.join(repoDir, 'zhuge.config.json')

  const preset = patchVerifyCommand(structuredClone(PRESETS['zhuge-team']), 'echo ok')
  for (const profile of Object.values(preset.profiles)) {
    for (const phase of profile.phases) {
      if (phase.id !== 'verify') {
        phase.command = 'echo ok'
      }
    }
  }
  await fs.writeFile(configPath, `${JSON.stringify(preset, null, 2)}\n`)

  const config = normalizeConfig(
    JSON.parse(await fs.readFile(configPath, 'utf8')),
    configPath
  )

  const result = await runLoop({ ...config, sleepMs: 10 }, { once: true })
  assert.equal(result.exitCode, 0)
  assert.equal(result.state.turn, 1)
  assert.equal(result.state.lastProfile, 'zhuge')
})

test('init refuses to overwrite existing config without --force', async () => {
  const repoDir = await makeTempDir('init-overwrite')
  const configPath = path.join(repoDir, 'zhuge.config.json')
  await fs.writeFile(configPath, '{"name":"keep-me"}\n', 'utf8')

  const result = await runCli(['init'], repoDir)
  assert.equal(result.code, 1)
  assert.match(result.err, /Config already exists/)

  const raw = JSON.parse(await fs.readFile(configPath, 'utf8'))
  assert.equal(raw.name, 'keep-me')
})

test('quickstart refuses to overwrite existing config without --force', async () => {
  const repoDir = await makeTempDir('qs-overwrite')
  const configPath = path.join(repoDir, 'zhuge.config.json')
  await fs.writeFile(configPath, '{"name":"keep-me"}\n', 'utf8')
  await fs.writeFile(path.join(repoDir, 'package.json'), '{"scripts":{"test":"echo ok"}}\n', 'utf8')

  const result = await runCli(['quickstart'], repoDir)
  assert.equal(result.code, 1)
  assert.match(result.err, /Config already exists/)

  const raw = JSON.parse(await fs.readFile(configPath, 'utf8'))
  assert.equal(raw.name, 'keep-me')
})

test('quickstart exits non-zero when first turn fails verify phase', async () => {
  const repoDir = await makeTempDir('qs-fail')
  await fs.writeFile(path.join(repoDir, 'package.json'), '{}\n', 'utf8')

  const result = await runCli(['quickstart'], repoDir)
  assert.equal(result.code, 2)
  assert.match(result.out, /First turn had issues/)

  const logsDir = path.join(repoDir, '.zhuge-loop', 'logs')
  const turnDirs = (await fs.readdir(logsDir)).filter((entry) => entry.startsWith('turn-'))
  assert.equal(turnDirs.length, 1)
  const turnResult = JSON.parse(await fs.readFile(path.join(logsDir, turnDirs[0], 'result.json'), 'utf8'))
  assert.equal(turnResult.ok, false)
})
