#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  loadConfig,
  writeSampleConfig,
  detectProjectType,
  testCommandForProjectType,
  patchVerifyCommand,
  PRESETS,
} from './config.js'
import { runLoop } from './loop.js'
import { runCommand } from './runner.js'
import { mkdirp } from './utils.js'

function printHelp() {
  console.log(`
Zhuge Loop - agent loop runtime with Three Kingdoms methodology

Usage:
  zhuge-loop quickstart [--config <path>] [--force]
                                            Detect, configure, and run first turn
  zhuge-loop init [--preset <name>]         Interactive setup or preset config
  zhuge-loop run [--config <path>] [--once]
  zhuge-loop doctor [--config <path>] [--strict]

Presets:
  zhuge-solo    One agent, three phases (default)
  zhuge-team    Three agents rotating (zhuge/zhaoyun/guanyu)
  node-lib      Node.js library (npm test)
  react-vite    React / Vite (npx vitest run)
  python        Python (pytest)
  generic       Generic (echo ok)
  claude-code   Claude Code CLI
  kiro          Kiro CLI

Examples:
  zhuge-loop quickstart
  zhuge-loop init
  zhuge-loop init --preset zhuge-team
  zhuge-loop run --once
  zhuge-loop doctor --strict
`)
}

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (item === '--config') {
      args.config = argv[i + 1]
      i += 1
      continue
    }
    if (item === '--preset') {
      args.preset = argv[i + 1]
      i += 1
      continue
    }
    if (item === '--once') {
      args.once = true
      continue
    }
    if (item === '--force') {
      args.force = true
      continue
    }
    if (item === '--strict') {
      args.strict = true
      continue
    }
    args._.push(item)
  }
  return args
}

function firstCommandToken(command) {
  return command.trim().split(/\s+/)[0]
}

function quoteForShell(input) {
  return `'${String(input).replace(/'/g, `'"'"'`)}'`
}

function createCheck(label, ok, detail, strict = false) {
  return {
    label,
    status: ok ? 'OK' : (strict ? 'FAIL' : 'MISSING'),
    detail,
  }
}

async function assertConfigCanBeCreated(configPath, force) {
  if (force) return

  try {
    await fs.access(configPath)
    throw new Error(`Config already exists: ${configPath}. Use --force to overwrite.`)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return
    }
    throw error
  }
}

async function runInitWizard(repoDir) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const detected = await detectProjectType(repoDir)
  const typeChoices = [
    { label: 'Node.js (npm test)', value: 'node-lib' },
    { label: 'Python (pytest)', value: 'python' },
    { label: 'React / Vite (npx vitest run)', value: 'react-vite' },
    { label: 'Generic (echo ok)', value: 'generic' },
  ]
  const defaultTypeIndex = typeChoices.findIndex((c) => c.value === detected)
  const defaultNum = defaultTypeIndex >= 0 ? defaultTypeIndex + 1 : 1

  console.log('\n  Project type:')
  for (let i = 0; i < typeChoices.length; i += 1) {
    console.log(`  ${i + 1}) ${typeChoices[i].label}`)
  }
  const typeAnswer = await rl.question(`  Choice [${defaultNum}]: `)
  const typeIndex = (parseInt(typeAnswer.trim(), 10) || defaultNum) - 1
  const selectedType = typeChoices[Math.max(0, Math.min(typeIndex, typeChoices.length - 1))].value

  const defaultTestCmd = testCommandForProjectType(selectedType)
  const testCmdAnswer = await rl.question(`\n  Test command [${defaultTestCmd}]: `)
  const testCommand = testCmdAnswer.trim() || defaultTestCmd

  console.log('\n  Mode:')
  console.log('  1) Solo - one agent, three phases (recommended)')
  console.log('  2) Team - three agents rotating (zhuge/zhaoyun/guanyu)')
  const modeAnswer = await rl.question('  Choice [1]: ')
  const presetName = modeAnswer.trim() === '2' ? 'zhuge-team' : 'zhuge-solo'

  rl.close()
  return { presetName, testCommand }
}

async function commandQuickstart(configPath, force) {
  const repoDir = process.cwd()
  const resolved = path.resolve(repoDir, configPath)
  await assertConfigCanBeCreated(resolved, force)

  const projectType = await detectProjectType(repoDir)
  const testCommand = testCommandForProjectType(projectType)
  console.log(`Detected project type: ${projectType} (test: ${testCommand})`)

  const base = structuredClone(PRESETS['zhuge-solo'])
  const patched = patchVerifyCommand(base, testCommand)
  await fs.writeFile(resolved, `${JSON.stringify(patched, null, 2)}\n`, 'utf8')
  console.log(`Created config at ${resolved}`)

  const config = await loadConfig(resolved)
  console.log('Running first turn...\n')
  const result = await runLoop(config, { once: true })

  const latestTurn = result.state?.results?.[result.state.results.length - 1]
  if (result.exitCode === 0 && latestTurn?.ok) {
    console.log('\nFirst turn completed successfully!')
    console.log('Next steps:')
    console.log('  1. Edit commands in zhuge.config.json')
    console.log('  2. Run continuously: zhuge-loop run')
  } else {
    console.log('\nFirst turn had issues. Check .zhuge-loop/logs/ for details.')
    process.exitCode = result.exitCode || 2
  }
}

