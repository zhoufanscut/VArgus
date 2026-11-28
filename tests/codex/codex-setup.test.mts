import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
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
  const run = (action: string) => main([action, 'codex', '--home', home])
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
    await assert.rejects(lstat(join(home, 'vargus', 'autostart')), { code: 'ENOENT' })
    await assert.rejects(lstat(join(home, 'vargus')), { code: 'ENOENT' })
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
    assert.equal(await main(['install', 'codex']), 0)
    assert.equal(await readFile(path, 'utf8'), raw)
    assert.equal(await main(['remove', 'codex']), 0)
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
  const autostart = join(home, 'vargus', 'autostart')
  const raw = JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'vargus hook session-start' }] }],
    UserPromptSubmit: [{ hooks: [
      { type: 'command', command: 'vargus hook prompt' },
      { type: 'command', command: 'another-program' },
    ] }],
  } })
  try {
    await mkdir(autostart, { recursive: true })
    await writeFile(path, raw)
    await assert.rejects(main(['remove', 'codex', '--home', home]), /UserPromptSubmit .* would move other callbacks/)
    assert.equal(await readFile(path, 'utf8'), raw)
    assert.ok((await stat(autostart)).isDirectory())
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Codex removal preserves sibling files in vargus/ and cleans up autostart even without hooks.json', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vargus-setup-autostart-'))
  const autostart = join(home, 'vargus', 'autostart')
  const sibling = join(home, 'vargus', 'keep.txt')
  try {
    await mkdir(autostart, { recursive: true })
    await writeFile(join(autostart, 'marker.off'), '')
    await writeFile(sibling, 'keep')
    assert.equal(await main(['remove', 'codex', '--home', home]), 0)
    await assert.rejects(lstat(autostart), { code: 'ENOENT' })
    assert.equal(await readFile(sibling, 'utf8'), 'keep')
    assert.deepEqual(await readdir(home), ['vargus'])

    await rm(sibling)
    await mkdir(autostart, { recursive: true })
    assert.equal(await main(['remove', 'codex', '--home', home]), 0)
    assert.deepEqual(await readdir(home), [])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Codex removal leaves symlinked vargus/autostart targets intact', { skip: process.platform === 'win32' }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'vargus-setup-symlink-'))
  const target = join(home, 'external-autostart')
  const vargusDir = join(home, 'vargus')
  const autostart = join(vargusDir, 'autostart')
  try {
    await mkdir(target)
    await writeFile(join(target, 'keep.off'), '')
    await mkdir(vargusDir)
    await symlink(target, autostart)
    assert.equal(await main(['remove', 'codex', '--home', home]), 0)
    assert.ok((await lstat(autostart)).isSymbolicLink())
    assert.deepEqual(await readdir(target), ['keep.off'])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
