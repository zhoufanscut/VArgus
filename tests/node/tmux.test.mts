import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TmuxOutput } from '../../src/outputs/tmux/client.ts'

const exec = promisify(execFile)
async function rig() {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-tmux-test-'))
  const socket = join(dir, 'server')
  const run = async (...args: string[]) => (await exec('tmux', ['-S', socket, ...args], {
    env: { ...process.env, TMUX: '' },
  })).stdout.replace(/\n$/, '')
  await run('-f', '/dev/null', 'new-session', '-d', '-s', 'test', '-x', '157', '-y', '50', 'sleep 120')
  const pane = await run('display-message', '-p', '#{pane_id}')
  return { dir, socket, run, pane, root: join(dir, 'state'), async close() {
    await run('kill-server')
    await rm(dir, { recursive: true, force: true })
  } }
}

test('real tmux: preserve existing rows, select active-pane content, restore only after the last owner', { timeout: 15000 }, async () => {
  const r = await rig()
  const first = new TmuxOutput(r.socket, r.pane, r.root)
  let second: TmuxOutput | undefined
  try {
    await r.run('set-option', '-g', 'status', '2')
    await r.run('set-option', '-g', 'status-format[0]', 'original #{session_name}')
    await r.run('set-option', '-g', 'status-format[1]', 'second original row')
    const before = await r.run('show-options', '-t', 'test')
    await first.attach()
    assert.equal(await r.run('show-options', '-v', '-t', 'test', 'status'), '3')
    assert.equal(await r.run('show-options', '-v', '-t', 'test', 'status-format[1]'), 'original #{session_name}')
    assert.equal(await r.run('show-options', '-v', '-t', 'test', 'status-format[2]'), 'second original row')
    const other = await r.run('split-window', '-h', '-P', '-F', '#{pane_id}', '-t', r.pane, 'sleep 120')
    second = new TmuxOutput(r.socket, other, r.root)
    await second.attach()
    await first.update('first session')
    await second.update('second session')
    await r.run('select-pane', '-t', r.pane)
    assert.match(await r.run('display-message', '-p', '#{@vargus_line}'), /first session/)
    await r.run('select-pane', '-t', other)
    assert.match(await r.run('display-message', '-p', '#{@vargus_line}'), /second session/)
    await first.detach()
    assert.equal(await r.run('show-options', '-v', '-t', 'test', 'status'), '3')
    await second.detach()
    assert.equal(await r.run('show-options', '-t', 'test'), before)
  } finally { await first.detach(); await second?.detach(); await r.close() }
})

test('real tmux: a user edit made while the row is active survives shutdown', { timeout: 15000 }, async () => {
  const r = await rig()
  const output = new TmuxOutput(r.socket, r.pane, r.root)
  try {
    await output.attach()
    await r.run('set-option', '-t', 'test', 'status-format[0]', 'my newer bar')
    await output.detach()
    assert.equal(await r.run('show-options', '-v', '-t', 'test', 'status-format[0]'), 'my newer bar')
  } finally { await output.detach(); await r.close() }
})

test('real tmux: maximum row count is rejected without changing session options', { timeout: 15000 }, async () => {
  const r = await rig()
  const output = new TmuxOutput(r.socket, r.pane, r.root)
  try {
    await r.run('set-option', '-t', 'test', 'status', '5')
    const before = await r.run('show-options', '-t', 'test')
    await assert.rejects(output.attach(), /maximum status rows/)
    assert.equal(await r.run('show-options', '-t', 'test'), before)
  } finally { await output.detach(); await r.close() }
})

test('real tmux: reset refuses a live owner and restores an abandoned row after its owner exits', { timeout: 15000 }, async () => {
  const r = await rig()
  const output = new TmuxOutput(r.socket, r.pane, r.root)
  try {
    const before = await r.run('show-options', '-t', 'test')
    await output.attach()
    await assert.rejects(new TmuxOutput(r.socket, r.pane, r.root).reset(), /still running/)
    await output.detach()
    const module = new URL('../../src/outputs/tmux/client.ts', import.meta.url).href
    const code = `import { TmuxOutput } from ${JSON.stringify(module)};
      const o = new TmuxOutput(${JSON.stringify(r.socket)}, ${JSON.stringify(r.pane)}, ${JSON.stringify(r.root)});
      await o.attach(); await o.update('abandoned row');`
    await exec(process.execPath, ['--input-type=module', '-e', code])
    assert.equal(await r.run('show-options', '-v', '-t', 'test', 'status'), '2')
    await new TmuxOutput(r.socket, r.pane, r.root).reset()
    assert.equal(await r.run('show-options', '-t', 'test'), before)
  } finally { await output.detach(); await r.close() }
})

test('real tmux: explicit local formats and a hidden bar restore byte-for-byte', { timeout: 15000 }, async () => {
  const r = await rig()
  const output = new TmuxOutput(r.socket, r.pane, r.root)
  try {
    await r.run('set-option', '-t', 'test', 'status-format[0]', 'literal $HOME ; #{pane_id} "quoted" \\ path')
    await r.run('set-option', '-t', 'test', 'status', 'off')
    const before = await r.run('show-options', '-t', 'test')
    await output.attach()
    assert.equal(await r.run('show-options', '-v', '-t', 'test', 'status'), 'on')
    await output.detach()
    assert.equal(await r.run('show-options', '-t', 'test'), before)
  } finally { await output.detach(); await r.close() }
})

test('real concurrent processes can start and exit without losing the session lock', { timeout: 45000 }, async () => {
  const r = await rig()
  try {
    const before = await r.run('show-options', '-t', 'test')
    const module = new URL('../../src/outputs/tmux/client.ts', import.meta.url).href
    for (let batch = 0; batch < 3; batch++) {
      const panes: string[] = []
      for (let i = 0; i < 8; i++) panes.push(await r.run('new-window', '-d', '-P', '-F', '#{pane_id}', '-t', 'test', 'sleep 120'))
      const results = await Promise.allSettled(panes.map((pane, index) => {
        const code = `import { TmuxOutput } from ${JSON.stringify(module)};
          const o = new TmuxOutput(${JSON.stringify(r.socket)}, ${JSON.stringify(pane)}, ${JSON.stringify(r.root)});
          await o.attach(); await o.update('concurrent owner');
          await new Promise(r => setTimeout(r, ${index * 3})); await o.detach();`
        return exec(process.execPath, ['--input-type=module', '-e', code])
      }))
      for (const result of results) assert.equal(result.status, 'fulfilled', result.status === 'rejected' ? String(result.reason) : '')
      assert.equal(await r.run('show-options', '-t', 'test'), before)
    }
  } finally { await r.close() }
})
