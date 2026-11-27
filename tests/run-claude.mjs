import { execFile, spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const windows = process.platform === 'win32'
const source = resolve(import.meta.dirname, '..')
const temp = await realpath(tmpdir())
const directory = await mkdtemp(join(temp, 'vargus-claude-test-'))
const checkout = join(directory, 'checkout')
const profile = join(directory, 'profile')
const temporary = join(directory, 'tmp')
const env = {
  ...process.env,
  CLAUDE_CONFIG_DIR: profile,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_AUTOUPDATER: '1',
  TEMP: temporary,
  TMP: temporary,
  TMPDIR: temporary,
}

function windowsEnvValue(map, name) {
  const target = name.toLowerCase()
  for (const [key, value] of Object.entries(map)) {
    if (key.toLowerCase() === target && value) return value
  }
  return undefined
}

async function withCleanup(work, cleanup, message = 'Command and cleanup both failed') {
  try { await work() } catch (failure) {
    try { await cleanup() } catch (cleanupError) {
      throw new AggregateError([failure, cleanupError], message)
    }
    throw failure
  }
  await cleanup()
}

async function stopTree(child) {
  if (!child.pid) return
  if (windows) {
    try {
      await exec('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { env, windowsHide: true, timeout: 5000 })
    } catch (error) {
      if (error?.code === 128) return
      child.kill('SIGKILL')
      throw error
    }
    return
  }
  try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error?.code !== 'ESRCH') throw error }
}

let retainReason = null

async function runCommand(file, args, timeout = 120_000) {
  const label = [file, ...args].join(' ')
  const child = spawn(file, args, { cwd: checkout, env, stdio: 'inherit', detached: !windows, windowsHide: true })
  let closed = false
  const exited = new Promise(resolve => {
    child.once('close', (code, signal) => { closed = true; resolve([code, signal]) })
  })
  const failed = new Promise((_, reject) => { child.on('error', reject) })
  failed.catch(() => {})
  let timer
  let onSignal
  const cancelled = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeout}ms`)), timeout)
    onSignal = signal => reject(new Error(`${label} interrupted by ${signal}`))
    process.on('SIGINT', onSignal).on('SIGTERM', onSignal)
  })
  cancelled.catch(() => {})
  try {
    await withCleanup(async () => {
      const [code, signal] = await Promise.race([exited, failed, cancelled])
      if (code !== 0) throw new Error(`${label} exited with ${signal ?? code}`)
    }, async () => {
      clearTimeout(timer)
      process.off('SIGINT', onSignal).off('SIGTERM', onSignal)
      if (!closed && child.pid) {
        let stopFailed = false
        try {
          await withCleanup(async () => {
            try {
              await stopTree(child)
            } catch (error) {
              stopFailed = true
              throw error
            }
          }, async () => {
            const controller = new AbortController()
            const closeTimeout = delay(5_000, undefined, { ref: false, signal: controller.signal }).then(() => {
              throw new Error(`${label}: child exit was not confirmed after 5000ms`)
            })
            closeTimeout.catch(() => {})
            try {
              await Promise.race([exited, closeTimeout])
            } finally {
              controller.abort()
            }
          }, 'Process-tree stop and close wait both failed')
        } finally {
          if (stopFailed && !closed) retainReason = 'process-tree stop failed and child exit was not confirmed'
          else if (stopFailed) retainReason = 'process-tree stop failed'
          else if (!closed) retainReason = 'child exit was not confirmed'
        }
      }
    })
  } finally {
    child.unref()
  }
}

const comspec = windowsEnvValue(env, 'ComSpec') ?? 'cmd.exe'
const commands = windows
  ? [
      [comspec, ['/d', '/s', '/c', 'claude plugin validate .']],
      [comspec, ['/d', '/s', '/c', 'claude plugin test .']],
      ['git', ['-c', 'alias.vargus-test=!sh', 'vargus-test', 'tests/claude/reader.test.sh']],
      ['git', ['-c', 'alias.vargus-test=!sh', 'vargus-test', 'tests/claude/manifest.test.sh']],
    ]
  : [
      ['claude', ['plugin', 'validate', '.']],
      ['claude', ['plugin', 'test', '.']],
      ['sh', ['tests/claude/reader.test.sh']],
      ['sh', ['tests/claude/manifest.test.sh']],
    ]

try {
  await mkdir(profile)
  await mkdir(temporary)
  for (const name of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'README.md', 'bin', 'src', 'tests/claude', 'docs/setup-claude.md']) {
    await cp(join(source, name), join(checkout, name), { recursive: true, filter: path => !path.endsWith('.test.mts') })
  }
  for (const [file, args] of commands) await runCommand(file, args)
} finally {
  if (retainReason) {
    console.error(`Retained Claude test fixture at ${directory}: ${retainReason}`)
    process.exitCode = 1
  } else {
    try {
      if (await realpath(directory) !== directory || dirname(directory) !== temp) throw new Error('Fixture path changed')
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch (error) {
      console.error(`Retained Claude test fixture at ${directory}: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
  }
}
