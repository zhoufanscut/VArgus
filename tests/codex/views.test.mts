import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { Views, selectedView, footerThread, footerCandidates, readingHold, type ViewScreen } from '../../src/hosts/codex/views.ts'
import { codexComposer } from '../../src/hosts/codex/footer.ts'

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

test('configured titles and branches cannot replace the contextual agent label', () => {
  const views = new Views('/unused', 'parent')
  views.known.set('parent', { thread: 'parent', file: '/parent', cwd: '/project' })
  views.known.set('first', { thread: 'first', parent: 'parent', path: '/root/first', file: '/first', cwd: '/project' })
  views.known.set('second', { thread: 'second', parent: 'parent', path: '/root/second', file: '/second', cwd: '/project' })
  for (const title of ['Fix `parser.ts` now', 'Review `/root/first` details', '`/root/first`', '`/unknown`']) {
    assert.equal(views.selected(screen(title + ' · Main [default] · ← for agents', 'Ask Codex to do anything'), 'none')?.thread, 'parent')
    assert.equal(views.selected(screen(title + ' · `/root/second` · ← for agents'), 'none')?.thread, 'second')
    const separate = screen(title, 'Ask Codex to do anything')
    separate.lines.push('  Main [default] · ← for agents')
    assert.equal(views.selected(separate, 'none')?.thread, 'parent')
  }
  assert.equal(views.selected(screen('`/root/first`', 'Ask Codex to do anything'), 'none')?.thread, 'parent',
    'a saved title alone cannot establish a child identity')
  assert.equal(views.selected(screen('Review `/root/first` details · `/unknown` · ← for agents'), 'none'), undefined)
})

test('right-aligned agent labels still identify the view after the native footer clears', () => {
  const parent = 'parent', child = 'child', foreign = '01a10000-0000-0000-0000-000000000000'
  const family = [{ thread: parent }, { thread: child, path: '/root/child' }]
  const footer = '← for agents · ? for shortcuts     `/root/child` · 100% context left'
  const current = screen(footer)
  assert.equal(codexComposer(current, ''), true)
  assert.equal(selectedView(current, family, parent, 'first')?.thread, child)
  assert.equal(selectedView(screen(footer.replace('     ', ' ')), family, parent, 'none')?.thread, child)
  assert.equal(selectedView(screen(footer.replace('/root/child', '/root/chi…')), family, parent), undefined)
  assert.equal(selectedView(screen('Review     `/root/child` · 100% context left'), family, parent), undefined)
  current.lines.splice(3, 0, '  ' + foreign + ' · model')
  assert.equal(selectedView(current, family, parent, 'first'), undefined)
})

test('side chat and its draft can keep readings without selecting a thread or admitting footer commands', () => {
  const parent = 'parent', child = '01a10000-0000-0000-0000-000000000000'
  const family = [{ thread: parent }, { thread: child, path: '/root/child' }]
  const arrow = '\x1b[1m›\x1b[0m '
  const side: ViewScreen = {
    lines: [arrow + '\x1b[2mAsk a follow-up question\x1b[0m', '', '  ' + child + ' · `/root/child` · ← for agents'],
    x: 2, y: 0, visible: true, command: 'codex',
  }
  const draft = { ...side, lines: [arrow + 'side draft', '', side.lines[2]!,
    '  ? for shortcuts · Side from main thread · ^/ to switch · ^c to close'] }
  for (const current of [side, draft]) {
    assert.equal(readingHold(current), 'side')
    assert.equal(selectedView(current, family, parent, 'first'), undefined)
    assert.equal(codexComposer(current, ''), false)
    assert.deepEqual(footerCandidates(current), [])
    assert.equal(readingHold({ ...current, visible: false }), undefined)
  }
  const typedPlaceholder = { ...side, lines: [arrow + 'Ask a follow-up question'] }
  assert.equal(readingHold(typedPlaceholder), undefined)
})

