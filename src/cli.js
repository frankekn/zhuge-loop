#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { loadConfig, writeSampleConfig } from './config.js'
import { runLoop } from './loop.js'
import { runCommand } from './runner.js'

function printHelp() {
  console.log(`
Zhuge Loop

Usage:
  zhuge-loop init [--config <path>]
  zhuge-loop run [--config <path>] [--once]
  zhuge-loop doctor [--config <path>]

Examples:
  zhuge-loop init
  zhuge-loop run --once
  zhuge-loop run --config ./examples/minimal.zhuge.config.json
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
    if (item === '--once') {
      args.once = true
      continue
    }
    if (item === '--force') {
      args.force = true
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

async function runDoctor(config) {
  const checks = []

  for (const profileName of config.profileRotation) {
    const profile = config.profiles[profileName]
    for (const phase of profile.phases) {
      const token = firstCommandToken(phase.command)
      if (!token) continue

      const probe = await runCommand(`command -v ${quoteForShell(token)}`, {
        cwd: config.repoDir,
        timeoutMs: 3000,
      })

      checks.push({
        profile: profileName,
        phase: phase.id,
        command: token,
        ok: probe.code === 0,
      })
    }
  }

  console.log('Doctor summary:')
  console.log(`- repoDir: ${config.repoDir}`)
  console.log(`- runtimeDir: ${config.runtimeDir}`)
  console.log(`- profiles: ${config.profileRotation.join(', ')}`)

  for (const item of checks) {
    const status = item.ok ? 'OK' : 'MISSING'
    console.log(`- [${status}] ${item.profile}/${item.phase}: ${item.command}`)
  }

  if (checks.some((item) => !item.ok)) {
    process.exitCode = 2
  }
}

async function commandInit(configPath, force) {
  const resolved = path.resolve(process.cwd(), configPath)
  try {
    if (!force) {
      await fs.access(resolved)
      throw new Error(`Config already exists: ${resolved}. Use --force to overwrite.`)
    }
  } catch (error) {
    if (error?.code && error.code !== 'ENOENT') {
      throw error
    }
  }

  await writeSampleConfig(resolved)
  console.log(`Created sample config at ${resolved}`)
  console.log('Next step: edit commands, then run `zhuge-loop run --once`.')
}

async function commandRun(configPath, once) {
  const resolved = path.resolve(process.cwd(), configPath)
  const config = await loadConfig(resolved)
  const result = await runLoop(config, { once })
  process.exitCode = result.exitCode
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0] ?? 'help'
  const configPath = args.config ?? 'zhuge.config.json'

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp()
    return
  }

  if (command === 'init') {
    await commandInit(configPath, Boolean(args.force))
    return
  }

  if (command === 'run') {
    await commandRun(configPath, Boolean(args.once))
    return
  }

  if (command === 'doctor') {
    const resolved = path.resolve(process.cwd(), configPath)
    const config = await loadConfig(resolved)
    await runDoctor(config)
    return
  }

  throw new Error(`Unknown command: ${command}`)
}

main().catch((error) => {
  console.error(`[zhuge-loop] ${error?.message ?? String(error)}`)
  process.exitCode = 1
})
