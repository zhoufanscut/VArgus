import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vargus, { type OmoApi } from '../../src/hosts/omo/register.ts'
import { omo } from '../../src/cli/omo.ts'
import type { SessionEntry } from '../../src/hosts/omo/contracts.ts'

function host(mode = 'tui') {
  const entries: SessionEntry[] = []
  const handlers = new Map<string, (event: unknown, ctx: Context) => void>()
  type Context = Parameters<Parameters<OmoApi['on']>[1]>[1]
  let command: Parameters<OmoApi['registerCommand']>[1] | undefined
  let footerHidden = false
  let row: { render(width: number): string[]; invalidate(): void } | undefined
  let listeners = 0
  const ctx: Context = {
    mode, cwd: '/repo', model: { id: 'gpt-6.1-sol', provider: 'test' }, thinkingLevel: 'high',
    getContextUsage: () => ({ tokens: 250, contextWindow: 1000, percent: 25 }),
    sessionManager: {
      getSessionId: () => 'test-session',
      getEntry: id => entries.find(entry => entry.id === id),
      getHeader: () => ({ timestamp: '2026-11-14T00:00:00Z' }),
      reduceHistory: reducer => entries.reduce((state, entry) => reducer.add(state, entry), reducer.initial()),
    },
    ui: {
      setFooter(factory) { footerHidden = factory !== undefined },
      setWidget(_key, factory) { row = factory?.({ requestRender() {} }) },
      notify() {},
    },
  }
  // Disable Git for this UI lifecycle test; the real-repository suite owns Git.
  entries.push({ id: 'settings', type: 'custom', timestamp: '', customType: 'vargus-settings',
    data: { enabled: true, options: { repo: false, branch: false, status: false } } })
  const api: OmoApi = {
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    getSubscriptionLimits: () => [],
    onSubscriptionLimits() { listeners++; return () => { listeners-- } },
    appendEntry(customType, data) {
      entries.push({ id: String(entries.length), type: 'custom', timestamp: '', customType, data })
    },
    registerCommand(_name, value) { command = value },
  }
  return {
    load() { vargus(api) },
    event(name: string, event: unknown = {}) { handlers.get(name)?.(event, ctx) },
    append(entry: SessionEntry) { entries.push(entry) },
    async command(args: string) {
      assert.ok(command)
      await command.handler(args, ctx)
    },
    get hidden() { return footerHidden },
    get row() { return row },
    get listeners() { return listeners },
  }
}

test('OmO disable survives reload and stays isolated from another session', async () => {
  const first = host()
  const second = host()
  first.load(); second.load()
  first.event('session_start'); second.event('session_start')
  try {
    assert.equal(first.hidden, true)
    assert.equal(second.hidden, true)
    assert.match(first.row?.render(200).join('') ?? '', /sol/)
    await first.command('off')
    assert.equal(first.hidden, false)
    assert.equal(first.listeners, 0)
    assert.equal(second.hidden, true)
    first.event('session_shutdown')
    first.load(); first.event('session_start')
    assert.equal(first.hidden, false)
    assert.equal(first.row, undefined)
    await first.command('on')
    assert.equal(first.hidden, true)
    assert.equal(first.listeners, 1)
  } finally {
    first.event('session_shutdown'); second.event('session_shutdown')
  }
  assert.equal(first.hidden, false)
  assert.equal(second.hidden, false)
  assert.equal(first.listeners, 0)
  assert.equal(second.listeners, 0)
})

test('OmO configuration changes rendering and keeps a disabled session disabled', async () => {
  const h = host()
  h.load(); h.event('session_start')
  try {
    await h.command('config {"model":false}')
    assert.doesNotMatch(h.row?.render(200).join('') ?? '', /sol/)
    await h.command('off')
    await h.command('config {"model":true}')
    assert.equal(h.hidden, false)
    assert.equal(h.listeners, 0)
  } finally { h.event('session_shutdown') }
})

test('OmO leaves RPC and print surfaces untouched', async () => {
  for (const mode of ['rpc', 'print', 'json']) {
    const h = host(mode)
    h.load(); h.event('session_start')
    await h.command('on')
    assert.equal(h.hidden, false)
    assert.equal(h.row, undefined)
    assert.equal(h.listeners, 0)
    h.event('session_shutdown')
  }
})

test('native assistant edits preserve consumed tokens across live updates and reload', async () => {
  const h = host()
  const original: SessionEntry = {
    id: 'original', type: 'message', timestamp: '',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Original' }],
      usage: { input: 100, output: 20, cacheRead: 40 } },
  }
  const edited: SessionEntry = {
    id: 'edited', type: 'message', timestamp: '',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Edited' }],
      usage: { input: 100, output: 20, cacheRead: 40 } },
  }
  const text = () => h.row?.render(200).join('').replace(/\x1b\[[0-9;]*m/g, '') ?? ''
  h.append(original)
  h.load(); h.event('session_start')
  try {
    assert.match(text(), /token:120/)
    h.event('session_before_tree', { preparation: { targetId: 'original' } })
    h.append(edited)
    h.event('session_tree', { newLeafId: 'edited', oldLeafId: 'original' })
    assert.match(text(), /token:120/)
    h.event('session_shutdown')
    h.load(); h.event('session_start')
    assert.match(text(), /token:120/)
    // A navigation to an existing response, and another actual response with
    // identical usage, must not be mistaken for an edit.
    h.event('session_before_tree', { preparation: { targetId: 'original' } })
    h.event('session_tree', { newLeafId: 'original', oldLeafId: 'edited' })
    h.append({ ...original, id: 'second-response' })
    h.event('message_end')
    assert.match(text(), /token:240/)
  } finally { h.event('session_shutdown') }
})

test('portable OmO setup loads the real entry and removes only the owned loader', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-omo-install-'))
  try {
    const unrelated = join(dir, 'other.ts')
    await writeFile(unrelated, 'export default function () {}')
    await omo(['install', '--dir', dir])
    const loader = await readFile(join(dir, 'vargus.ts'), 'utf8')
    const spec = /from ("[^"]+");/.exec(loader)?.[1]
    assert.ok(spec)
    const entry = await import(JSON.parse(spec))
    assert.equal(entry.default, vargus)
    const oldEntry = new URL('../../extensions/omo.ts', import.meta.url).href
    await writeFile(join(dir, 'vargus.ts'),
      `// VArgus OmO native extension loader.\nexport { default } from ${JSON.stringify(oldEntry)};\n`)
    await omo(['install', '--dir', dir])
    assert.equal(await readFile(join(dir, 'vargus.ts'), 'utf8'), loader)
    await omo(['remove', '--dir', dir])
    assert.deepEqual(await readdir(dir), ['other.ts'])
    assert.equal(await readFile(unrelated, 'utf8'), 'export default function () {}')
    await writeFile(join(dir, 'vargus.ts'), 'unrelated user extension')
    await assert.rejects(omo(['install', '--dir', dir]), /unrelated or modified/)
    await assert.rejects(omo(['remove', '--dir', dir]), /unrelated or modified/)
    assert.equal(await readFile(join(dir, 'vargus.ts'), 'utf8'), 'unrelated user extension')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