test('restoration uses full IDs across roots while path labels remain family-local', () => {
  const first = '01a1bdc7-7e98-7dd3-bfbf-0dd7710dcd91', foreign = '01a1bdc7-869e-78d0-a59c-bac2ec7bd0ae'
  const views = new Views('/unused', 'parent')
  views.known.set('parent', { thread: 'parent', file: '/parent', cwd: '/project' })
  views.known.set(first, { thread: first, parent: 'parent', path: '/root/first', file: '/first', cwd: '/project' })
  views.known.set(foreign, { thread: foreign, parent: 'other', path: '/root/first', file: '/foreign', cwd: '/project' })
  const candidates = views.restoreCandidates([first, foreign])
  assert.equal(selectedView(screen('`/root/first` · ← for agents'), candidates, views.root, 'none')?.thread, first)
  assert.equal(selectedView(screen(foreign + ' · model'), candidates, views.root)?.thread, foreign)
  assert.equal(selectedView(screen('`/root/first` · ← for agents'), views.restoreCandidates([foreign]), views.root, 'none'), undefined)
  assert.equal(views.known.get(foreign)?.path, '/root/first', 'candidate projection leaves saved metadata unchanged')
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
      assert.equal(readingHold(current), 'draft')
      assert.equal(codexComposer(current, ''), false, 'display recognition must not admit footer keys')
      assert.equal(footerThread(current), undefined, 'startup identity must still require empty input')
      assert.deepEqual(footerCandidates(current), [])
      assert.equal(views.selected({ ...current, x: 2 }), undefined, 'caret position cannot establish view identity')
    }
  }
  for (const prefix of ['\x1b[1;38;5;214m›\x1b[0m ', '\x1b[1;38;2;246;197;67m›\x1b[0m ']) {
    assert.equal(readingHold(draft(['draft'], 0, undefined, prefix)), 'draft')
  }
  assert.equal(readingHold(draft(['printf draft'], 0, ['  Shell mode'], '\x1b[1;31m!\x1b[0m ')), 'draft')
  assert.equal(views.selected(draft(['draft'], 0, ['  Shell mode'])), undefined)
  assert.equal(views.selected(draft(['draft'], 0, undefined, '\x1b[1m!\x1b[0m ')), undefined)
  assert.equal(views.selected(draft(['draft'], 0, ['  ' + child, '  82% context left']))?.thread, child)
  assert.equal(views.selected(draft(['draft'], 0, ['  ' + foreign, '  82% context left'])), undefined)
  assert.equal(readingHold(draft(['draft'], 0, ['  ' + foreign, '  82% context left'])), undefined)
  const clipped = draft(['draft'], 0, ['  ' + parent + ' · model · ' + child.slice(0, 28) + '…', '  82% context left'])
  assert.equal(views.selected(clipped), undefined)
  assert.equal(readingHold(clipped), undefined)
  assert.equal(views.selected(clipped, 'first')?.thread, parent)
  for (const prefix of ['\x1b[1;2m› \x1b[0m', '\x1b[1;7m›\x1b[0m ', '› ']) {
    assert.equal(views.selected(draft(['draft'], 0, undefined, prefix)), undefined, 'history and modal selection arrows are not live editors')
    assert.equal(readingHold(draft(['draft'], 0, undefined, prefix)), undefined)
  }
  for (const placeholder of ['Ask Codex to d', 'Viewing sub-agent — d']) {
    const clipped = draft(['\x1b[2m' + placeholder + '\x1b[0m'])
    assert.equal(views.selected({ ...clipped, x: 2 }), undefined, 'a clipped dim placeholder is not a draft')
    assert.equal(readingHold({ ...clipped, x: 2 }), undefined)
  }
  const current = draft(['draft'])
  assert.equal(views.selected({ ...current, visible: false }), undefined)
  assert.equal(readingHold({ ...current, visible: false }), undefined)
  assert.equal(views.selected({ ...current, command: 'bash' }), undefined)
  assert.equal(readingHold({ ...current, command: 'bash' }), undefined)
  assert.equal(views.selected(draft(['draft'], 0, ['  unrelated dialog'])), undefined)
  assert.equal(views.selected(draft(['Ask Codex to do anything'], 0, ['  unrelated dialog'])), undefined,
    'typing placeholder words is not evidence of an empty primary editor, even without the draft hint')
})

