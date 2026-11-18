import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../../src/cli.ts'

test('Codex setup installs and removes only its own callbacks in the selected home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vargus-setup-'))
  const config = 'model = "existing-model"\n[tui]\nstatus_line = ["model", "session-id"]\n'
  const other = { type: 'command', command: 'echo "vargus hook session-start"' }
  const existing = { description: 'keep this', hooks: {
    SessionStart: [{ matcher: 'startup', hooks: [other] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'another-program' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'stop-handler' }] }],
  } }
  const path = join(home, 'hooks.json')
  const run = (action: string) => main(['codex', action, '--home', home])
  try {
    await writeFile(join(home, 'config.toml'), config)
    await writeFile(path, JSON.stringify(existing))
    assert.equal(await run('install'), 0)
    const first = await readFile(path, 'utf8')
    const { description, hooks } = JSON.parse(first)
    assert.equal(description, existing.description)
    assert.deepEqual(hooks.Stop, existing.hooks.Stop)
    for (const [event, subcommand] of [
      ['SessionStart', 'session-start'], ['UserPromptSubmit', 'prompt'],
    ] as const) {
      assert.deepEqual(hooks[event][0], existing.hooks[event][0])
      assert.equal(hooks[event].length, 2)
      const [callback] = hooks[event][1].hooks
      assert.equal(callback.type, 'command')
      assert.match(callback.command, new RegExp(`[\\\\/]bin[\\\\/]vargus(?:\\.cmd)?['"] hook ${subcommand}$`))
      assert.equal(callback.async, true)
      assert.equal(callback.timeout, 30)
    }
    assert.equal(hooks.SessionStart[1].matcher, '^(startup|resume|clear|fork)$')
    assert.ok((await stat(join(home, 'vargus', 'autostart'))).isDirectory())
    assert.equal(await run('install'), 0)
    assert.equal(await readFile(path, 'utf8'), first)

    assert.equal(await run('remove'), 0)
    const removed = await readFile(path, 'utf8')
    assert.deepEqual(JSON.parse(removed), existing)
    assert.equal(await run('remove'), 0)
    assert.equal(await readFile(path, 'utf8'), removed)
    assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), config)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Codex setup reuses legacy callbacks and leaves other handlers in their groups', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vargus-setup-legacy-'))
  const home = join(root, 'codex home')
  const path = join(home, 'hooks.json')
  const previousHome = process.env.CODEX_HOME
  const other = { type: 'command', command: 'vargus statusline' }
  const start = { type: 'command', command: '"$HOME/.local/bin/vargus" hook session-start --config "/some path/options.json"' }
  const prompt = { type: 'command', command: "& 'C:\\My Tools\\vargus.cmd' hook prompt" }
  const config = { hooks: {
    SessionStart: [{ matcher: 'startup', hooks: [other, start] }],
    UserPromptSubmit: [{ hooks: [prompt] }, { hooks: [other] }],
  } }
  try {
    process.env.CODEX_HOME = home
    await mkdir(home)
    const raw = JSON.stringify(config)
    await writeFile(path, raw)
    assert.equal(await main(['codex', 'install']), 0)
    assert.equal(await readFile(path, 'utf8'), raw)
    assert.equal(await main(['codex', 'remove']), 0)
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { hooks: {
      SessionStart: [{ matcher: 'startup', hooks: [other] }],
      UserPromptSubmit: [{ hooks: [] }, { hooks: [other] }],
    } })
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})

test('Codex removal leaves both events intact when it would move a retained callback', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vargus-setup-mixed-'))
  const path = join(home, 'hooks.json')
  const raw = JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'vargus hook session-start' }] }],
    UserPromptSubmit: [{ hooks: [
      { type: 'command', command: 'vargus hook prompt' },
      { type: 'command', command: 'another-program' },
    ] }],
  } })
  try {
    await writeFile(path, raw)
    await assert.rejects(main(['codex', 'remove', '--home', home]), /UserPromptSubmit .* would move other callbacks/)
    assert.equal(await readFile(path, 'utf8'), raw)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
