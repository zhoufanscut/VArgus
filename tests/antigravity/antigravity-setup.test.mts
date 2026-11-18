import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { installAntigravity } from '../../src/cli/antigravity-setup.ts'

const installed = { type: 'command', command: 'vargus statusline', enabled: true }

test('Antigravity setup creates private settings and a repeat install leaves them intact', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vargus-agy-install-'))
  const path = join(home, '.gemini', 'antigravity-cli', 'settings.json')
  try {
    assert.equal(await installAntigravity(path), 0)
    const first = await readFile(path, 'utf8')
    assert.deepEqual(JSON.parse(first), { statusLine: installed })
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.equal(await installAntigravity(path), 0)
    assert.equal(await readFile(path, 'utf8'), first)
    assert.deepEqual(await readdir(dirname(path)), ['settings.json'])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Antigravity setup merges into existing settings and keeps status line display options', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vargus-agy-merge-'))
  const path = join(home, 'settings.json')
  const existing = { model: 'test-model', permissions: { deny: ['command(test)'] } }
  const display = { padding: 2, stack_with_default: true }
  try {
    await writeFile(path, JSON.stringify({ ...existing, statusLine: { ...display, enabled: false } }))
    assert.equal(await installAntigravity(path), 0)
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { ...existing, statusLine: { ...display, ...installed } })

    await writeFile(path, JSON.stringify({ ...existing, statusLine: false }))
    assert.equal(await installAntigravity(path), 0)
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { ...existing, statusLine: installed })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Antigravity setup preserves an existing VArgus invocation and protects other commands', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vargus-agy-existing-'))
  const path = join(home, 'settings.json')
  const settings = (command: string) => JSON.stringify({ statusLine: { command, enabled: false } })
  try {
    const existing = settings('"$HOME/.local/bin/vargus" statusline --config "/some path/options.json"')
    await writeFile(path, existing)
    assert.equal(await installAntigravity(path), 0)
    assert.equal(await readFile(path, 'utf8'), existing)

    for (const command of ['echo "vargus statusline"', 'vargus statusline | other-program']) {
      const other = settings(command)
      await writeFile(path, other)
      await assert.rejects(installAntigravity(path), /A different statusLine command is configured/)
      assert.equal(await readFile(path, 'utf8'), other)
    }

    const invalid = '{\n'
    await writeFile(path, invalid)
    await assert.rejects(installAntigravity(path), /Could not parse JSON/)
    assert.equal(await readFile(path, 'utf8'), invalid)
    assert.deepEqual(await readdir(home), ['settings.json'])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Antigravity setup updates a symlinked settings file in place', { skip: process.platform === 'win32' }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'vargus-agy-linked-'))
  const path = join(home, '.gemini', 'antigravity-cli', 'settings.json')
  const target = join(home, 'linked-settings.json')
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(target, '{"workspace":"test-workspace"}')
    await symlink(target, path)
    assert.equal(await installAntigravity(path), 0)
    assert.ok((await lstat(path)).isSymbolicLink())
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { workspace: 'test-workspace', statusLine: installed })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