test('native warning notices retain draft readings without admitting footer commands or startup identity', async () => {
  // Bottom of the official Codex 0.167.0 frame that blanked the row while typing.
  const captured: ViewScreen = JSON.parse(await readFile(new URL('./fixtures/codex-warning-draft.json', import.meta.url), 'utf8'))
  const parent = 'parent', foreign = '01a10000-0000-0000-0000-000000000000'
  for (const notice of ['', '⚠ 1 warning · \x1b[1mf2\x1b[0m to view', '⚠ 2 warnings · /warnings to view',
    '⚠ 3 · ctrl+w', '⚠ 4', '· ⚠ 1 warning · \x1b[1mf2\x1b[0m to view', '· ⚠ 2 warnings · /warnings to view', '· ⚠ 3 · ctrl+w', '· ⚠ 4']) {
    for (const shell of [false, true]) {
      const current = structuredClone(captured)
      current.lines[current.lines.length - 1] = current.lines.at(-1)!.replace(/⚠.*$/, notice)
      if (shell) {
        current.lines[current.y] = current.lines[current.y]!.replace('›', '!')
        current.lines[current.lines.length - 1] = current.lines.at(-1)!.replace('82% context left', 'Shell mode')
      }
      const detail = JSON.stringify({ notice, shell })
      assert.equal(readingHold(current), 'draft', detail)
      assert.equal(selectedView(current, [{ thread: parent }], parent), undefined, detail)
      assert.equal(codexComposer(current, ''), false, detail)
      assert.equal(footerThread(current), undefined, detail)
      assert.deepEqual(footerCandidates(current), [], detail)
      for (const metadata of [foreign, '`/root/child…']) {
        const explicit = structuredClone(current)
        explicit.lines.splice(explicit.lines.length - 1, 0, '  ' + metadata)
        assert.equal(readingHold(explicit), undefined, detail + ' ' + metadata)
        assert.equal(selectedView(explicit, [{ thread: parent }], parent), undefined, detail + ' ' + metadata)
      }
    }
  }
})


test('context percentages separated from an agent label retain draft identity', async () => {
  // Composer and footer captured from official Codex 0.169.0 before submission.
  const captured: ViewScreen = JSON.parse(await readFile(new URL('./fixtures/codex-main-draft.json', import.meta.url), 'utf8'))
  const parent = 'parent', child = 'child', foreign = '01a10000-0000-0000-0000-000000000000'
  const family = [{ thread: parent }, { thread: child, path: '/root/child' }]
  assert.equal(selectedView(captured, family, parent)?.thread, parent)
  assert.equal(readingHold(captured), undefined, 'a visible Main label selects current readings')
  assert.equal(codexComposer(captured, ''), false, 'recognizing a draft never admits footer commands')
  assert.equal(footerThread(captured), undefined)
  assert.deepEqual(footerCandidates(captured), [])
  for (const label of ['Main [default]', '`/root/child`']) {
    for (const separator of [' · ', '    ']) {
      for (const notice of ['', '    ⚠ 1 warning · f2 to view', ' · ⚠ 2 warnings · /warnings to view', ' · ⚠ 3 · ctrl+w', ' · ⚠ 4']) {
        const current = structuredClone(captured)
        current.lines[current.lines.length - 1] = '  ' + label + separator + '68% context left' + notice
        assert.equal(selectedView(current, family, parent)?.thread, label === 'Main [default]' ? parent : child)
        assert.equal(codexComposer(current, ''), false)
      }
    }
  }
  const titled = structuredClone(captured)
  titled.lines[titled.lines.length - 1] = '  `/root/child` · Main [default] · 68% context left'
  assert.equal(selectedView(titled, family, parent, 'none')?.thread, parent, 'the final label wins over a quoted title')
  const unknown = structuredClone(captured)
  unknown.lines[unknown.lines.length - 1] = '  `/root/unknown` · 68% context left'
  assert.equal(selectedView(unknown, family, parent), undefined)
  const clipped = structuredClone(captured)
  clipped.lines[clipped.lines.length - 1] = '  `/root/chi…` · 68% context left'
  assert.equal(selectedView(clipped, family, parent), undefined)
  const explicit = structuredClone(captured)
  explicit.lines[explicit.lines.length - 1] = '  ' + foreign + ' · Main [default] · 68% context left'
  assert.equal(selectedView(explicit, family, parent), undefined, 'a foreign ID still blocks Main fallback')
})

