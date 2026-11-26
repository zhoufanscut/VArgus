import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { processIsRunning } from '../../src/node/process.ts'
import { runFixtureCommand, withCleanup } from '../fixture-commands.mts'

test('fixture cleanup preserves the command error and the independent cleanup error', async () => {
  const command = new Error('command failed'), cleanup = new Error('cleanup failed')
  await assert.rejects(withCleanup(async () => { throw command }, async () => { throw cleanup }),
    error => error instanceof AggregateError && error.errors[0] === command && error.errors[1] === cleanup)
})

const signals = process.platform === 'win32' ? [] : ['SIGINT', 'SIGTERM']
for (const mode of ['success', 'failure', 'timeout', ...signals]) {
  test(`the fixture runner stops an unmarked descendant after ${mode}`, async () => {
    const temp = await realpath(tmpdir())
    const dir = await mkdtemp(join(temp, 'vargus-runner-')), stopped = join(dir, 'stopped')
    const env = { ...process.env, VARGUS_CLAUDE_FIXTURE: basename(dir), TMP: dir, TEMP: dir, TMPDIR: dir }
    const run = () => runFixtureCommand(`node parent.cjs ${mode}`, dir, env, stopped, mode === 'timeout' ? 2500 : 15_000)
    let started = false
    await withCleanup(async () => {
      await writeFile(join(dir, 'parent.cjs'), `
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const env = { ...process.env }
delete env.VARGUS_CLAUDE_FIXTURE
const leaf = spawn(process.execPath, ['-e', "setTimeout(() => require('node:fs').writeFileSync('natural-exit', ''), 15000); process.send('ready'); process.disconnect()"], { env, stdio: ['ignore','ignore','ignore','ipc'], windowsHide: true })
leaf.once('message', message => {
  if (message !== 'ready') throw new Error('leaf did not arm its timer')
  process.kill(leaf.pid, 0)
  writeFileSync('live-pid', String(leaf.pid))
  leaf.unref()
  if (['timeout', 'SIGINT', 'SIGTERM'].includes(process.argv[2])) setTimeout(() => {}, 15000)
  else process.exitCode = process.argv[2] === 'failure' ? 37 : 0
})
`)
      started = true
      if (signals.includes(mode)) {
        const driver = `
import { watchFile, unwatchFile } from 'node:fs'
import { runFixtureCommand } from ${JSON.stringify(new URL('../fixture-commands.mts', import.meta.url).href)}
watchFile('live-pid', { interval: 20 }, stat => {
  if (stat.size) { unwatchFile('live-pid'); process.kill(process.pid, ${JSON.stringify(mode)}) }
})
try { await runFixtureCommand('node parent.cjs ${mode}', process.cwd(), process.env, ${JSON.stringify(stopped)}, 10000) }
catch (error) { console.error(error.message); process.exitCode = 1 }
finally { unwatchFile('live-pid') }
`
        await assert.rejects(promisify(execFile)(process.execPath, ['--input-type=module', '-e', driver], { cwd: dir, env, timeout: 20_000 }),
          (error: Error & { code?: number; stderr?: string }) => error.code === 1 && !!error.stderr?.includes(`interrupted by ${mode}`))
      } else if (mode === 'success') await run()
      else await assert.rejects(run, mode === 'failure' ? /exited with 37|failed \(37;/ : /timed out \(|failed \(124;/)
      await access(stopped)
      const pid = Number(await readFile(join(dir, 'live-pid'), 'utf8'))
      assert.ok(pid > 0)
      assert.equal(await processIsRunning(pid), false, `fixture descendant ${pid} still active`)
      await assert.rejects(access(join(dir, 'natural-exit')), { code: 'ENOENT' })
    }, async () => {
      try {
        if (started) {
          await access(stopped)
          const pid = Number(await readFile(join(dir, 'live-pid'), 'utf8'))
          if (await processIsRunning(pid)) throw new Error(`descendant ${pid} still active`)
        }
        if (await realpath(dir) !== dir || dirname(dir) !== temp) throw new Error('fixture path changed')
        await rm(dir, { recursive: true })
      } catch (error) { throw new Error(`Retained runner fixture at ${dir}`, { cause: error }) }
    })
  })
}

test('a marker visible only on ps cannot release the gate or certify cleanup', { skip: process.platform === 'win32' }, async () => {
  const temp = await realpath(tmpdir()), dir = await mkdtemp(join(temp, 'vargus-gate-'))
  const env = { ...process.env, VARGUS_CLAUDE_FIXTURE: basename(dir) }
  const stopped = join(dir, 'stopped'), ran = join(dir, 'ran')
  await withCleanup(async () => {
    await writeFile(join(dir, 'ps'), `#!/bin/sh
command -p ps "$@" | awk -v self="$$" '{if ($1 != self) gsub(/VARGUS_CLAUDE_FIXTURE=/, "HIDDEN="); print}'
`, { mode: 0o755 })
    await assert.rejects(runFixtureCommand('touch ran', dir, { ...env, PATH: [dir, process.env.PATH].filter(Boolean).join(delimiter) }, stopped), /did not see the marked gated shell/)
    await assert.rejects(access(ran), { code: 'ENOENT' })
    await assert.rejects(access(stopped), { code: 'ENOENT' })
  }, async () => {
    await runFixtureCommand('touch ran', dir, env, stopped)
    await access(ran)
    await access(stopped)
    if (await realpath(dir) !== dir || dirname(dir) !== temp) throw new Error(`Fixture path changed: ${dir}`)
    await rm(dir, { recursive: true })
  })
})
