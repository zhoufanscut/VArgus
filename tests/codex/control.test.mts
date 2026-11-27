import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { stopWorker } from '../../src/cli/codex/control.ts'
import { controlRoot, recordPath, save, type Running } from '../../src/cli/codex/state.ts'
import { processIsRunning } from '../../src/node/process.ts'

async function spawnFakeWorker(
  dir: string,
  token: string,
  mode: 'graceful' | 'ignore-term',
): Promise<{
  pid: number
  record: Running
  closed: Promise<[number | null, NodeJS.Signals | null]>
  killAndWait: () => Promise<void>
}> {
  const gotTermFile = join(dir, 'got-term')
  const script = `
const { writeFileSync } = require('node:fs')
process.on('SIGTERM', () => {
  if (${JSON.stringify(mode)} === 'graceful') process.exit(0)
  writeFileSync(${JSON.stringify(gotTermFile)}, '1')
})
process.send('ready')
setInterval(() => {}, 1000)
`
  const child = spawn(process.execPath, ['-e', script, '__row', JSON.stringify({ token })], {
    cwd: dir,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  let exited = false
  const closed = new Promise<[number | null, NodeJS.Signals | null]>(resolve => {
    child.once('exit', (code, signal) => {
      exited = true
      resolve([code, signal])
    })
  })
  const killAndWait = async () => {
    if (!exited) {
      try { process.kill(child.pid!, 'SIGKILL') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
      await closed
    }
  }
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('message', msg => {
        if (msg === 'ready') resolve()
        else reject(new Error(`Unexpected worker message: ${String(msg)}`))
      })
      closed.then(([code, signal]) => reject(new Error(`Worker exited before ready (${signal ?? code})`)))
    })
    if (child.connected) child.disconnect()
    const pid = child.pid!
    const target = { socket: join(dir, 'tmux.sock'), pane: '%0', pid: process.pid }
    const record: Running = { pid, thread: '00000000-0000-0000-0000-000000000001', target, token }
    await mkdir(controlRoot(), { recursive: true, mode: 0o700 })
    await save(recordPath(target), record)
    return { pid, record, closed, killAndWait }
  } catch (error) {
    await killAndWait()
    throw error
  }
}

async function withTempControlEnv(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'vargus-stop-worker-test-'))
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }
  process.env.TMPDIR = dir
  process.env.TMP = dir
  process.env.TEMP = dir
  try {
    await fn(dir)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(dir, { recursive: true, force: true })
  }
}

test('stopWorker exits cleanly on SIGTERM without escalating', { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
  await withTempControlEnv(async dir => {
    const worker = await spawnFakeWorker(dir, 'token-graceful', 'graceful')
    try {
      await stopWorker(worker.record, 1500, 500)
      const [code, signal] = await worker.closed
      assert.equal(code, 0)
      assert.equal(signal, null)
      assert.equal(await processIsRunning(worker.pid), false)
    } finally {
      await worker.killAndWait()
    }
  })
})

test('stopWorker escalates to SIGKILL when a POSIX worker ignores SIGTERM', { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
  await withTempControlEnv(async dir => {
    const worker = await spawnFakeWorker(dir, 'token-stuck', 'ignore-term')
    try {
      await stopWorker(worker.record, 250, 1500)
      assert.equal(existsSync(join(dir, 'got-term')), true, 'SIGTERM must be attempted before SIGKILL')
      const [code, signal] = await worker.closed
      assert.equal(code, null)
      assert.equal(signal, 'SIGKILL')
      assert.equal(await processIsRunning(worker.pid), false)
    } finally {
      await worker.killAndWait()
    }
  })
})

test('stopWorker refuses to signal a worker whose recorded token changed', { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
  await withTempControlEnv(async dir => {
    const worker = await spawnFakeWorker(dir, 'token-actual', 'graceful')
    try {
      await assert.rejects(
        stopWorker({ ...worker.record, token: 'token-other' }, 200, 200),
        /changed before it could be stopped/,
      )
      assert.equal(await processIsRunning(worker.pid), true)
    } finally {
      await worker.killAndWait()
    }
  })
})

test('stopWorker refuses SIGKILL escalation if a new worker replaces the record after SIGTERM', { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
  await withTempControlEnv(async dir => {
    const worker = await spawnFakeWorker(dir, 'token-before', 'ignore-term')
    const replacement = await spawnFakeWorker(dir, 'token-replaced', 'graceful')
    await save(recordPath(worker.record.target), worker.record)
    const gotTerm = join(dir, 'got-term')
    const stopper = stopWorker(worker.record, 250, 1500)
    stopper.catch(() => {})
    try {
      const until = Date.now() + 3000
      while (!existsSync(gotTerm) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10))
      assert.equal(existsSync(gotTerm), true)
      await save(recordPath(worker.record.target), replacement.record)
      await assert.rejects(stopper, /changed before it could be stopped/)
      assert.equal(await processIsRunning(worker.pid), true)
      assert.equal(await processIsRunning(replacement.pid), true)
    } finally {
      await stopper.catch(() => {})
      await replacement.killAndWait()
      await worker.killAndWait()
    }
  })
})
