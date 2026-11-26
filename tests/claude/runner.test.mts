import assert from 'node:assert/strict'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { channel } from 'node:diagnostics_channel'
import { once } from 'node:events'
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { promisify } from 'node:util'
import { processIsRunning } from '../../src/node/process.ts'
import { runFixtureCommand, withCleanup } from '../fixture-commands.mts'
import { checkStoppedOutput } from '../posix-stopped-fixture.mts'

test('fixture cleanup preserves the command error and the independent cleanup error', async () => {
  const command = new Error('command failed'), cleanup = new Error('cleanup failed')
  await assert.rejects(withCleanup(async () => { throw command }, async () => { throw cleanup }),
    error => error instanceof AggregateError && error.errors[0] === command && error.errors[1] === cleanup)
})

const signals = ['SIGINT', 'SIGTERM']
for (const mode of ['success', 'failure', 'timeout', 'anchor-exit', ...signals]) {
  test(`the POSIX fixture runner stops an unmarked descendant after ${mode}`, { skip: process.platform === 'win32' }, async context => {
    const temp = await realpath(tmpdir())
    const dir = await mkdtemp(join(temp, 'vargus-runner-')), stopped = join(dir, 'stopped')
    const env: NodeJS.ProcessEnv = { ...process.env, VARGUS_CLAUDE_FIXTURE: basename(dir), VARGUS_TEST_NODE: process.execPath, TMP: dir, TEMP: dir, TMPDIR: dir }
    const command = `"$VARGUS_TEST_NODE" parent.cjs ${mode}`
    const run = () => runFixtureCommand(command, dir, env, stopped, mode === 'timeout' ? 2500 : 15_000)
    const groupSignals: number[] = []
    if (mode === 'anchor-exit') {
      const kill = process.kill.bind(process)
      context.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
        if (pid < 0 && signal !== 0) { groupSignals.push(pid); return true }
        return kill(pid, signal)
      })
    }
    let started = false
    await withCleanup(async () => {
      await writeFile(join(dir, 'parent.cjs'), `
const { execFileSync, spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const env = { ...process.env }
delete env.VARGUS_CLAUDE_FIXTURE
const leaf = spawn(process.execPath, ['-e', "setTimeout(() => require('node:fs').writeFileSync('natural-exit', ''), 15000); process.send('ready'); process.disconnect()"], { env, stdio: ['ignore','ignore','ignore','ipc'], windowsHide: true })
leaf.once('message', message => {
  if (message !== 'ready') throw new Error('leaf did not arm its timer')
  process.kill(leaf.pid, 0)
  writeFileSync('live-pid', String(leaf.pid))
  leaf.unref()
  if (process.argv[2] === 'anchor-exit') {
    const leader = Number(process.env.VARGUS_TEST_LEADER)
    const group = Number(execFileSync('ps', ['-p', String(process.pid), '-o', 'pgid='], { encoding: 'utf8' }))
    if (!(leader > 1 && leader === group)) throw new Error('could not verify the recorded fixture group leader')
    process.kill(leader, 'SIGKILL')
  }
  if (['timeout', 'anchor-exit', 'SIGINT', 'SIGTERM'].includes(process.argv[2])) setTimeout(() => {}, 15000)
  else process.exitCode = process.argv[2] === 'failure' ? 37 : 0
})
`)
      if (mode === 'anchor-exit') {
        await writeFile(join(dir, 'sh'), '#!/bin/sh\nif [ "$3" = fixture-shell ]; then export VARGUS_TEST_LEADER=$$; fi\nexec /bin/sh "$@"\n', { mode: 0o755 })
        env.PATH = [dir, env.PATH].join(delimiter)
      }
      started = true
      if (signals.includes(mode)) {
        const driver = `
import { watchFile, unwatchFile } from 'node:fs'
import { runFixtureCommand } from ${JSON.stringify(new URL('../fixture-commands.mts', import.meta.url).href)}
watchFile('live-pid', { interval: 20 }, stat => {
  if (stat.size) { unwatchFile('live-pid'); process.kill(process.pid, ${JSON.stringify(mode)}) }
})
try { await runFixtureCommand(${JSON.stringify(command)}, process.cwd(), process.env, ${JSON.stringify(stopped)}, 10000) }
catch (error) { console.error(error.message); process.exitCode = 1 }
finally { unwatchFile('live-pid') }
`
        await assert.rejects(promisify(execFile)(process.execPath, ['--input-type=module', '-e', driver], { cwd: dir, env, timeout: 20_000 }),
          (error: Error & { code?: number; stderr?: string }) => error.code === 1 && !!error.stderr?.includes(`interrupted by ${mode}`))
      } else if (mode === 'success') await run()
      else if (mode === 'anchor-exit') {
        await assert.rejects(run, /exited with no status/)
        assert.deepEqual(groupSignals, [], 'the controller must not signal a numeric process group')
      }
      else await assert.rejects(run, mode === 'failure' ? /exited with 37/ : /timed out \(/)
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

for (const leader of ['live', 'lost'] as const) {
  test(`captured POSIX output closes before rescue with a stopped group and ${leader} leader`,
    { skip: process.platform === 'win32' }, () => checkStoppedOutput(leader))
}

for (const stream of ['stdout', 'stderr'] as const) {
  test(`a POSIX reader closing ${stream} reports EPIPE after fixture cleanup`, { skip: process.platform === 'win32' }, async () => {
    const temp = await realpath(tmpdir()), dir = await mkdtemp(join(temp, 'vargus-pipe-'))
    const stopped = join(dir, 'stopped'), release = join(dir, 'release')
    const env = { ...process.env, VARGUS_CLAUDE_FIXTURE: basename(dir), TMP: dir, TEMP: dir, TMPDIR: dir }
    const output = stream === 'stdout' ? '' : ' >&2'
    const command = `printf 'ready\\n'${output}; while [ ! -f release ]; do sleep 0.02; done; printf 'last\\n'${output}${stream === 'stderr' ? '; sleep 10' : ''}`
    const driver = `
import { runFixtureCommand } from ${JSON.stringify(new URL('../fixture-commands.mts', import.meta.url).href)}
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
const listeners = process.${stream}.listenerCount('error')
try { await runFixtureCommand(${JSON.stringify(command)}, process.cwd(), process.env, ${JSON.stringify(stopped)}, 5000) }
catch (error) {
  await writeFile('caught', JSON.stringify({ code: error.code, stopped: existsSync(${JSON.stringify(stopped)}),
    restored: process.${stream}.listenerCount('error') === listeners }))
  process.exitCode = 1
}
`
    let finished: Promise<unknown[]> | undefined
    await withCleanup(async () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', driver], { cwd: dir, env, timeout: 15_000, killSignal: 'SIGKILL',
        stdio: ['ignore', stream === 'stdout' ? 'pipe' : 'ignore', stream === 'stderr' ? 'pipe' : 'ignore'] })
      finished = once(child, 'close')
      const reader = child[stream]!
      const [first] = await Promise.race([once(reader, 'data'), finished.then(() => { throw new Error('driver exited before the first write') })])
      assert.deepEqual(first, Buffer.from('ready\n'))
      const readerClosed = once(reader, 'close')
      reader.destroy()
      await readerClosed
      await writeFile(release, '')
      assert.deepEqual(await finished, [1, null])
      assert.deepEqual(JSON.parse(await readFile(join(dir, 'caught'), 'utf8')), { code: 'EPIPE', stopped: true, restored: true })
    }, async () => {
      if (finished) { await writeFile(release, ''); await finished; await access(stopped) }
      if (await realpath(dir) !== dir || dirname(dir) !== temp) throw new Error(`Fixture path changed: ${dir}`)
      await rm(dir, { recursive: true })
    })
  })
}

for (const status of [0, 37]) {
  test(`POSIX cleanup waits for the last output write after command exit ${status}`, { skip: process.platform === 'win32' }, async context => {
    const temp = await realpath(tmpdir()), dir = await mkdtemp(join(temp, 'vargus-last-write-')), marker = basename(dir)
    const env = { ...process.env, VARGUS_CLAUDE_FIXTURE: marker, TMP: dir, TEMP: dir, TMPDIR: dir }
    const stopped = join(dir, 'stopped'), command = `printf %s ${marker}; exit ${status}`
    let writeStarted!: () => void, shellClosed!: () => void
    const pending = new Promise<void>(resolve => { writeStarted = resolve }), write = process.stdout.write.bind(process.stdout)
    const closed = new Promise<void>(resolve => { shellClosed = resolve })
    let afterClose = false, released = false
    const exitChecks: boolean[] = [], spawns = channel('child_process')
    const observe = (message: unknown) => {
      const { process: child } = message as { process: ChildProcess }
      child.once('spawn', () => {
        if (child.spawnargs[3] === 'fixture-shell' && child.spawnargs[4] === command) {
          child.once('close', () => { afterClose = true; shellClosed() })
        } else if (afterClose && child.spawnfile === 'ps') exitChecks.push(released)
      })
    }
    spawns.subscribe(observe)
    context.after(() => { spawns.unsubscribe(observe) })
    let acknowledge: ((error: Error) => void) | undefined
    context.mock.method(process.stdout, 'write', (chunk: unknown, ...args: unknown[]) => {
      if (!Buffer.isBuffer(chunk) || !chunk.equals(Buffer.from(marker))) return Reflect.apply(write, process.stdout, [chunk, ...args])
      acknowledge = args.at(-1) as (error: Error) => void
      writeStarted()
      return false
    })
    const failure = Object.assign(new Error('controlled final write failed'), { code: 'EPIPE' })
    const failWrite = () => { const done = acknowledge; acknowledge = undefined; released = true; done?.(failure) }
    let returned = false
    const outcome = runFixtureCommand(command, dir, env, stopped, 5000)
      .then(() => null, (error: Error) => error).finally(() => { returned = true })
    await withCleanup(async () => {
      await Promise.race([Promise.all([pending, closed]), outcome.then(() => { throw new Error('command returned before the final write') })])
      await nextTurn()
      assert.equal(exitChecks.length, 0, 'final process check started before the last write was acknowledged')
      assert.equal(returned, false, 'command returned before its last write was acknowledged')
      await assert.rejects(access(stopped), { code: 'ENOENT' })
      failWrite()
      const error = await outcome
      if (status === 0) assert.equal((error as NodeJS.ErrnoException)?.code, 'EPIPE')
      else assert.match(error?.message ?? '', /exited with 37/)
      assert.ok(exitChecks.includes(true), 'did not observe the final process check after acknowledgement')
    }, async () => {
      failWrite()
      await outcome
      await access(stopped)
      if (await realpath(dir) !== dir || dirname(dir) !== temp) throw new Error(`Fixture path changed: ${dir}`)
      await rm(dir, { recursive: true })
    })
  })
}

test('a POSIX payload interrupted by SIGINT reports 130 and does not continue', { skip: process.platform === 'win32' }, async () => {
  const temp = await realpath(tmpdir()), dir = await mkdtemp(join(temp, 'vargus-interrupt-'))
  const env = { ...process.env, VARGUS_CLAUDE_FIXTURE: basename(dir) }, stopped = join(dir, 'stopped')
  const marker = join(dir, 'continued'), write = 'printf reached >continued'
  await withCleanup(async () => {
    await runFixtureCommand(write, dir, env, stopped)
    assert.equal(await readFile(marker, 'utf8'), 'reached')
    await rm(marker)
    await assert.rejects(runFixtureCommand(`kill -s INT "$$"; ${write}`, dir, env, stopped), /exited with 130/)
    await assert.rejects(access(marker), { code: 'ENOENT' })
  }, async () => {
    await access(stopped)
    if (await realpath(dir) !== dir || dirname(dir) !== temp) throw new Error(`Fixture path changed: ${dir}`)
    await rm(dir, { recursive: true })
  })
})

test('Windows checks marked processes and reports command status without certifying the whole tree', { skip: process.platform !== 'win32' }, async () => {
  const temp = await realpath(tmpdir()), dir = await mkdtemp(join(temp, 'vargus runner-'))
  const marker = basename(dir), stopped = join(dir, 'stopped'), ran = join(dir, 'ran with spaces')
  const env = { ...process.env, VARGUS_CLAUDE_FIXTURE: marker, TMP: dir, TEMP: dir, TMPDIR: dir }
  const command = 'ver >nul && >"ran with spaces" echo first& >>"ran with spaces" echo second'
  const blocker = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', marker], { cwd: dir, env, windowsHide: true, stdio: 'ignore' })
  const closed = new Promise<void>(resolve => blocker.once('close', () => resolve()))
  await withCleanup(async () => {
    await once(blocker, 'spawn')
    await writeFile(stopped, 'stale')
    await assert.rejects(runFixtureCommand(command, dir, env, stopped), new RegExp(`Fixture processes still active: ${blocker.pid} `))
    await assert.rejects(access(stopped), { code: 'ENOENT' })
    await assert.rejects(access(ran), { code: 'ENOENT' })
    blocker.kill()
    await closed
    await runFixtureCommand(command, dir, env, stopped)
    assert.equal(await readFile(ran, 'utf8'), 'first\r\nsecond\r\n')
    await assert.rejects(access(stopped), { code: 'ENOENT' })
    await assert.rejects(runFixtureCommand('exit /b 37', dir, env, stopped), /exited with 37/)
    await assert.rejects(runFixtureCommand('for /l %n in (1,1,2147483647) do @rem wait', dir, env, stopped, 150), /timed out/)
  }, async () => {
    blocker.kill()
    await closed
    if (await realpath(dir) !== dir || dirname(dir) !== temp) throw new Error(`Fixture path changed: ${dir}`)
    await rm(dir, { recursive: true })
  })
})

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