test('descendants returns proper subtree views with cycle safety and excludes foreign roots', () => {
  const views = new Views('/unused', 'root')
  // Insert out of topological order to verify fixed-point closure.
  views.known.set('deep', { thread: 'deep', parent: 'nested', path: '/root/first/nested/deep', file: '/deep', cwd: '/project' })
  views.known.set('nested', { thread: 'nested', parent: 'first', path: '/root/first/nested', file: '/nested', cwd: '/project' })
  views.known.set('first', { thread: 'first', parent: 'root', path: '/root/first', file: '/first', cwd: '/project' })
  views.known.set('second', { thread: 'second', parent: 'root', path: '/root/second', file: '/second', cwd: '/project' })
  views.known.set('root', { thread: 'root', file: '/root', cwd: '/project' })
  views.known.set('other', { thread: 'other', file: '/other', cwd: '/project' })
  views.known.set('foreign', { thread: 'foreign', parent: 'other', path: '/root/first', file: '/foreign', cwd: '/project' })

  const ids = (list: { thread: string }[]) => new Set(list.map(v => v.thread))
  assert.deepEqual(ids(views.descendants('root')), new Set(['first', 'second', 'nested', 'deep']))
  assert.deepEqual(ids(views.family()), new Set(['root', 'first', 'second', 'nested', 'deep']))
  assert.deepEqual(ids(views.descendants('first')), new Set(['nested', 'deep']))
  assert.deepEqual(ids(views.descendants('nested')), new Set(['deep']))
  assert.deepEqual(views.descendants('second'), [])
  assert.deepEqual(views.descendants('missing'), [])

  // Self-loop and mutual cycles terminate and never include the queried thread itself.
  const cyclic = new Views('/unused', 'root')
  cyclic.known.set('root', { thread: 'root', parent: 'child', file: '/root', cwd: '/project' })
  cyclic.known.set('child', { thread: 'child', parent: 'root', file: '/child', cwd: '/project' })
  cyclic.known.set('grand', { thread: 'grand', parent: 'child', file: '/grand', cwd: '/project' })
  cyclic.known.set('self', { thread: 'self', parent: 'self', file: '/self', cwd: '/project' })
  cyclic.known.set('cycA', { thread: 'cycA', parent: 'cycB', file: '/a', cwd: '/project' })
  cyclic.known.set('cycB', { thread: 'cycB', parent: 'cycA', file: '/b', cwd: '/project' })
  assert.deepEqual(ids(cyclic.descendants('root')), new Set(['child', 'grand']))
  assert.deepEqual(ids(cyclic.family()), new Set(['root', 'child', 'grand']))
  assert.deepEqual(ids(cyclic.descendants('child')), new Set(['root', 'grand']))
  assert.deepEqual(cyclic.descendants('self'), [])
  assert.deepEqual(ids(cyclic.descendants('cycA')), new Set(['cycB']))
})

