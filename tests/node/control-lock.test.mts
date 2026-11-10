import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { withControlLock } from '../../src/cli/lock.ts'

test('a cancelled control releases admission for later callers while a live caller retains exclusion', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-control-lock-test-')), lock = join(dir, 'request.lock')
  const script = `import { withControlLock } from ${JSON.stringify(pathToFileURL(resolve('src/cli/lock.ts')).href)};
    await withControlLock(${JSON.stringify(lock)}, async () => { console.log('LOCKED'); await new Promise(() => { setInterval(() => {}, 1000) }); });`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    const ready = await Promise.race([
      once(child.stdout, 'data').then(([chunk]) => String(chunk)),
      once(child, 'exit').then(([code]) => { throw new Error('Control fixture exited before lock acquisition: ' + code) }),
    ])
    assert.match(ready, /LOCKED/)
    let entered = false
    await assert.rejects(withControlLock(lock, async () => { entered = true }), /Another VArgus control is pending/)
    assert.equal(entered, false)
    const exit = once(child, 'exit')
    child.kill('SIGTERM'); await exit
    assert.equal(await withControlLock(lock, async () => 'recovered'), 'recovered')
    await assert.rejects(access(lock), { code: 'ENOENT' })
    // Ordinary action failures release the same ownership without hiding the error.
    await assert.rejects(withControlLock(lock, async () => { throw new Error('action failed') }), /action failed/)
    assert.equal(await withControlLock(lock, async () => 'retry'), 'retry')
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit }
    await rm(dir, { recursive: true, force: true })
  }
})
