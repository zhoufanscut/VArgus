import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Views, footerThread, footerCandidates, hiddenDraft, type ViewScreen } from '../../src/hosts/codex/views'
import { codexComposer } from '../../src/hosts/codex/footer'

const screen = (footer: string, composer = 'Viewing sub-agent — direct input is disabled'): ViewScreen => ({
  lines: ['old transcript mentions `/root/first`', '› ' + (['Ask Codex to do anything', 'Viewing sub-agent — direct input is disabled'].includes(composer)
    ? '\x1b[2m' + composer + '\x1b[0m' : composer), '', '  ' + footer], x: 2, y: 1, visible: true, command: 'codex',
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
    assert.equal(views.selected(screen('Main [default] · ← for agents', 'an existing draft'))?.thread, 'parent')
    assert.equal(views.selected(screen('`/root/first` · ← for agents', 'an existing draft'))?.thread, 'first')
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

test('unlabelled drafts retain unknown identity while footer and startup readers require empty input', () => {
  const parent = '01a1bdc7-7e98-7dd3-bfbf-0dd7710dcd91'
  const child = '01a1bdc7-869e-78d0-a59c-bac2ec7bd0ae'
  const foreign = '01a10000-0000-0000-0000-000000000000'
  const views = new Views('/unused', parent)
  views.known.set(parent, { thread: parent, file: '/parent', cwd: '/project' })
  views.known.set(child, { thread: child, parent, path: '/root/child', file: '/child', cwd: '/project' })
  const draft = (text: string[], cursor = text.length - 1, footer = ['  82% context left'], prefix = '\x1b[1m›\x1b[0m '): ViewScreen => ({
    lines: ['old submitted prompt', prefix + text[0], ...text.slice(1).map(line => '  ' + line), '', ...footer, '', ''],
    x: 2 + text[cursor]!.length, y: 1 + cursor, visible: true, command: 'codex',
  })
  for (const text of [['normal draft'], ['Ask Codex to do anything'], ['first line', 'second line'],
    ['long wrapped first line', 'wrapped continuation', 'last line'],
    ['draft', '', '`/root/child` · ← for agents', child, '100% context left'], ['/stat']]) {
    for (let cursor = 0; cursor < text.length; cursor++) {
      const current = draft(text, cursor)
      assert.equal(views.selected(current), undefined)
      assert.equal(hiddenDraft(current), true)
      assert.equal(codexComposer(current, ''), false, 'display recognition must not admit footer keys')
      assert.equal(footerThread(current), undefined, 'startup identity must still require empty input')
      assert.deepEqual(footerCandidates(current), [])
      assert.equal(views.selected({ ...current, x: 2 }), undefined, 'caret position cannot establish view identity')
    }
  }
  for (const prefix of ['\x1b[1;38;5;214m›\x1b[0m ', '\x1b[1;38;2;246;197;67m›\x1b[0m ']) {
    assert.equal(hiddenDraft(draft(['draft'], 0, undefined, prefix)), true)
  }
  assert.equal(hiddenDraft(draft(['printf draft'], 0, ['  Shell mode'], '\x1b[1;31m!\x1b[0m ')), true)
  assert.equal(views.selected(draft(['draft'], 0, ['  Shell mode'])), undefined)
  assert.equal(views.selected(draft(['draft'], 0, undefined, '\x1b[1m!\x1b[0m ')), undefined)
  assert.equal(views.selected(draft(['draft'], 0, ['  ' + child, '  82% context left']))?.thread, child)
  assert.equal(views.selected(draft(['draft'], 0, ['  ' + foreign, '  82% context left'])), undefined)
  assert.equal(hiddenDraft(draft(['draft'], 0, ['  ' + foreign, '  82% context left'])), false)
  const clipped = draft(['draft'], 0, ['  ' + parent + ' · model · ' + child.slice(0, 28) + '…', '  82% context left'])
  assert.equal(views.selected(clipped), undefined)
  assert.equal(hiddenDraft(clipped), false)
  assert.equal(views.selected(clipped, 'first')?.thread, parent)
  for (const prefix of ['\x1b[1;2m› \x1b[0m', '\x1b[1;7m›\x1b[0m ', '› ']) {
    assert.equal(views.selected(draft(['draft'], 0, undefined, prefix)), undefined, 'history and modal selection arrows are not live editors')
    assert.equal(hiddenDraft(draft(['draft'], 0, undefined, prefix)), false)
  }
  for (const placeholder of ['Ask Codex to d', 'Viewing sub-agent — d']) {
    const clipped = draft(['\x1b[2m' + placeholder + '\x1b[0m'])
    assert.equal(views.selected({ ...clipped, x: 2 }), undefined, 'a clipped dim placeholder is not a draft')
    assert.equal(hiddenDraft({ ...clipped, x: 2 }), false)
  }
  const current = draft(['draft'])
  assert.equal(views.selected({ ...current, visible: false }), undefined)
  assert.equal(hiddenDraft({ ...current, visible: false }), false)
  assert.equal(views.selected({ ...current, command: 'bash' }), undefined)
  assert.equal(hiddenDraft({ ...current, command: 'bash' }), false)
  assert.equal(views.selected(draft(['draft'], 0, ['  unrelated dialog'])), undefined)
  assert.equal(views.selected(draft(['Ask Codex to do anything'], 0, ['  unrelated dialog'])), undefined,
    'typing placeholder words is not evidence of an empty primary editor, even without the draft hint')
})
