import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

async function writeExecutable(filePath, contents) {
  await fs.writeFile(filePath, contents, { mode: 0o755 })
}

function runCli(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['/home/termtek/Documents/Github/zhuge-loop/src/cli.js', ...args], {
      cwd: options.cwd,
      env: options.env,
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
      resolve({ code, stdout, stderr })
    })
  })
}

test('doctor checks kiro binaries for kiro phases', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-doctor-'))
  const acpPath = path.join(repoDir, 'fake-kiro-acp.mjs')
  const cliPath = path.join(repoDir, 'fake-kiro-cli.mjs')
  const configPath = path.join(repoDir, 'zhuge.config.json')

  await writeExecutable(acpPath, '#!/usr/bin/env node\nprocess.exit(0)\n')
  await writeExecutable(cliPath, '#!/usr/bin/env node\nprocess.exit(0)\n')

  await fs.writeFile(
    configPath,
    `${JSON.stringify(
      {
        repoDir: '.',
        kiro: {
          acpCommand: acpPath,
          cliCommand: cliPath,
        },
        profileRotation: ['default'],
        profiles: {
          default: {
            phases: [
              {
                id: 'plan',
                run: {
                  kind: 'kiro',
                  agent: 'zhuge',
                  prompt: 'hello',
                },
                timeoutMs: 1000,
              },
            ],
          },
        },
      },
      null,
      2
    )}\n`
  )

  const result = await runCli(['doctor', '--config', configPath], { cwd: repoDir, env: process.env })
  assert.equal(result.code, 0)
  assert.match(result.stdout, /\[OK\] kiro\/kiro\.acpCommand:/)
  assert.match(result.stdout, /\[OK\] kiro\/kiro\.cliCommand:/)
})

test('doctor checks context command binaries', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-doctor-context-'))
  const configPath = path.join(repoDir, 'zhuge.config.json')

  await fs.writeFile(
    configPath,
    `${JSON.stringify(
      {
        repoDir: '.',
        context: {
          commands: [
            {
              name: 'node-check',
              command: 'node --version',
              timeoutMs: 1000,
              maxLines: 5,
            },
          ],
        },
        profileRotation: ['default'],
        profiles: {
          default: {
            phases: [
              {
                id: 'plan',
                command: 'echo ok',
                timeoutMs: 1000,
              },
            ],
          },
        },
      },
      null,
      2
    )}\n`
  )

  const result = await runCli(['doctor', '--config', configPath], { cwd: repoDir, env: process.env })
  assert.equal(result.code, 0)
  assert.match(result.stdout, /\[OK\] context\/node-check: node/)
})

test('doctor checks linear cli and git when repo delivery is enabled', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-doctor-linear-'))
  const linearCliPath = path.join(repoDir, 'fake-linear-cli.mjs')
  const configPath = path.join(repoDir, 'zhuge.config.json')

  await writeExecutable(linearCliPath, '#!/usr/bin/env node\nprocess.exit(0)\n')

  await fs.writeFile(
    configPath,
    `${JSON.stringify(
      {
        repoDir: '.',
        repoPolicy: {
          pushBranch: 'agent-dev',
        },
        integrations: {
          linear: {
            enabled: true,
            cliPath: linearCliPath,
          },
        },
        profileRotation: ['default'],
        profiles: {
          default: {
            phases: [
              {
                id: 'plan',
                command: 'echo ok',
                timeoutMs: 1000,
              },
            ],
          },
        },
      },
      null,
      2
    )}\n`
  )

  const result = await runCli(['doctor', '--config', configPath], { cwd: repoDir, env: process.env })
  assert.equal(result.code, 0)
  assert.match(result.stdout, /\[OK\] linear\/cli:/)
  assert.match(result.stdout, /\[OK\] repo\/git: git/)
})

test('doctor exits non-zero when kiro binary is missing', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuge-loop-doctor-missing-'))
  const configPath = path.join(repoDir, 'zhuge.config.json')

  await fs.writeFile(
    configPath,
    `${JSON.stringify(
      {
        repoDir: '.',
        kiro: {
          acpCommand: path.join(repoDir, 'missing-acp'),
          cliCommand: path.join(repoDir, 'missing-cli'),
        },
        profileRotation: ['default'],
        profiles: {
          default: {
            phases: [
              {
                id: 'plan',
                run: {
                  kind: 'kiro',
                  agent: 'zhuge',
                  prompt: 'hello',
                },
                timeoutMs: 1000,
              },
            ],
          },
        },
      },
      null,
      2
    )}\n`
  )

  const result = await runCli(['doctor', '--config', configPath], { cwd: repoDir, env: process.env })
  assert.equal(result.code, 2)
  assert.match(result.stdout, /\[MISSING\] kiro\/kiro\.acpCommand:/)
  assert.match(result.stdout, /\[MISSING\] kiro\/kiro\.cliCommand:/)
})
