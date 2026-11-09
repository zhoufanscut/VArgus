import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Views, type ViewScreen } from '../../src/hosts/codex/views'

const screen = (footer: string, composer = 'Viewing sub-agent — direct input is disabled'): ViewScreen => ({
  lines: ['old transcript mentions `/root/first`', '› ' + composer, '', '  ' + footer], x: 2, y: 1, visible: true, command: 'codex',
})
test('view identity uses the contextual footer and known family, rejecting missing, truncated and ambiguous paths', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vargus-views-'))
  await mkdir(join(home, 'sessions'))
  const write = async (id: string, parent?: string, path?: string) => writeFile(join(home, 'sessions', `rollout-${id}.jsonl`), JSON.stringify({
    type: 'session_meta', payload: { id, cwd: '/project', source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent, agent_path: path } } } : 'cli' },
  }) + '\n')
  try {
    const views = new Views(home, 'parent')
    await write('parent'); await views.refresh()
    assert.equal(views.selected(screen('? for shortcuts', 'Ask Codex to do anything'))?.thread, 'parent')
    await write('first', 'parent', '/root/first')
    await write('second', 'parent', '/root/second')
    await write('nested', 'first', '/root/first/nested')
    await write('foreign', 'other', '/root/first')
    await views.refresh()
    assert.equal(views.family().length, 4)
    assert.equal(views.selected(screen('? for shortcuts', 'Ask Codex to do anything'))?.thread, 'parent')
    assert.equal(views.selected(screen('`/root/first` · ← for agents'))?.thread, 'first')
    assert.equal(views.selected(screen('`/root/second` · ← for agents'))?.thread, 'second')
    assert.equal(views.selected(screen('`/root/first/nested` · ← for agents'))?.thread, 'nested')
    assert.equal(views.selected(screen('Main [default] · ← for agents', 'Ask Codex to do anything'))?.thread, 'parent')
    for (const footer of ['`/root/first…', '`/unknown`', 'for shortcuts', '']) assert.equal(views.selected(screen(footer)), undefined)
    assert.equal(views.selected({ ...screen('`/root/first`'), command: 'bash' }), undefined)
    assert.equal(views.selected({ ...screen('`/root/first`'), visible: false }), undefined)
    assert.equal(views.selected({ ...screen('`/root/first`'), lines: ['picker', 'not a composer'] }), undefined)
    await write('reused-path', 'parent', '/root/first'); await views.refresh()
    assert.equal(views.selected(screen('`/root/first` · ← for agents')), undefined)
  } finally { await rm(home, { recursive: true, force: true }) }
})


test('known first-item IDs survive clipping; tail IDs require a complete footer', () => {
  const parent = '01a1bdc7-7e98-7dd3-bfbf-0dd7710dcd91'
  const child = '01a1bdc7-869e-78d0-a59c-bac2ec7bd0ae'
  const other = '01a10000-0000-0000-0000-000000000000'
  const views = new Views('/unused', parent)
  views.known.set(parent, { thread: parent, file: '/parent', cwd: '/project' })
  views.known.set(child, { thread: child, parent, path: '/root/child', file: '/child', cwd: '/project' })
  views.known.set(other, { thread: other, file: '/foreign', cwd: '/project' })
  const current = (id: string): ViewScreen => ({ ...screen(id + ' · model · project'),
    lines: ['chat ' + parent, '› \x1b[2mViewing sub-agent — direct input is disabled\x1b[0m', '',
      '  ' + id + ' · model · project', '  ← for agents · ? for shortcuts'] })
  assert.equal(views.selected(current(child))?.thread, child)
  const tail = current(child)
  tail.lines[3] = '  Sol · project · ' + child
  assert.equal(views.selected(tail)?.thread, child)
  tail.lines[3] = '  ' + parent + ' · ' + child
  assert.equal(views.selected(tail), undefined, 'multiple UUID fields cannot fall back to the root')
  assert.equal(views.selected(current(other)), undefined, 'a full foreign ID must not fall back to a root or path')
  const collision = current(parent)
  collision.lines[3] = '  ' + parent + ' · Sol · ' + child.slice(0, 28) + '…'
  assert.equal(views.selected(collision), undefined, 'clipping cannot substitute a UUID branch for the selected view')
  collision.lines[3] = '  ' + child + ' · crowded…'
  assert.equal(views.selected(collision, 'first')?.thread, child)
  const unconfigured = current(parent)
  unconfigured.lines[3] = '  ' + parent + ' · `/root/child`'
  assert.equal(views.selected(unconfigured, 'none')?.thread, child, 'an unconfigured ID field cannot override the real agent path')
  assert.equal(views.selected(current(child.slice(0, 28) + '…')), undefined)
})


test('the reported root transcript is pinned when old and session-suffixed logs coexist', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-view-alias-'))
  try {
    await mkdir(join(dir, 'sessions'))
    const old = join(dir, 'sessions', 'rollout-z-parent.jsonl')
    const current = join(dir, 'sessions', 'rollout-a-parent_11111111-1111-1111-1111-111111111111.jsonl')
    const record = (cwd: string) => JSON.stringify({ type: 'session_meta', payload: { id: 'parent', cwd, source: 'cli' } }) + '\n'
    await writeFile(old, record('/old')); await writeFile(current, record('/current'))
    const views = new Views(dir, 'parent', current)
    await views.refresh(); assert.equal(views.known.get('parent')?.file, current)
    assert.equal(views.known.get('parent')?.cwd, '/current')
    await views.refresh(); assert.equal(views.known.get('parent')?.file, current)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