async function commandInit(configPath, force, presetName) {
  const resolved = path.resolve(process.cwd(), configPath)
  await assertConfigCanBeCreated(resolved, force)

  if (presetName) {
    await writeSampleConfig(resolved, presetName)
  } else if (process.stdin.isTTY) {
    const wizard = await runInitWizard(process.cwd())
    const base = structuredClone(PRESETS[wizard.presetName])
    const patched = patchVerifyCommand(base, wizard.testCommand)
    await fs.writeFile(resolved, `${JSON.stringify(patched, null, 2)}\n`, 'utf8')
  } else {
    await writeSampleConfig(resolved)
  }

  console.log(`Created config at ${resolved}`)
  console.log('Next: edit commands, then run `zhuge-loop run --once`.')
}

async function commandRun(configPath, once) {
  const resolved = path.resolve(process.cwd(), configPath)
  const config = await loadConfig(resolved)
  const result = await runLoop(config, { once })
  process.exitCode = result.exitCode
}

async function runDoctor(config, strict) {
  const checks = []
  const hasKiroPhase = config.profileRotation.some((profileName) =>
    config.profiles[profileName].phases.some((phase) => phase.run.kind === 'kiro')
  )

  for (const command of config.context?.commands ?? []) {
    const token = firstCommandToken(command.command)
    if (!token) continue

    const probe = await runCommand(`command -v ${quoteForShell(token)}`, {
      cwd: config.repoDir,
      timeoutMs: 3000,
    })

    checks.push(createCheck(`context/${command.name}`, probe.code === 0, token, strict))
  }

  if (strict) {
    try {
      await fs.access(config.repoDir, fsConstants.W_OK)
      checks.push({ label: 'repoDir writable', status: 'OK', detail: config.repoDir })
    } catch {
      checks.push({ label: 'repoDir writable', status: 'FAIL', detail: config.repoDir })
    }

    try {
      await mkdirp(config.runtimeDir)
      checks.push({ label: 'runtimeDir writable', status: 'OK', detail: config.runtimeDir })
    } catch {
      checks.push({ label: 'runtimeDir writable', status: 'FAIL', detail: config.runtimeDir })
    }

    checks.push({ label: 'config valid', status: 'OK', detail: '' })

    const gitResult = await runCommand('git status --porcelain', {
      cwd: config.repoDir,
      timeoutMs: 5000,
    })
    if (gitResult.code !== 0) {
      checks.push({ label: 'git clean', status: 'WARN', detail: 'not a git repo' })
    } else if (gitResult.out.trim()) {
      checks.push({ label: 'git clean', status: 'WARN', detail: 'uncommitted changes' })
    } else {
      checks.push({ label: 'git clean', status: 'OK', detail: '' })
    }
  }

  for (const profileName of config.profileRotation) {
    const profile = config.profiles[profileName]
    for (const phase of profile.phases) {
      if (phase.run.kind !== 'shell') continue

      const token = firstCommandToken(phase.run.command)
      if (!token) continue

      const probe = await runCommand(`command -v ${quoteForShell(token)}`, {
        cwd: config.repoDir,
        timeoutMs: 3000,
      })

      checks.push({
        label: `${profileName}/${phase.id}`,
        status: probe.code === 0 ? 'OK' : (strict ? 'FAIL' : 'MISSING'),
        detail: token,
      })
    }
  }

  if (hasKiroPhase) {
    for (const [name, command] of [
      ['kiro.acpCommand', config.kiro.acpCommand],
      ['kiro.cliCommand', config.kiro.cliCommand],
    ]) {
      const token = firstCommandToken(command)
      const probe = await runCommand(`command -v ${quoteForShell(token)}`, {
        cwd: config.repoDir,
        timeoutMs: 3000,
      })

      checks.push(createCheck(`kiro/${name}`, probe.code === 0, token, strict))
    }
  }

  if (config.integrations?.linear?.enabled) {
    const token = firstCommandToken(config.integrations.linear.cliPath)
    const probe = await runCommand(`command -v ${quoteForShell(token)}`, {
      cwd: config.repoDir,
      timeoutMs: 3000,
    })

    checks.push(createCheck('linear/cli', probe.code === 0, token, strict))
  }

  if (config.repoPolicy?.pushBranch) {
    const probe = await runCommand(`command -v ${quoteForShell('git')}`, {
      cwd: config.repoDir,
      timeoutMs: 3000,
    })

    checks.push(createCheck('repo/git', probe.code === 0, 'git', strict))
  }

  console.log('Doctor summary:')
  console.log(`  repoDir:    ${config.repoDir}`)
  console.log(`  runtimeDir: ${config.runtimeDir}`)
  console.log(`  profiles:   ${config.profileRotation.join(', ')}`)
  console.log('')

  for (const item of checks) {
    const detail = item.detail ? `: ${item.detail}` : ''
    console.log(`  [${item.status}] ${item.label}${detail}`)
  }

  if (checks.some((c) => c.status === 'FAIL' || c.status === 'MISSING')) {
    process.exitCode = 2
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0] ?? 'help'
  const configPath = args.config ?? 'zhuge.config.json'

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp()
    return
  }

  if (command === 'quickstart') {
    await commandQuickstart(configPath, Boolean(args.force))
    return
  }

  if (command === 'init') {
    await commandInit(configPath, Boolean(args.force), args.preset)
    return
  }

  if (command === 'run') {
    await commandRun(configPath, Boolean(args.once))
    return
  }

  if (command === 'doctor') {
    const resolved = path.resolve(process.cwd(), configPath)
    const config = await loadConfig(resolved)
    await runDoctor(config, Boolean(args.strict))
    return
  }

  throw new Error(`Unknown command: ${command}`)
}

main().catch((error) => {
  console.error(`[zhuge-loop] ${error?.message ?? String(error)}`)
  process.exitCode = 1
})
