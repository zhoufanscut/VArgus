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