test('Views discovers compressed .jsonl.zst logs, handles same-stem transitions and skips corrupt or disabled compressed logs', async t => {
  const home = await mkdtemp(join(tmpdir(), 'vargus-views-zst-'))
  const sessions = join(home, 'sessions')
  await mkdir(sessions)
  const metaLine = (id: string, parent?: string, path?: string) => JSON.stringify({
    type: 'session_meta',
    payload: { id, cwd: '/project', source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent, agent_path: path } } } : 'cli' },
  }) + '\n'
  const origZstd = zlib.createZstdDecompress
  let decompressCalls = 0
  const spy = t.mock.method(zlib, 'createZstdDecompress', (...args: Parameters<typeof origZstd>) => {
    decompressCalls++
    return Reflect.apply(origZstd, zlib, args)
  })
  syncBuiltinESMExports()
  try {
    const parentFile = join(sessions, 'rollout-parent.jsonl')
    const childPlain = join(sessions, 'rollout-child.jsonl')
    const childZst = join(sessions, 'rollout-child.jsonl.zst')
    const coldZst = join(sessions, 'rollout-cold.jsonl.zst')
    const corruptZst = join(sessions, 'rollout-corrupt.jsonl.zst')
    const corruptPayloadZst = join(sessions, 'rollout-corrupt-payload.jsonl.zst')

    await writeFile(parentFile, metaLine('parent'))
    await writeFile(childPlain, metaLine('child', 'parent', '/root/child'))
    await writeFile(coldZst, zlib.zstdCompressSync(Buffer.from(metaLine('cold', 'parent', '/root/cold'))))
    await writeFile(corruptZst, Buffer.from('not valid zstd bytes\n'))
    const badChecksumMeta = Buffer.from(zlib.zstdCompressSync(
      Buffer.from(metaLine('bad-checksum', 'parent', '/root/bad').trimEnd()),
      { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } },
    ))
    badChecksumMeta[badChecksumMeta.length - 1]! ^= 0xff
    await writeFile(corruptPayloadZst, badChecksumMeta)

    // 1. With includeCompressed = false, compressed files are neither discovered nor decompressed.
    const viewsOff = new Views(home, 'parent', parentFile)
    await viewsOff.refresh(false)
    assert.equal(decompressCalls, 0, 'refresh(false) must not decompress any .jsonl.zst file')
    assert.deepEqual(viewsOff.descendants('parent').map(v => v.thread), ['child'])

    // 2. Enabling compressed discovery on the same Views instance discovers cold.jsonl.zst once and skips corrupt.jsonl.zst.
    await viewsOff.refresh(true)
    const callsAfterFirstScan = decompressCalls
    assert.ok(callsAfterFirstScan >= 2, 'positive control: refresh(true) inspects compressed logs')
    assert.deepEqual(new Set(viewsOff.descendants('parent').map(v => v.thread)), new Set(['child', 'cold']))
    assert.equal(viewsOff.known.get('cold')?.file, coldZst)
    // Repeating refresh without file changes must not re-decompress either valid or corrupt .jsonl.zst.
    await viewsOff.refresh(true)
    assert.equal(decompressCalls, callsAfterFirstScan, 'unchanged valid and corrupt .jsonl.zst must not re-decompress')

    // 3. Coexisting same-stem .jsonl and .jsonl.zst counts once, prefers plain, and is not ambiguous.
    await writeFile(childZst, zlib.zstdCompressSync(Buffer.from(metaLine('child', 'parent', '/root/child'))))
    await viewsOff.refresh(true)
    assert.equal(decompressCalls, callsAfterFirstScan, 'coexisting .jsonl.zst is skipped while plain sibling exists')
    assert.equal(viewsOff.known.get('child')?.file, childPlain)

    // 4. Removing plain .jsonl transitions known child seamlessly to .jsonl.zst without ambiguity.
    await rm(childPlain)
    await viewsOff.refresh(true)
    assert.equal(viewsOff.known.get('child')?.file, childZst)
    assert.deepEqual(new Set(viewsOff.descendants('parent').map(v => v.thread)), new Set(['child', 'cold']))

    // 5. Coexist (.jsonl.zst already seen, then .jsonl appears, then .jsonl disappears): must re-adopt .jsonl.zst cleanly.
    await writeFile(childPlain, metaLine('child', 'parent', '/root/child'))
    await viewsOff.refresh(true)
    assert.equal(viewsOff.known.get('child')?.file, childPlain)
    await rm(childPlain)
    await viewsOff.refresh(true)
    assert.equal(viewsOff.known.get('child')?.file, childZst)

    // 6. Reverse transition (.jsonl.zst -> .jsonl with .zst removed) also updates cleanly without ambiguity.
    await writeFile(childPlain, metaLine('child', 'parent', '/root/child'))
    await rm(childZst)
    await viewsOff.refresh(true)
    assert.equal(viewsOff.known.get('child')?.file, childPlain)

    // 7. A different filename stem with the same thread ID IS ambiguous and removes the child.
    await writeFile(join(sessions, 'rollout-other-child.jsonl.zst'),
      zlib.zstdCompressSync(Buffer.from(metaLine('child', 'parent', '/root/child'))))
    await viewsOff.refresh(true)
    assert.equal(viewsOff.known.get('child'), undefined)
    assert.deepEqual(viewsOff.descendants('parent').map(v => v.thread), ['cold'])

    // 8. Under refresh(false), a live root .jsonl -> .jsonl.zst transition and a symlinked CODEX_HOME
    //    with a realpath-reported compressed root still resolve the root while skipping background children.
    const rootZst = join(sessions, 'rollout-parent.jsonl.zst')
    const liveOff = new Views(home, 'parent', await realpath(parentFile))
    await liveOff.refresh(false)
    assert.equal(liveOff.known.get('parent')?.file, parentFile)
    await writeFile(rootZst, zlib.zstdCompressSync(Buffer.from(metaLine('parent'))))
    await rm(parentFile)
    const callsBeforeRootLive = decompressCalls
    await liveOff.refresh(false)
    assert.equal(liveOff.known.get('parent')?.file, rootZst)
    assert.equal(liveOff.known.get('cold'), undefined)
    assert.equal(decompressCalls, callsBeforeRootLive + 1)

    if (process.platform !== 'win32') {
      const linkHome = join(home, 'link-home')
      await symlink(home, linkHome)
      const callsBeforeLink = decompressCalls
      const linkViews = new Views(linkHome, 'parent', await realpath(rootZst))
      await linkViews.refresh(false)
      assert.equal(linkViews.known.get('parent')?.file, join(linkHome, 'sessions', 'rollout-parent.jsonl.zst'))
      assert.equal(linkViews.known.get('cold'), undefined)
      assert.equal(decompressCalls, callsBeforeLink + 1)
    }
  } finally {
    spy.mock.restore()
    syncBuiltinESMExports()
    await rm(home, { recursive: true, force: true })
  }
})
