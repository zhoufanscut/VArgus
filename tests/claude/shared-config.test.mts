import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { editOption } from '../../src/options.ts'
import { shellPath } from '../../src/hosts/claude/paths.ts'

test('Claude creates, cancels and commits shared edits, preserving a concurrent edit', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus shared options '))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'vargus.jsonc')
  const source = resolve('src/hosts/claude/replace-config.sh')
  function run(op: string, id: string, before?: string, after?: string, target = file, script = source) {
    const cmd = process.platform === 'win32' ? ['git', '-c', 'alias.vargus-save=!sh', 'vargus-save'] : ['sh']
    const args = [...cmd.slice(1), shellPath(script), op, shellPath(target), id]
    if (op === 'prepare' || op === 'save') args.push(String(before === undefined ? -1 : Buffer.byteLength(before)))
    const result = spawnSync(cmd[0]!, args, { input: (before ?? '') + (after ?? ''), encoding: 'utf8', timeout: 5000 })
    assert.ifError(result.error)
    return result.status
  }
  const first = '{ /* 保留 */ "theme": "claude-terracotta" }\n'
  assert.equal(run('prepare', 'first', undefined, first), 0)
  await assert.rejects(readFile(file), { code: 'ENOENT' })
  assert.equal(run('cancel', 'first'), 0)
  assert.deepEqual(await readdir(dir), [])
  assert.equal(run('prepare', 'first', undefined, first), 0)
  assert.equal(run('commit', 'first'), 0)
  assert.equal(await readFile(file, 'utf8'), first)
  const updated = editOption(first, 'theme', 'daylight')
  assert.equal(run('prepare', 'one', first, updated), 0)
  const manual = editOption(first, 'model', false)
  await writeFile(file, manual)
  assert.equal(run('commit', 'one'), 75)
  assert.equal(await readFile(file, 'utf8'), manual)
  const merged = editOption(manual, 'theme', 'daylight')
  assert.equal(run('prepare', 'retry', manual, merged), 0)
  assert.equal(run('commit', 'retry'), 0)
  assert.equal(await readFile(file, 'utf8'), merged)
  assert.deepEqual(await readdir(dir), ['vargus.jsonc'])
  assert.equal(shellPath('C:\\Users\\Pat Lee\\.claude'), 'C:/Users/Pat Lee/.claude')
  const profile = process.platform === 'win32' ? 'plugin data' : 'profile\\west'
  const backup = join(dir, profile, 'picker-backups.json')
  const writer = join(dir, process.platform === 'win32' ? 'private writer.sh' : 'private\\writer.sh')
  await copyFile(source, writer)
  assert.equal(run('save', 'new', undefined, first, backup, writer), 0)
  assert.equal(run('save', 'stale', undefined, updated, backup, writer), 75)
  assert.equal(await readFile(backup, 'utf8'), first)
  assert.equal(run('save', 'update', first, updated, backup, writer), 0)
  assert.equal(await readFile(backup, 'utf8'), updated)
  assert.deepEqual(await readdir(join(dir, profile)), ['picker-backups.json'])
})
