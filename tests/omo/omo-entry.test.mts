import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, lstat, mkdir, mkdtemp, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises'
import { fixtureCheckout } from '../checkout.mts'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import vargus, { type OmoApi } from '../../src/hosts/omo/register.ts'
import { main } from '../../src/cli.ts'
import { detectWsl } from '../../src/node/wsl.ts'
import { collectOmoAgents, collectOmoSubagentSkills } from '../../src/hosts/omo/collect.ts'
import { OmoSubagents, projectStateKey } from '../../src/hosts/omo/subagents.ts'
import type { HistoryReducer, SessionEntry } from '../../src/hosts/omo/contracts.ts'
import { makeTheme } from '../../src/theme/index.ts'

function host(mode = 'tui', cwd = '/repo') {
  const entries: SessionEntry[] = []
  const handlers = new Map<string, (event: unknown, ctx: Context) => void>()
  type Context = Parameters<Parameters<OmoApi['on']>[1]>[1]
  let command: Parameters<OmoApi['registerCommand']>[1] | undefined
  let footerHidden = false
  let row: { render(width: number): string[]; invalidate(): void } | undefined
  let listeners = 0
  const ctx: Context = {
    modelRegistry: { getProviderAuth: async () => undefined },
    mode, cwd, model: { id: 'gpt-6.1-sol', provider: 'test' }, thinkingLevel: 'high',
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
    load(factory?: typeof vargus) {
      if (factory) factory(api)
      else vargus(api, {})
    },
    event(name: string, event: unknown = {}, nextCtx: Context = ctx) { handlers.get(name)?.(event, nextCtx) },
    append(entry: SessionEntry) { entries.push(entry) },
    async command(args: string) {
      assert.ok(command)
      await command.handler(args, ctx)
    },
    ctx,
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

test('OmO warns on a redraw after missed updates and clears the warning after recovery', t => {
  const h = host()
  let now = 1000
  t.mock.method(Date, 'now', () => now)
  const hadNoColor = 'NO_COLOR' in process.env
  const savedNoColor = process.env.NO_COLOR
  delete process.env.NO_COLOR
  const isWsl = detectWsl()
  const theme = makeTheme('omo-violet', false)
  const staleMark = isWsl ? '!:stale' : '⌛stale'
  const styledSuffix = theme.paint('sep', ' | ') + theme.paint('label', staleMark)
  h.load(); h.event('session_start')
  const raw = () => h.row!.render(200)[0]!
  const text = () => raw().replace(/\x1b\[[0-9;]*m/g, '')
  try {
    const healthyRaw = raw()
    const healthy = text()
    now += 4500
    assert.equal(text(), healthy)
    h.ctx.getContextUsage = () => { throw new Error('collection failed') }
    h.event('message_end')
    now += 501
    assert.equal(raw(), healthyRaw + styledSuffix)
    assert.equal(text(), healthy + ' | ' + staleMark)
    h.ctx.getContextUsage = () => {
      now += 6000
      return { tokens: 750, contextWindow: 1000, percent: 75 }
    }
    h.event('message_end')
    assert.match(text(), /ctx:75%/)
    assert.doesNotMatch(text(), new RegExp(staleMark))
  } finally {
    h.event('session_shutdown')
    if (hadNoColor) process.env.NO_COLOR = savedNoColor
    else delete process.env.NO_COLOR
  }
})

test('OmO honours NO_COLOR only when non-empty, matching the other hosts', () => {
  const hadNoColor = 'NO_COLOR' in process.env
  const savedNoColor = process.env.NO_COLOR
  try {
    process.env.NO_COLOR = ''
    const colored = host()
    colored.load(); colored.event('session_start')
    const emptyLine = colored.row?.render(200).join('') ?? ''
    colored.event('session_shutdown')
    assert.ok(emptyLine.includes('\x1b[38;2;'), 'empty NO_COLOR must keep ANSI colours')

    process.env.NO_COLOR = '1'
    const plain = host()
    plain.load(); plain.event('session_start')
    const plainLine = plain.row?.render(200).join('') ?? ''
    plain.event('session_shutdown')
    assert.equal(plainLine.includes('\x1b['), false, 'non-empty NO_COLOR must strip all ANSI codes')
  } finally {
    if (hadNoColor) process.env.NO_COLOR = savedNoColor
    else delete process.env.NO_COLOR
  }
})

test('OmO stale trimming preserves whole fragments containing ` | ` under NO_COLOR', t => {
  let now = 1000
  t.mock.method(Date, 'now', () => now)
  const hadNoColor = 'NO_COLOR' in process.env
  const savedNoColor = process.env.NO_COLOR
  process.env.NO_COLOR = '1'
  const isWsl = detectWsl()
  const staleMark = isWsl ? '!:stale' : '⌛stale'
  const h = host('tui', '/a | b')
  h.load(); h.event('session_start')
  try {
    h.ctx.getContextUsage = () => { throw new Error('collection failed') }
    h.event('message_end')
    now += 6000
    assert.deepEqual(h.row?.render(17), [`  ${staleMark}`])
  } finally {
    h.event('session_shutdown')
    if (hadNoColor) process.env.NO_COLOR = savedNoColor
    else delete process.env.NO_COLOR
  }
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
      usage: { input: 100, output: 20, cacheRead: 40, cacheWrite: 60 } },
  }
  const edited: SessionEntry = {
    id: 'edited', type: 'message', timestamp: '',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Edited' }],
      usage: { input: 100, output: 20, cacheRead: 40, cacheWrite: 60 } },
  }
  const text = () => h.row?.render(200).join('').replace(/\x1b\[[0-9;]*m/g, '') ?? ''
  h.append(original)
  h.load(); h.event('session_start')
  try {
    assert.match(text(), /token:120\(20%\)/)
    h.append({ id: 'miss', type: 'message', timestamp: '', message: {
      role: 'assistant', usage: { input: 25, output: 5, cacheRead: 0, cacheWrite: 0 },
    } })
    h.event('message_end')
    assert.match(text(), /token:150\(0%\)/)
    h.event('session_before_tree', { preparation: { targetId: 'original' } })
    h.append(edited)
    h.event('session_tree', { newLeafId: 'edited', oldLeafId: 'original' })
    assert.match(text(), /token:150\(0%\)/)
    h.event('session_shutdown')
    h.load(); h.event('session_start')
    assert.match(text(), /token:150\(0%\)/)
    // A navigation to an existing response, and another actual response with
    // identical usage, must not be mistaken for an edit.
    h.event('session_before_tree', { preparation: { targetId: 'original' } })
    h.event('session_tree', { newLeafId: 'original', oldLeafId: 'edited' })
    h.append({ ...original, id: 'second-response' })
    h.event('message_end')
    assert.match(text(), /token:270\(20%\)/)
  } finally { h.event('session_shutdown') }
})

test('OmO live streaming computes decode t/s excluding TTFT and clears on model switch or compaction', t => {
  const h = host()
  let perf = 1000
  t.mock.method(performance, 'now', () => perf)
  const text = () => h.row?.render(200).join('').replace(/\x1b\[[0-9;]*m/g, '') ?? ''
  h.load(); h.event('session_start')
  try {
    // 500ms TTFT after message_start before thinking_start, then 800ms stream for 120 output tokens => 150t/s
    const assistantMsg = { role: 'assistant', usage: { input: 100, output: 120, cacheRead: 400, cacheWrite: 0 }, stopReason: 'stop' }
    h.event('message_start', { message: { role: 'assistant' } })
    perf += 500
    h.event('message_update', { message: { role: 'assistant' }, assistantMessageEvent: { type: 'thinking_start' } })
    perf += 400
    h.event('message_update', { message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_delta' } })
    perf += 400
    h.event('message_update', { message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_end' } })
    h.append({ id: 'm1', type: 'message', timestamp: '', message: assistantMsg })
    h.event('message_end', { message: assistantMsg })
    assert.match(text(), /token:220\(80%, 150t\/s\)/)

    // Short burst (< 500ms) keeps the previous valid rate.
    const shortMsg = { role: 'assistant', usage: { input: 100, output: 20, cacheRead: 400, cacheWrite: 0 }, stopReason: 'stop' }
    h.event('message_start', { message: { role: 'assistant' } })
    perf += 100
    h.event('message_update', { message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_start' } })
    perf += 100
    h.event('message_update', { message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_end' } })
    h.append({ id: 'm2', type: 'message', timestamp: '', message: shortMsg })
    h.event('message_end', { message: shortMsg })
    assert.match(text(), /token:340\(80%, 150t\/s\)/)

    // Aborted, error and deferred replies keep the previous rate; assistant edit keeps the rate.
    for (const stopReason of ['aborted', 'error', 'deferred'] as const) {
      h.event('message_start', { message: { role: 'assistant' } })
      perf += 600
      h.event('message_end', { message: { role: 'assistant', stopReason, usage: { output: 0 } } })
      assert.match(text(), /token:340\(80%, 150t\/s\)/)
    }

    h.event('session_before_tree', { preparation: { targetId: 'm1' } })
    h.append({ id: 'm1-edit', type: 'message', timestamp: '', message: assistantMsg })
    h.event('session_tree', { newLeafId: 'm1-edit', oldLeafId: 'm1' })
    assert.match(text(), /token:340\(80%, 150t\/s\)/)

    // Non-edit tree navigation clears the rate.
    h.event('session_before_tree', { preparation: { targetId: 'm1' } })
    h.event('session_tree', { newLeafId: 'm1', oldLeafId: 'm1-edit' })
    assert.match(text(), /token:340\(80%\)(?!.*t\/s)/)

    const streamTurn = (id: string, output: number, durationMs: number) => {
      h.event('message_start', { message: { role: 'assistant' } })
      h.event('message_update', { message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_delta' } })
      perf += durationMs
      h.event('message_update', { message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_delta' } })
      const msg = { ...assistantMsg, usage: { input: 50, output, cacheRead: 150, cacheWrite: 0 } }
      h.append({ id, type: 'message', timestamp: '', message: msg })
      h.event('message_end', { message: msg })
    }

    // Provider-only switch, missing-previousModel switch, and model deselection clear the rate.
    streamTurn('m3', 80, 1000)
    assert.match(text(), /80t\/s\)/)
    h.event('model_select', {
      previousModel: { id: 'gpt-6.1-sol', provider: 'test' },
      model: { id: 'gpt-6.1-sol', provider: 'other-provider' },
    })
    assert.doesNotMatch(text(), /t\/s/)

    streamTurn('m4', 80, 1000)
    assert.match(text(), /80t\/s\)/)
    h.event('model_select', { model: { id: 'claude-opus-5-5', provider: 'anthropic' } })
    assert.doesNotMatch(text(), /t\/s/)

    streamTurn('m4b', 80, 1000)
    assert.match(text(), /80t\/s\)/)
    h.event('model_select', { model: undefined }, { ...h.ctx, model: undefined })
    assert.doesNotMatch(text(), /t\/s/)

    // Completed response with zero output clears the rate.
    streamTurn('m5', 80, 1000)
    assert.match(text(), /80t\/s\)/)
    h.event('message_start', { message: { role: 'assistant' } })
    h.event('message_end', { message: { role: 'assistant', stopReason: 'stop', usage: { input: 50, output: 0 } } })
    assert.doesNotMatch(text(), /t\/s/)

    // Compaction also clears a recorded rate.
    streamTurn('m6', 80, 1000)
    assert.match(text(), /80t\/s\)/)
    h.event('session_compact')
    assert.doesNotMatch(text(), /t\/s/)
  } finally { h.event('session_shutdown') }
})

test('portable OmO setup loads the real entry and removes only the owned loader', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-omo-install-'))
  try {
    const unrelated = join(dir, 'other.ts')
    await writeFile(unrelated, 'export default function () {}')
    await assert.rejects(main(['omo', 'install', '--dir', dir]), /vargus install omo/)
    await main(['install', 'omo', '--dir', dir])
    const loader = await readFile(join(dir, 'vargus.ts'), 'utf8')
    const spec = /from ("[^"]+");/.exec(loader)?.[1]
    assert.ok(spec)
    const entry = await import(JSON.parse(spec))
    assert.equal(entry.default, vargus)
    const oldEntry = new URL('../../extensions/omo.ts', import.meta.url).href
    await writeFile(join(dir, 'vargus.ts'),
      `// VArgus OmO native extension loader.\nexport { default } from ${JSON.stringify(oldEntry)};\n`)
    await main(['install', 'omo', '--dir', dir])
    assert.equal(await readFile(join(dir, 'vargus.ts'), 'utf8'), loader)
    await assert.rejects(main(['omo', 'remove', '--dir', dir]), /vargus remove omo/)
    await main(['remove', 'omo', '--dir', dir])
    assert.deepEqual(await readdir(dir), ['other.ts'])
    assert.equal(await readFile(unrelated, 'utf8'), 'export default function () {}')
    await writeFile(join(dir, 'vargus.ts'), 'unrelated user extension')
    await assert.rejects(main(['install', 'omo', '--dir', dir]), /unrelated or modified/)
    await assert.rejects(main(['remove', 'omo', '--dir', dir]), /unrelated or modified/)
    assert.equal(await readFile(join(dir, 'vargus.ts'), 'utf8'), 'unrelated user extension')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('OmO reinstall updates a symlinked loader at its target', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-omo-linked-'))
  const extensions = join(dir, 'extensions')
  const target = join(dir, 'vargus.ts')
  const link = join(extensions, 'vargus.ts')
  const config = join(dir, 'options.json')
  try {
    await main(['install', 'omo', '--dir', dir])
    await mkdir(extensions)
    await symlink(target, link)
    await writeFile(config, '{"model":false}')
    await main(['install', 'omo', '--dir', extensions, '--config', config])
    assert.ok((await lstat(link)).isSymbolicLink())
    const updated = await readFile(target, 'utf8')
    assert.match(updated, /export default configuredVargus\(/)
    await main(['remove', 'omo', '--dir', extensions])
    assert.deepEqual(await readdir(extensions), [])
    assert.equal(await readFile(target, 'utf8'), updated)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('OmO options file applies on reload and keeps session overrides', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-omo-config-'))
  const first = host()
  const fresh = host()
  const config = join(dir, 'shared options.jsonc')
  const extensions = join(dir, 'extensions')
  const loader = join(extensions, 'vargus.ts')
  const readRow = (h: ReturnType<typeof host>) => h.row?.render(200).join('') ?? ''
  try {
    const checkout = await fixtureCheckout(dir)
    const { main } = await import(pathToFileURL(join(checkout, 'src/cli.ts')).href)
    await writeFile(join(checkout, 'vargus.jsonc'), '// checkout default\n{"model":false, "context":false}')
    await writeFile(config, '{/* from a shared file */ "model":false,"rateLimits":false}')
    await main(['install', 'omo', '--dir', extensions])
    const unconfigured = await import(pathToFileURL(loader).href + '?default')
    first.load(unconfigured.default); first.event('session_start')
    assert.ok(readRow(first).includes('/repo'))
    assert.doesNotMatch(readRow(first), /sol|ctx:/)
    first.event('session_shutdown')
    await main(['install', 'omo', '--config', relative(process.cwd(), config), '--dir', extensions])
    const installed = await readFile(loader, 'utf8')
    await main(['install', 'omo', '--dir', extensions])
    assert.equal(await readFile(loader, 'utf8'), installed)
    const { default: factory } = await import(pathToFileURL(loader).href)

    first.load(factory); first.event('session_start')
    assert.equal(first.hidden, true)
    assert.doesNotMatch(readRow(first), /sol/)
    assert.equal(first.listeners, 0)
    await first.command('config {"model":true}')
    assert.match(readRow(first), /sol/)
    assert.doesNotMatch(readRow(first), /ctx:/)
    assert.equal(first.listeners, 0)

    await writeFile(config, '{"model":false,"rateLimits":true}')
    first.event('session_shutdown')
    first.load(factory); first.event('session_start')
    assert.match(readRow(first), /sol/)
    assert.equal(first.listeners, 1)
    fresh.load(factory); fresh.event('session_start')
    assert.doesNotMatch(readRow(fresh), /sol/)
    assert.equal(fresh.listeners, 1)

    const invalid = join(dir, 'invalid.json')
    await writeFile(invalid, '[]')
    await assert.rejects(main(['install', 'omo', '--dir', extensions, '--config', invalid]), /JSON options object/)
    assert.equal(await readFile(loader, 'utf8'), installed)
    await main(['remove', 'omo', '--dir', extensions])
    assert.deepEqual(await readdir(extensions), [])
    assert.equal(await readFile(config, 'utf8'), '{"model":false,"rateLimits":true}')
  } finally {
    first.event('session_shutdown'); fresh.event('session_shutdown')
    await rm(dir, { recursive: true, force: true })
  }
})

test('OmO includeSubagents defaults on, folds and deduplicates, keeps main metrics untouched, and toggles off', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-omo-entry-sub-'))
  const home = join(dir, 'home')
  const agentDir = join(dir, 'agent')
  const project = join(dir, 'project')
  const savedHome = process.env.HOME
  const savedAgentDir = process.env.OMO_CODING_AGENT_DIR
  const savedNoColor = process.env.NO_COLOR
  const hadHome = 'HOME' in process.env
  const hadAgentDir = 'OMO_CODING_AGENT_DIR' in process.env
  const hadNoColor = 'NO_COLOR' in process.env
  t.after(async () => {
    if (hadHome) process.env.HOME = savedHome
    else delete process.env.HOME
    if (hadAgentDir) process.env.OMO_CODING_AGENT_DIR = savedAgentDir
    else delete process.env.OMO_CODING_AGENT_DIR
    if (hadNoColor) process.env.NO_COLOR = savedNoColor
    else delete process.env.NO_COLOR
    await rm(dir, { recursive: true, force: true })
  })

  await mkdir(home, { recursive: true })
  await mkdir(project, { recursive: true })
  process.env.HOME = home
  process.env.OMO_CODING_AGENT_DIR = agentDir
  process.env.NO_COLOR = '1'

  const stateDir = join(agentDir, 'projects', projectStateKey(project), 'senpi-task')
  await mkdir(join(stateDir, 'tasks'), { recursive: true })
  await mkdir(join(stateDir, 'children', 'st_00000001', 'sessions', 'st_00000001'), { recursive: true })
  await mkdir(join(stateDir, 'children', 'st_00000002', 'sessions', 'st_00000002'), { recursive: true })
  await writeFile(join(stateDir, 'tasks', 'st_00000001.json'), JSON.stringify({
    task_id: 'st_00000001',
    parent_session_id: 'sess-main',
    root_session_id: 'sess-main',
    child_session_id: 'sess-child-1',
    status: 'completed',
  }))
  await writeFile(join(stateDir, 'tasks', 'st_00000002.json'), JSON.stringify({
    task_id: 'st_00000002',
    parent_session_id: 'sess-child-1',
    root_session_id: 'sess-main',
    status: 'completed',
  }))
  await writeFile(
    join(stateDir, 'children', 'st_00000001', 'sessions', 'st_00000001', '001.jsonl'),
    JSON.stringify({
      id: 'c1', type: 'message', timestamp: '',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc1', name: 'read', arguments: {} }, { type: 'toolCall', id: 'tc2', name: 'task', arguments: {} }],
        usage: { input: 400, output: 100, cacheRead: 0, cacheWrite: 0 },
      },
    }) + '\n',
  )
  await writeFile(
    join(stateDir, 'children', 'st_00000002', 'sessions', 'st_00000002', '001.jsonl'),
    JSON.stringify({
      id: 'gc1', type: 'message', timestamp: '',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc3', name: 'grep', arguments: {} }],
        usage: { input: 200, output: 100, cacheRead: 0, cacheWrite: 0 },
      },
    }) + '\n',
  )

  const entries: SessionEntry[] = [
    { id: 'settings', type: 'custom', timestamp: '', customType: 'vargus-settings',
      data: { enabled: true, options: { repo: false, branch: false, status: false } } },
    { id: 'm1', type: 'message', timestamp: '', message: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'mt1', name: 'task', arguments: {} }],
      usage: { input: 100, output: 100, cacheRead: 800, cacheWrite: 0 },
    } },
    { id: 'r1', type: 'message', timestamp: '', message: {
      role: 'toolResult', toolCallId: 'mt1', toolName: 'task',
      details: { mode: 'spawn', task_id: 'st_00000001' },
    } },
  ]
  const memo = new Map<object, { state: unknown; through: number }>()
  const handlers = new Map<string, (event: unknown, ctx: Context) => void>()
  type Context = Parameters<Parameters<OmoApi['on']>[1]>[1]
  let command: Parameters<OmoApi['registerCommand']>[1] | undefined
  let row: { render(width: number): string[]; invalidate(): void } | undefined
  let renderCount = 0
  let onRender: (() => void) | undefined
  let getSessionIdCalls = 0
  const ctx: Context = {
    modelRegistry: { getProviderAuth: async () => undefined },
    mode: 'tui', cwd: project, model: { id: 'gpt-6.1-sol', provider: 'test' }, thinkingLevel: 'high',
    getContextUsage: () => ({ tokens: 250, contextWindow: 1000, percent: 25 }),
    sessionManager: {
      getSessionId: () => { getSessionIdCalls++; return 'sess-main' },
      getEntry: id => entries.find(entry => entry.id === id),
      getHeader: () => ({ timestamp: '2026-11-14T00:00:00Z' }),
      reduceHistory<S>(reducer: HistoryReducer<S>): S {
        const previous = memo.get(reducer)
        let state = previous ? previous.state as S : reducer.initial()
        for (let i = previous?.through ?? 0; i < entries.length; i++) {
          state = reducer.add(state, entries[i]!)
        }
        memo.set(reducer, { state, through: entries.length })
        return state
      },
    },
    ui: {
      setFooter() {},
      setWidget(_key, factory) {
        row = factory?.({
          requestRender() {
            renderCount++
            onRender?.()
          },
        })
      },
      notify() {},
    },
  }
  const api: OmoApi = {
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    getSubscriptionLimits: () => [],
    onSubscriptionLimits: () => () => {},
    appendEntry(customType, data) {
      entries.push({ id: String(entries.length), type: 'custom', timestamp: '', customType, data })
    },
    registerCommand(_name, value) { command = value },
  }

  const lineText = () => row?.render(200).join('') ?? ''
  const waitForLine = (pattern: RegExp) => new Promise<string>((resolveWait, rejectWait) => {
    const check = () => {
      const current = lineText()
      if (pattern.test(current)) {
        clearTimeout(timeout)
        onRender = undefined
        resolveWait(current)
      }
    }
    const timeout = setTimeout(() => {
      onRender = undefined
      rejectWait(new Error(`Timed out waiting for ${pattern}; got: ${lineText()}`))
    }, 3000)
    onRender = check
    check()
  })

  let now = 100_000
  t.mock.method(Date, 'now', () => now)
  let perf = 1000
  t.mock.method(performance, 'now', () => perf)
  vargus(api, {})
  handlers.get('session_start')?.({}, ctx)
  try {
    // Default on: folds child (500 tok, 2 tools) + grandchild (300 tok, 1 tool) => 1.0k, 4 tools, 2 agents.
    // Cache hit (88.9%), decode t/s, and ctx (25%) stay strictly main-only; skills remain omitted (no resolved task skills in this fixture).
    const onLine = await waitForLine(/token:1\.0k\(88\.9%\)/)
    assert.match(onLine, /ctx:25%/)
    assert.match(onLine, /🔧4 🤖2|T:4 A:2/)
    assert.doesNotMatch(onLine, /⚡|S:/)
    assert.ok(renderCount > 0)
    assert.ok(getSessionIdCalls > 0)
    // Memoized history.agents must NEVER have been mutated by render-time union.
    assert.deepEqual([...collectOmoAgents(ctx)], ['st_00000001'])

    // Append to terminal child JSONL and verify forced cadence inside the 5s idle window:
    // non-forced update at +1500ms stays throttled, while message_end and tool_execution_end force a rescan (1s floor).
    const child1Jsonl = join(stateDir, 'children', 'st_00000001', 'sessions', 'st_00000001', '001.jsonl')
    await appendFile(child1Jsonl, JSON.stringify({
      id: 'c1-extra', type: 'message', timestamp: '',
      message: { role: 'assistant', content: [], usage: { input: 200, output: 0, cacheRead: 0, cacheWrite: 0 } },
    }) + '\n')
    now += 1500
    handlers.get('thinking_level_select')?.({}, ctx)
    await new Promise(resolveTick => setTimeout(resolveTick, 30))
    assert.match(lineText(), /token:1\.0k\(88\.9%\)/)

    // Live main streamed reply via message_end sets t/s strictly from main output AND forces subagent rescan (+200 child + 200 main = 1.4k).
    const streamedMsg = {
      role: 'assistant',
      content: [],
      usage: { input: 100, output: 100, cacheRead: 800, cacheWrite: 0 },
      stopReason: 'stop',
    }
    handlers.get('message_start')?.({ message: { role: 'assistant' } }, ctx)
    perf += 200
    handlers.get('message_update')?.({ message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_start' } }, ctx)
    perf += 1000
    handlers.get('message_update')?.({ message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_end' } }, ctx)
    entries.push({ id: 'm2', type: 'message', timestamp: '', message: streamedMsg })
    handlers.get('message_end')?.({ message: streamedMsg }, ctx)
    const rateLine = await waitForLine(/token:1\.4k\(88\.9%, 100t\/s\)/)
    assert.match(rateLine, /🔧4 🤖2|T:4 A:2/)

    // tool_execution_end also forces a subagent rescan inside the 5s idle window (+200 child = 1.6k).
    await appendFile(child1Jsonl, JSON.stringify({
      id: 'c1-extra-2', type: 'message', timestamp: '',
      message: { role: 'assistant', content: [], usage: { input: 200, output: 0, cacheRead: 0, cacheWrite: 0 } },
    }) + '\n')
    now += 1500
    handlers.get('tool_execution_end')?.({}, ctx)
    await waitForLine(/token:1\.6k\(88\.9%, 100t\/s\)/)

    // A throwing getSessionId() during update() must preserve the previous values including t/s cleanly.
    const savedGetSessionId = ctx.sessionManager.getSessionId
    ctx.sessionManager.getSessionId = () => { throw new Error('session id unavailable') }
    handlers.get('thinking_level_select')?.({}, ctx)
    assert.match(lineText(), /token:1\.6k\(88\.9%, 100t\/s\)/)
    ctx.sessionManager.getSessionId = savedGetSessionId

    // Toggling off immediately reverts to main-only counts (400 tokens, 1 tool, 1 agent) with zero task-store scans.
    await command!.handler('config {"includeSubagents":false}', ctx)
    const reverted = lineText()
    assert.match(reverted, /token:400\(88\.9%\)/)
    assert.match(reverted, /🔧1 🤖1|T:1 A:1/)
    const callsOff = getSessionIdCalls
    handlers.get('thinking_level_select')?.({}, ctx)
    assert.equal(getSessionIdCalls, callsOff)

    // When both tokens and callCounts are false, includeSubagents: true performs no subagent scans.
    await command!.handler('config {"includeSubagents":true,"tokens":false,"callCounts":false}', ctx)
    assert.equal(getSessionIdCalls, callsOff)
  } finally {
    handlers.get('session_shutdown')?.({}, ctx)
  }
})

test('OmO excludes pre-launch refused tasks across main-only and includeSubagents union while keeping runtime-errored children', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-omo-entry-refusal-'))
  const home = join(dir, 'home')
  const agentDir = join(dir, 'agent')
  const project = join(dir, 'project')
  const savedHome = process.env.HOME
  const savedAgentDir = process.env.OMO_CODING_AGENT_DIR
  const savedNoColor = process.env.NO_COLOR
  const hadHome = 'HOME' in process.env
  const hadAgentDir = 'OMO_CODING_AGENT_DIR' in process.env
  const hadNoColor = 'NO_COLOR' in process.env
  t.after(async () => {
    if (hadHome) process.env.HOME = savedHome
    else delete process.env.HOME
    if (hadAgentDir) process.env.OMO_CODING_AGENT_DIR = savedAgentDir
    else delete process.env.OMO_CODING_AGENT_DIR
    if (hadNoColor) process.env.NO_COLOR = savedNoColor
    else delete process.env.NO_COLOR
    await rm(dir, { recursive: true, force: true })
  })

  await mkdir(home, { recursive: true })
  await mkdir(project, { recursive: true })
  process.env.HOME = home
  process.env.OMO_CODING_AGENT_DIR = agentDir
  process.env.NO_COLOR = '1'

  const stateDir = join(agentDir, 'projects', projectStateKey(project), 'senpi-task')
  await mkdir(join(stateDir, 'tasks'), { recursive: true })
  await mkdir(join(stateDir, 'children', 'st_00000002', 'sessions', 'st_00000002'), { recursive: true })
  await writeFile(join(stateDir, 'tasks', 'st_00000001.json'), JSON.stringify({
    task_id: 'st_00000001',
    parent_session_id: 'sess-root',
    root_session_id: 'sess-root',
    status: 'error',
    failure_kind: 'model_unavailable',
    failure_reason: 'model_not_in_child_profile',
  }))
  await writeFile(join(stateDir, 'tasks', 'st_00000002.json'), JSON.stringify({
    task_id: 'st_00000002',
    parent_session_id: 'sess-root',
    root_session_id: 'sess-root',
    child_session_id: 'sess-child-2',
    status: 'completed',
  }))
  await writeFile(
    join(stateDir, 'children', 'st_00000002', 'sessions', 'st_00000002', '001.jsonl'),
    JSON.stringify({
      id: 'c2', type: 'message', timestamp: '',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc1', name: 'read', arguments: {} }],
        usage: { input: 300, output: 100, cacheRead: 0, cacheWrite: 0 },
      },
    }) + '\n',
  )

  const entries: SessionEntry[] = [
    { id: 'settings', type: 'custom', timestamp: '', customType: 'vargus-settings',
      data: { enabled: true, options: { repo: false, branch: false, status: false } } },
    { id: 'm1', type: 'message', timestamp: '', message: {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'mt1', name: 'task', arguments: {} },
        { type: 'toolCall', id: 'mt2', name: 'task', arguments: {} },
      ],
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
    } },
    { id: 'r1', type: 'message', timestamp: '', message: {
      role: 'toolResult', toolCallId: 'mt1', toolName: 'task',
      details: { mode: 'spawn', task_id: 'st_00000001', status: 'error', failure_kind: 'model_unavailable', failure_reason: 'model_not_in_child_profile' },
    } },
    { id: 'r2', type: 'message', timestamp: '', message: {
      role: 'toolResult', toolCallId: 'mt2', toolName: 'task',
      details: { mode: 'spawn', task_id: 'st_00000002', status: 'completed' },
    } },
  ]
  const memo = new Map<object, { state: unknown; through: number }>()
  const handlers = new Map<string, (event: unknown, ctx: Context) => void>()
  type Context = Parameters<Parameters<OmoApi['on']>[1]>[1]
  let command: Parameters<OmoApi['registerCommand']>[1] | undefined
  let row: { render(width: number): string[]; invalidate(): void } | undefined
  let onRender: (() => void) | undefined
  const ctx: Context = {
    modelRegistry: { getProviderAuth: async () => undefined },
    mode: 'tui', cwd: project, model: { id: 'gpt-6.1-sol', provider: 'test' }, thinkingLevel: 'high',
    getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    sessionManager: {
      getSessionId: () => 'sess-root',
      getEntry: id => entries.find(entry => entry.id === id),
      getHeader: () => ({ timestamp: '2026-11-14T00:00:00Z' }),
      reduceHistory<S>(reducer: HistoryReducer<S>): S {
        const previous = memo.get(reducer)
        let state = previous ? previous.state as S : reducer.initial()
        for (let i = previous?.through ?? 0; i < entries.length; i++) {
          state = reducer.add(state, entries[i]!)
        }
        memo.set(reducer, { state, through: entries.length })
        return state
      },
    },
    ui: {
      setFooter() {},
      setWidget(_key, factory) { row = factory?.({ requestRender() { onRender?.() } }) },
      notify() {},
    },
  }
  const api: OmoApi = {
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    getSubscriptionLimits: () => [],
    onSubscriptionLimits: () => () => {},
    appendEntry(customType, data) {
      entries.push({ id: String(entries.length), type: 'custom', timestamp: '', customType, data })
    },
    registerCommand(_name, value) { command = value },
  }
  const lineText = () => row?.render(200).join('') ?? ''
  const waitForLine = (pattern: RegExp) => new Promise<string>((resolveWait, rejectWait) => {
    const check = () => {
      const current = lineText()
      if (pattern.test(current)) {
        clearTimeout(timeout)
        onRender = undefined
        resolveWait(current)
      }
    }
    const timeout = setTimeout(() => {
      onRender = undefined
      rejectWait(new Error(`Timed out waiting for ${pattern}; got: ${lineText()}`))
    }, 3000)
    onRender = check
    check()
  })

  let now = 200_000
  t.mock.method(Date, 'now', () => now)
  vargus(api, {})
  handlers.get('session_start')?.({}, ctx)
  try {
    // Default on: union of main and store reports 1 agent, plus st_00000002's 400 tokens & 1 tool.
    const onLine = await waitForLine(/token:550\(0%\)/)
    assert.match(onLine, /🔧3 🤖1|T:3 A:1/)

    // Toggle includeSubagents off: only st_00000002 counts in main-only -> 1 agent, 150 tokens, 2 outer tool calls.
    await command!.handler('config {"includeSubagents":false}', ctx)
    const offLine = lineText()
    assert.match(offLine, /token:150\(0%\)/)
    assert.match(offLine, /🔧2 🤖1|T:2 A:1/)

    // Toggle includeSubagents back on before adding runtime-errored st_00000003.
    await command!.handler('config {"includeSubagents":true}', ctx)
    await waitForLine(/token:550\(0%\)/)

    // Add a control child that actually ran and later errored: counts as 2nd agent and adds its 250 tokens & 1 tool.
    await mkdir(join(stateDir, 'children', 'st_00000003', 'sessions', 'st_00000003'), { recursive: true })
    await writeFile(join(stateDir, 'tasks', 'st_00000003.json'), JSON.stringify({
      task_id: 'st_00000003',
      parent_session_id: 'sess-root',
      root_session_id: 'sess-root',
      child_session_id: 'sess-child-3',
      status: 'error',
      error_message: 'tool execution failed',
    }))
    await writeFile(
      join(stateDir, 'children', 'st_00000003', 'sessions', 'st_00000003', '001.jsonl'),
      JSON.stringify({
        id: 'c3', type: 'message', timestamp: '',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'tc3', name: 'bash', arguments: {} }],
          usage: { input: 200, output: 50, cacheRead: 0, cacheWrite: 0 },
        },
      }) + '\n',
    )
    entries.push({
      id: 'r3', type: 'message', timestamp: '',
      message: { role: 'toolResult', toolCallId: 'mt3', toolName: 'task', details: { mode: 'spawn', task_id: 'st_00000003', status: 'error' } },
    })
    now += 2000
    handlers.get('tool_execution_end')?.({}, ctx)
    const withRuntimeError = await waitForLine(/token:800\(0%\)/)
    assert.match(withRuntimeError, /🔧4 🤖2|T:4 A:2/)
  } finally {
    handlers.get('session_shutdown')?.({}, ctx)
  }
})

test('OmO attributes explicitly resolved child task skills only under includeSubagents and deduplicates across sources', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-omo-entry-skills-'))
  const home = join(dir, 'home')
  const agentDir = join(dir, 'agent')
  const project = join(dir, 'project')
  const savedHome = process.env.HOME
  const savedAgentDir = process.env.OMO_CODING_AGENT_DIR
  const savedNoColor = process.env.NO_COLOR
  const hadHome = 'HOME' in process.env
  const hadAgentDir = 'OMO_CODING_AGENT_DIR' in process.env
  const hadNoColor = 'NO_COLOR' in process.env
  t.after(async () => {
    if (hadHome) process.env.HOME = savedHome
    else delete process.env.HOME
    if (hadAgentDir) process.env.OMO_CODING_AGENT_DIR = savedAgentDir
    else delete process.env.OMO_CODING_AGENT_DIR
    if (hadNoColor) process.env.NO_COLOR = savedNoColor
    else delete process.env.NO_COLOR
    await rm(dir, { recursive: true, force: true })
  })

  await mkdir(home, { recursive: true })
  await mkdir(project, { recursive: true })
  process.env.HOME = home
  process.env.OMO_CODING_AGENT_DIR = agentDir
  process.env.NO_COLOR = '1'

  const stateDir = join(agentDir, 'projects', projectStateKey(project), 'senpi-task')
  const entries: SessionEntry[] = [
    { id: 'settings', type: 'custom', timestamp: '', customType: 'vargus-settings',
      data: { enabled: true, options: { repo: false, branch: false, status: false } } },
    { id: 'm1', type: 'message', timestamp: '', message: {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'mt1', name: 'task', arguments: { load_skills: ['audit', 'missing'] } },
        { type: 'toolCall', id: 'mt2', name: 'task', arguments: { load_skills: ['blocked'] } },
      ],
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
    } },
    // Upstream OmO 5.1.61 accepted spawn receipt with 1 resolved + 1 missing skill.
    { id: 'r1', type: 'message', timestamp: '', message: {
      role: 'toolResult', toolCallId: 'mt1', toolName: 'task',
      details: {
        mode: 'spawn', task_id: 'st_00000001', status: 'completed',
        skills: { requested: ['audit', 'missing'], resolved: ['audit'], missing: ['missing'] },
      },
    } },
    // Confirmed pre-launch refusal carrying skills must contribute 0 agents and 0 skills.
    { id: 'r2', type: 'message', timestamp: '', message: {
      role: 'toolResult', toolCallId: 'mt2', toolName: 'task',
      details: {
        mode: 'spawn', task_id: 'st_00000009', status: 'error',
        failure_kind: 'model_unavailable', failure_reason: 'model_not_in_child_profile',
        skills: { requested: ['blocked'], resolved: ['blocked'], missing: [] },
      },
    } },
  ]
  const memo = new Map<object, { state: unknown; through: number }>()
  const handlers = new Map<string, (event: unknown, ctx: Context) => void>()
  type Context = Parameters<Parameters<OmoApi['on']>[1]>[1]
  let command: Parameters<OmoApi['registerCommand']>[1] | undefined
  let row: { render(width: number): string[]; invalidate(): void } | undefined
  let onRender: (() => void) | undefined
  let getSessionIdCalls = 0
  const ctx: Context = {
    modelRegistry: { getProviderAuth: async () => undefined },
    mode: 'tui', cwd: project, model: { id: 'gpt-6.1-sol', provider: 'test' }, thinkingLevel: 'high',
    getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    sessionManager: {
      getSessionId: () => { getSessionIdCalls++; return 'sess-root' },
      getEntry: id => entries.find(entry => entry.id === id),
      getHeader: () => ({ timestamp: '2026-11-14T00:00:00Z' }),
      reduceHistory<S>(reducer: HistoryReducer<S>): S {
        const previous = memo.get(reducer)
        let state = previous ? previous.state as S : reducer.initial()
        for (let i = previous?.through ?? 0; i < entries.length; i++) {
          state = reducer.add(state, entries[i]!)
        }
        memo.set(reducer, { state, through: entries.length })
        return state
      },
    },
    ui: {
      setFooter() {},
      setWidget(_key, factory) { row = factory?.({ requestRender() { onRender?.() } }) },
      notify() {},
    },
  }
  const api: OmoApi = {
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    getSubscriptionLimits: () => [],
    onSubscriptionLimits: () => () => {},
    appendEntry(customType, data) {
      entries.push({ id: String(entries.length), type: 'custom', timestamp: '', customType, data })
    },
    registerCommand(_name, value) { command = value },
  }
  const lineText = () => row?.render(200).join('') ?? ''
  const waitForLine = (pattern: RegExp) => new Promise<string>((resolveWait, rejectWait) => {
    const check = () => {
      const current = lineText()
      if (pattern.test(current)) {
        clearTimeout(timeout)
        onRender = undefined
        resolveWait(current)
      }
    }
    const timeout = setTimeout(() => {
      onRender = undefined
      rejectWait(new Error(`Timed out waiting for ${pattern}; got: ${lineText()}`))
    }, 3000)
    onRender = check
    check()
  })

  let now = 300_000
  t.mock.method(Date, 'now', () => now)
  vargus(api, {})
  handlers.get('session_start')?.({}, ctx)
  try {
    // 1. Default on even before any task store exists on disk: immediately renders 1 skill (`audit`).
    const onImmediate = lineText()
    assert.match(onImmediate, /🔧2 🤖1 ⚡1|T:2 A:1 S:1/)
    assert.ok(getSessionIdCalls > 0)

    // 2. Populate on-disk child JSONL that spawns grandchild st_00000002 with `review` AND under
    //    already-seen st_00000001 duplicates `audit` while adding `lint` -> union must show 2 agents and 3 skills.
    await mkdir(join(stateDir, 'tasks'), { recursive: true })
    await mkdir(join(stateDir, 'children', 'st_00000001', 'sessions', 'st_00000001'), { recursive: true })
    await writeFile(join(stateDir, 'tasks', 'st_00000001.json'), JSON.stringify({
      task_id: 'st_00000001',
      parent_session_id: 'sess-root',
      root_session_id: 'sess-root',
      child_session_id: 'sess-child-1',
      status: 'completed',
    }))
    await writeFile(
      join(stateDir, 'children', 'st_00000001', 'sessions', 'st_00000001', '001.jsonl'),
      [
        JSON.stringify({
          id: 'c1-a1', type: 'message', timestamp: '',
          message: {
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'tc1', name: 'task', arguments: {} }],
            usage: { input: 200, output: 50, cacheRead: 0, cacheWrite: 0 },
          },
        }),
        JSON.stringify({
          id: 'c1-r1', type: 'message', timestamp: '',
          message: {
            role: 'toolResult', toolCallId: 'tc1', toolName: 'task',
            details: {
              mode: 'spawn',
              items: [
                { task_id: 'st_00000001', status: 'completed', skills: { requested: ['audit', 'lint'], resolved: ['audit', 'lint'], missing: [] } },
                { task_id: 'st_00000002', status: 'completed', skills: { requested: ['review', 'missing'], resolved: ['review'], missing: ['missing'] } },
              ],
            },
          },
        }),
      ].join('\n') + '\n',
    )
    now += 6000
    handlers.get('tool_execution_end')?.({}, ctx)
    const foldedLine = await waitForLine(/🔧3 🤖2 ⚡3|T:3 A:2 S:3/)
    assert.match(foldedLine, /token:400\(0%\)/)
    // Memoized main subagentSkills map (and its inner Set) must never be mutated by render-time union.
    assert.deepEqual([...collectOmoSubagentSkills(ctx).keys()], ['st_00000001'])
    assert.deepEqual([...collectOmoSubagentSkills(ctx).get('st_00000001')!], ['audit'])

    // 4. Failed updates after appending new spawns — both a new task_id and a new skill on an already-seen
    //    task_id (guarding inner-Set deep cloning) — must preserve committed tokens, tools, agents and skills
    //    atomically across getContextUsage/getSessionId throws and stale ticks.
    entries.push(
      { id: 'm-new', type: 'message', timestamp: '', message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'mt-new', name: 'task', arguments: {} }],
        usage: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 },
      } },
      { id: 'r-new', type: 'message', timestamp: '', message: {
        role: 'toolResult', toolCallId: 'mt-new', toolName: 'task',
        details: {
          mode: 'spawn', task_id: 'st_00000003', status: 'completed',
          skills: { requested: ['deploy'], resolved: ['deploy'], missing: [] },
        },
      } },
      { id: 'r-same-task', type: 'message', timestamp: '', message: {
        role: 'toolResult', toolCallId: 'mt-same', toolName: 'task',
        details: {
          mode: 'spawn', task_id: 'st_00000001', status: 'completed',
          skills: { requested: ['extra'], resolved: ['extra'], missing: [] },
        },
      } },
    )
    const savedGetContextUsage = ctx.getContextUsage
    ctx.getContextUsage = () => { throw new Error('context unavailable') }
    handlers.get('thinking_level_select')?.({}, ctx)
    assert.match(lineText(), /token:400\(0%\)/)
    assert.match(lineText(), /🔧3 🤖2 ⚡3|T:3 A:2 S:3/)
    ctx.getContextUsage = savedGetContextUsage

    const savedGetSessionId = ctx.sessionManager.getSessionId
    ctx.sessionManager.getSessionId = () => { throw new Error('session id unavailable') }
    handlers.get('thinking_level_select')?.({}, ctx)
    assert.match(lineText(), /token:400\(0%\)/)
    assert.match(lineText(), /🔧3 🤖2 ⚡3|T:3 A:2 S:3/)
    now += 6000
    assert.match(lineText(), /token:400\(0%\).*?(?:🔧3 🤖2 ⚡3|T:3 A:2 S:3).*?(?:⌛stale|!:stale)/)
    ctx.sessionManager.getSessionId = savedGetSessionId

    // Recovery commits tokens, tools, agents and skills atomically together (+600 tok, +1 tool, +1 agent, +2 skills).
    handlers.get('thinking_level_select')?.({}, ctx)
    assert.match(lineText(), /token:1\.0k\(0%\)/)
    assert.match(lineText(), /🔧4 🤖3 ⚡5|T:4 A:3 S:5/)

    // 5. tokens: false with callCounts: true + includeSubagents: true still folds resolved skills;
    //    tokens: true with callCounts: false still folds subagent tokens.
    await command!.handler('config {"includeSubagents":true,"tokens":false,"callCounts":true}', ctx)
    const callsOnly = await waitForLine(/🔧4 🤖3 ⚡5|T:4 A:3 S:5/)
    assert.doesNotMatch(callsOnly, /token:/)
    await command!.handler('config {"includeSubagents":true,"tokens":true,"callCounts":false}', ctx)
    const tokensOnly = await waitForLine(/token:1\.0k\(0%\)/)
    assert.doesNotMatch(tokensOnly, /🔧|🤖|⚡|T:|A:|S:/)

    // 6. Toggling includeSubagents off immediately drops skills back to 0 with no extra store scans.
    await command!.handler('config {"includeSubagents":false,"tokens":true,"callCounts":true}', ctx)
    const backOff = lineText()
    assert.match(backOff, /🔧3 🤖2|T:3 A:2/)
    assert.doesNotMatch(backOff, /⚡|S:/)
    const callsOff = getSessionIdCalls
    handlers.get('thinking_level_select')?.({}, ctx)
    assert.equal(getSessionIdCalls, callsOff)

    // 7. Both tokens and callCounts false skips disk scans cleanly.
    await command!.handler('config {"includeSubagents":true,"tokens":false,"callCounts":false}', ctx)
    assert.equal(getSessionIdCalls, callsOff)
  } finally {
    handlers.get('session_shutdown')?.({}, ctx)
  }
})

test('OmO reconciles queued pending receipts against store refusals, excludes admission-exhausted chains, and keeps launched runs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-omo-entry-queued-refusal-'))
  const home = join(dir, 'home')
  const agentDir = join(dir, 'agent')
  const project = join(dir, 'project')
  const savedHome = process.env.HOME
  const savedAgentDir = process.env.OMO_CODING_AGENT_DIR
  const savedNoColor = process.env.NO_COLOR
  const hadHome = 'HOME' in process.env
  const hadAgentDir = 'OMO_CODING_AGENT_DIR' in process.env
  const hadNoColor = 'NO_COLOR' in process.env
  t.after(async () => {
    if (hadHome) process.env.HOME = savedHome
    else delete process.env.HOME
    if (hadAgentDir) process.env.OMO_CODING_AGENT_DIR = savedAgentDir
    else delete process.env.OMO_CODING_AGENT_DIR
    if (hadNoColor) process.env.NO_COLOR = savedNoColor
    else delete process.env.NO_COLOR
    await rm(dir, { recursive: true, force: true })
  })

  await mkdir(home, { recursive: true })
  await mkdir(project, { recursive: true })
  process.env.HOME = home
  process.env.OMO_CODING_AGENT_DIR = agentDir
  process.env.NO_COLOR = '1'

  const stateDir = join(agentDir, 'projects', projectStateKey(project), 'senpi-task')
  await mkdir(join(stateDir, 'tasks'), { recursive: true })

  // 1. Two-task queued admission refusal (OmO 5.1.61 concurrency=1 fixture):
  //    st_00000001 launched and completed; st_00000002 received a pending background receipt
  //    (status:'pending', run_epoch:0, queue_position:1, skills.resolved:['audit']) and then
  //    failed at model admission in the store. Also add a synchronous two-model admission
  //    exhaustion (st_00000003) that must be omitted in BOTH default and folded modes.
  await writeFile(join(stateDir, 'tasks', 'st_00000001.json'), JSON.stringify({
    task_id: 'st_00000001',
    parent_session_id: 'sess-queue',
    root_session_id: 'sess-queue',
    child_session_id: 'child-1',
    status: 'completed',
    notification: { run_epoch: 0, notified_epoch: 0 },
    run_start_epoch: 0,
  }))
  await writeFile(join(stateDir, 'tasks', 'st_00000002.json'), JSON.stringify({
    task_id: 'st_00000002',
    parent_session_id: 'sess-queue',
    root_session_id: 'sess-queue',
    status: 'error',
    failure_kind: 'model_unavailable',
    failure_reason: 'model_not_in_child_profile',
    notification: { run_epoch: 0, notified_epoch: -1 },
    run_start_epoch: 0,
  }))
  await writeFile(join(stateDir, 'tasks', 'st_00000003.json'), JSON.stringify({
    task_id: 'st_00000003',
    parent_session_id: 'sess-queue',
    root_session_id: 'sess-queue',
    status: 'error',
    failure_kind: 'model_chain_exhausted',
    failure_reason: 'model_not_in_child_profile',
    notification: { run_epoch: 1, notified_epoch: -1 },
    run_start_epoch: 0,
  }))

  const entries: SessionEntry[] = [
    { id: 'settings', type: 'custom', timestamp: '', customType: 'vargus-settings',
      data: { enabled: true, options: { repo: false, branch: false, status: false } } },
    { id: 'r1', type: 'message', timestamp: '', message: {
      role: 'toolResult', toolCallId: 'c1', toolName: 'task',
      details: { mode: 'spawn', task_id: 'st_00000001', run_epoch: 0, status: 'running', run_in_background: true },
    } },
    { id: 'r2', type: 'message', timestamp: '', message: {
      role: 'toolResult', toolCallId: 'c2', toolName: 'task',
      details: {
        mode: 'spawn',
        task_id: 'st_00000002',
        run_epoch: 0,
        status: 'pending',
        queue_position: 1,
        run_in_background: true,
        skills: { requested: ['audit'], resolved: ['audit'], missing: [] },
      },
    } },
    // Synchronous two-model fallback exhaustion from failedStartDetail() carrying skills.resolved.
    { id: 'r3', type: 'message', timestamp: '', message: {
      role: 'toolResult', toolCallId: 'c3', toolName: 'task',
      details: {
        mode: 'spawn',
        status: 'error',
        items: [{
          task_id: 'st_00000003',
          status: 'error',
          failure_kind: 'model_chain_exhausted',
          failure_reason: 'model_not_in_child_profile',
          skills: { requested: ['audit'], resolved: ['audit'], missing: [] },
        }],
      },
    } },
  ]
  const memo = new Map<object, { state: unknown; through: number }>()
  const handlers = new Map<string, (event: unknown, ctx: Context) => void>()
  type Context = Parameters<Parameters<OmoApi['on']>[1]>[1]
  let command: Parameters<OmoApi['registerCommand']>[1] | undefined
  let row: { render(width: number): string[]; invalidate(): void } | undefined
  let onRender: (() => void) | undefined
  let getSessionIdCalls = 0
  const ctx: Context = {
    modelRegistry: { getProviderAuth: async () => undefined },
    mode: 'tui', cwd: project, model: { id: 'gpt-6.1-sol', provider: 'test' }, thinkingLevel: 'high',
    getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    sessionManager: {
      getSessionId: () => { getSessionIdCalls++; return 'sess-queue' },
      getEntry: id => entries.find(entry => entry.id === id),
      getHeader: () => ({ timestamp: '2026-11-14T00:00:00Z' }),
      reduceHistory<S>(reducer: HistoryReducer<S>): S {
        const previous = memo.get(reducer)
        let state = previous ? previous.state as S : reducer.initial()
        for (let i = previous?.through ?? 0; i < entries.length; i++) {
          state = reducer.add(state, entries[i]!)
        }
        memo.set(reducer, { state, through: entries.length })
        return state
      },
    },
    ui: {
      setFooter() {},
      setWidget(_key, factory) { row = factory?.({ requestRender() { onRender?.() } }) },
      notify() {},
    },
  }
  const api: OmoApi = {
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    getSubscriptionLimits: () => [],
    onSubscriptionLimits: () => () => {},
    appendEntry(customType, data) {
      entries.push({ id: String(entries.length), type: 'custom', timestamp: '', customType, data })
    },
    registerCommand(_name, value) { command = value },
  }
  const lineText = () => row?.render(200).join('') ?? ''
  const waitForLine = (pattern: RegExp) => new Promise<string>((resolveWait, rejectWait) => {
    const check = () => {
      const current = lineText()
      if (pattern.test(current)) {
        clearTimeout(timeout)
        onRender = undefined
        resolveWait(current)
      }
    }
    const timeout = setTimeout(() => {
      onRender = undefined
      rejectWait(new Error(`Timed out waiting for ${pattern}; got: ${lineText()}`))
    }, 3000)
    onRender = check
    check()
  })

  let now = 400_000
  t.mock.method(Date, 'now', () => now)
  vargus(api, {})
  handlers.get('session_start')?.({}, ctx)
  try {
    // Default on: store scan confirms st_00000002's run-0 refusal and reconciles it and `audit` away -> 🤖1, no skill.
    const reconciledLine = await waitForLine(/(?:🤖1|A:1)(?!.*(?:⚡|S:))/)
    assert.doesNotMatch(reconciledLine, /⚡|S:/)

    // Toggle includeSubagents off: zero task-store reads; st_00000003 is excluded by receipt,
    // while queued st_00000002 remains pending in main-only view (🤖2, no skills).
    await command!.handler('config {"includeSubagents":false}', ctx)
    const offLine = lineText()
    assert.match(offLine, /🤖2|A:2/)
    assert.doesNotMatch(offLine, /⚡|S:/)
    const callsOff = getSessionIdCalls
    handlers.get('thinking_level_select')?.({}, ctx)
    assert.equal(getSessionIdCalls, callsOff)

    // Re-enable includeSubagents: re-scans and reconciles st_00000002 before expiry.
    await command!.handler('config {"includeSubagents":true}', ctx)
    await waitForLine(/(?:🤖1|A:1)(?!.*(?:⚡|S:))/)

    // Expiry removes the store record while the parent's queued receipt survives.
    await rm(join(stateDir, 'tasks', 'st_00000002.json'))
    now += 24 * 60 * 60 * 1000
    const refresh = t.mock.method(OmoSubagents.prototype, 'refresh')
    handlers.get('tool_execution_end')?.({}, ctx)
    await refresh.mock.calls[0]!.result
    refresh.mock.restore()
    const afterExpiry = lineText()
    assert.match(afterExpiry, /(?:🤖1|A:1)\b/)
    assert.doesNotMatch(afterExpiry, /⚡|S:/)

    // 2. Other OmO 5.1.61 provisional receipt shapes reconciled against store refusals:
    //    - queued task whose fallback chain exhausted at admission (run_epoch 0 -> 1, run_start_epoch 0)
    //    - foreground batch recordOutput() (`status:'error'` without `failure_kind`)
    //    - slow background launch >250ms (`status:'running'` without `effective_model`)
    //    - held admission (`status:'paused'` without `run_epoch`)
    for (const [taskId, record] of [
      ['st_00000004', {
        task_id: 'st_00000004', parent_session_id: 'sess-queue', root_session_id: 'sess-queue',
        status: 'error', failure_kind: 'model_chain_exhausted', failure_reason: 'model_not_in_child_profile',
        notification: { run_epoch: 1, notified_epoch: -1 }, run_start_epoch: 0,
      }],
      ['st_00000007', {
        task_id: 'st_00000007', parent_session_id: 'sess-queue', root_session_id: 'sess-queue',
        status: 'error', failure_kind: 'model_unavailable', failure_reason: 'model_not_in_child_profile',
        notification: { run_epoch: 0, notified_epoch: -1 }, run_start_epoch: 0,
      }],
      ['st_00000008', {
        task_id: 'st_00000008', parent_session_id: 'sess-queue', root_session_id: 'sess-queue',
        status: 'error', failure_kind: 'model_unavailable', failure_reason: 'catalog_probe_failed',
        notification: { run_epoch: 0, notified_epoch: -1 }, run_start_epoch: 0,
      }],
      ['st_00000009', {
        task_id: 'st_00000009', parent_session_id: 'sess-queue', root_session_id: 'sess-queue',
        status: 'error', failure_kind: 'session_unavailable',
        notification: { run_epoch: 0, notified_epoch: -1 }, run_start_epoch: 0,
      }],
    ] as const) {
      await writeFile(join(stateDir, 'tasks', `${taskId}.json`), JSON.stringify(record))
    }
    entries.push(
      {
        id: 'r4', type: 'message', timestamp: '', message: {
          role: 'toolResult', toolCallId: 'c4', toolName: 'task',
          details: {
            mode: 'spawn', task_id: 'st_00000004', run_epoch: 0, status: 'pending', queue_position: 1,
            skills: { requested: ['audit'], resolved: ['audit'], missing: [] },
          },
        },
      },
      {
        id: 'r4-batch-and-slow', type: 'message', timestamp: '', message: {
          role: 'toolResult', toolCallId: 'c4b', toolName: 'task',
          details: {
            mode: 'spawn', status: 'error',
            items: [
              {
                task_id: 'st_00000007', run_epoch: 0, status: 'error', error_message: 'model unavailable',
                skills: { requested: ['batch-audit'], resolved: ['batch-audit'], missing: [] },
              },
              {
                task_id: 'st_00000008', run_epoch: 0, status: 'running',
                skills: { requested: ['slow-audit'], resolved: ['slow-audit'], missing: [] },
              },
              { task_id: 'st_00000009', status: 'paused' },
            ],
          },
        },
      },
    )
    now += 2000
    handlers.get('tool_execution_end')?.({}, ctx)
    await waitForLine(/(?:🤖1|A:1)(?!.*(?:⚡|S:))/)

    // 3. Control: mid-turn chain exhaustion (child started, child_session_id stored, failure_kind:'model_chain_exhausted',
    //    no failure_reason) keeps BOTH the agent and its resolved skill (`audit`) -> 🤖2 ⚡1.
    await writeFile(join(stateDir, 'tasks', 'st_00000005.json'), JSON.stringify({
      task_id: 'st_00000005',
      parent_session_id: 'sess-queue',
      root_session_id: 'sess-queue',
      child_session_id: 'child-5',
      status: 'error',
      failure_kind: 'model_chain_exhausted',
      notification: { run_epoch: 1, notified_epoch: 1 },
      run_start_epoch: 0,
    }))
    entries.push({
      id: 'r5', type: 'message', timestamp: '', message: {
        role: 'toolResult', toolCallId: 'c5', toolName: 'task',
        details: {
          mode: 'spawn', task_id: 'st_00000005', run_epoch: 1, status: 'error',
          failure_kind: 'model_chain_exhausted',
          skills: { requested: ['audit'], resolved: ['audit'], missing: [] },
        },
      },
    })
    now += 2000
    handlers.get('tool_execution_end')?.({}, ctx)
    await waitForLine(/🤖2 ⚡1|A:2 S:1/)

    // 4. Reused task_id: previously launched run 0 (completed or run_epoch 0) MUST stay counted even when
    //    a later run 1 on the same task_id is refused in the store -> 🤖3 ⚡2 (retaining `kept`, dropping `refused`).
    await writeFile(join(stateDir, 'tasks', 'st_00000006.json'), JSON.stringify({
      task_id: 'st_00000006',
      parent_session_id: 'sess-queue',
      root_session_id: 'sess-queue',
      status: 'error',
      failure_kind: 'model_unavailable',
      failure_reason: 'model_not_in_child_profile',
      notification: { run_epoch: 1, notified_epoch: -1 },
      run_start_epoch: 1,
    }))
    entries.push(
      {
        id: 'r6-run0', type: 'message', timestamp: '', message: {
          role: 'toolResult', toolCallId: 'c6a', toolName: 'task',
          details: {
            mode: 'spawn', task_id: 'st_00000006', run_epoch: 0, status: 'pending', queue_position: 1,
            skills: { requested: ['kept'], resolved: ['kept'], missing: [] },
          },
        },
      },
      {
        id: 'r6-run1', type: 'message', timestamp: '', message: {
          role: 'toolResult', toolCallId: 'c6b', toolName: 'task',
          details: {
            mode: 'spawn', task_id: 'st_00000006', run_epoch: 1, status: 'pending', queue_position: 1,
            skills: { requested: ['refused'], resolved: ['refused'], missing: [] },
          },
        },
      },
    )
    now += 2000
    handlers.get('tool_execution_end')?.({}, ctx)
    await waitForLine(/🤖3 ⚡2|A:3 S:2/)

    // 5. Failed update after appending a new provisional skill onto existing st_00000006 must keep committed snapshot atomic.
    entries.push({
      id: 'r6-extra', type: 'message', timestamp: '', message: {
        role: 'toolResult', toolCallId: 'c6c', toolName: 'task',
        details: {
          mode: 'spawn', task_id: 'st_00000006', run_epoch: 0, status: 'pending', queue_position: 1,
          skills: { requested: ['extra'], resolved: ['extra'], missing: [] },
        },
      },
    })
    const savedGetSessionId = ctx.sessionManager.getSessionId
    ctx.sessionManager.getSessionId = () => { throw new Error('session id unavailable') }
    handlers.get('thinking_level_select')?.({}, ctx)
    assert.match(lineText(), /🤖3 ⚡2|A:3 S:2/)
    ctx.sessionManager.getSessionId = savedGetSessionId
    handlers.get('thinking_level_select')?.({}, ctx)
    assert.match(lineText(), /🤖3 ⚡3|A:3 S:3/)
  } finally {
    handlers.get('session_shutdown')?.({}, ctx)
  }

  // 6. Single-task session whose ONLY task was queued and then refused in the store (0 sub tokens, 0 tools, 0 taskIds):
  //    reconciliation MUST still apply and drop the row from 🤖1 ⚡1 down to zero agents and zero skills.
  const soleProject = join(dir, 'sole-project')
  await mkdir(soleProject, { recursive: true })
  const soleStateDir = join(agentDir, 'projects', projectStateKey(soleProject), 'senpi-task')
  await mkdir(join(soleStateDir, 'tasks'), { recursive: true })
  await writeFile(join(soleStateDir, 'tasks', 'st_0000000a.json'), JSON.stringify({
    task_id: 'st_0000000a',
    parent_session_id: 'sess-sole',
    root_session_id: 'sess-sole',
    status: 'error',
    failure_kind: 'model_unavailable',
    failure_reason: 'model_not_in_child_profile',
    notification: { run_epoch: 0, notified_epoch: -1 },
    run_start_epoch: 0,
  }))
  const soleEntries: SessionEntry[] = [
    { id: 's', type: 'custom', timestamp: '', customType: 'vargus-settings',
      data: { enabled: true, options: { repo: false, branch: false, status: false } } },
    { id: 'r1', type: 'message', timestamp: '', message: {
      role: 'toolResult', toolCallId: 'c1', toolName: 'task',
      details: {
        mode: 'spawn', task_id: 'st_0000000a', run_epoch: 0, status: 'pending', queue_position: 1,
        skills: { requested: ['audit'], resolved: ['audit'], missing: [] },
      },
    } },
  ]
  const soleHandlers = new Map<string, (event: unknown, ctx: Context) => void>()
  let soleRow: { render(width: number): string[]; invalidate(): void } | undefined
  let soleOnRender: (() => void) | undefined
  const soleCtx: Context = {
    modelRegistry: { getProviderAuth: async () => undefined },
    mode: 'tui', cwd: soleProject, model: { id: 'gpt-6.1-sol', provider: 'test' }, thinkingLevel: 'high',
    getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    sessionManager: {
      getSessionId: () => 'sess-sole',
      getEntry: id => soleEntries.find(entry => entry.id === id),
      getHeader: () => ({ timestamp: '2026-11-14T00:00:00Z' }),
      reduceHistory: reducer => soleEntries.reduce((state, entry) => reducer.add(state, entry), reducer.initial()),
    },
    ui: {
      setFooter() {},
      setWidget(_key, factory) { soleRow = factory?.({ requestRender() { soleOnRender?.() } }) },
      notify() {},
    },
  }
  const soleApi: OmoApi = {
    on(name, handler) { soleHandlers.set(name, handler); return () => soleHandlers.delete(name) },
    getSubscriptionLimits: () => [],
    onSubscriptionLimits: () => () => {},
    appendEntry() {},
    registerCommand() {},
  }
  vargus(soleApi, {})
  soleHandlers.get('session_start')?.({}, soleCtx)
  try {
    await new Promise<void>((resolveWait, rejectWait) => {
      const check = () => {
        const current = soleRow?.render(200).join('') ?? ''
        if (!/(?:🤖|⚡|A:|S:)/.test(current)) {
          clearTimeout(timeout)
          soleOnRender = undefined
          resolveWait()
        }
      }
      const timeout = setTimeout(() => {
        soleOnRender = undefined
        rejectWait(new Error(`Timed out waiting for sole refused task to clear; got: ${soleRow?.render(200).join('')}`))
      }, 3000)
      soleOnRender = check
      check()
    })
    assert.doesNotMatch(soleRow?.render(200).join('') ?? '', /🤖|⚡|A:|S:/)
  } finally {
    soleHandlers.get('session_shutdown')?.({}, soleCtx)
  }
})

test('OmO token alert threshold switches from 4M (default) to 1M when toggling includeSubagents', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-omo-token-alert-'))
  const savedNoColor = process.env.NO_COLOR
  const savedAgentDir = process.env.OMO_CODING_AGENT_DIR
  const savedHome = process.env.HOME
  const h = host('tui', dir)
  try {
    delete process.env.NO_COLOR
    process.env.HOME = dir
    process.env.OMO_CODING_AGENT_DIR = join(dir, 'agent')
    h.append({
      id: 'm1', type: 'message', timestamp: '2026-11-24T00:00:01Z',
      message: { role: 'assistant', usage: { input: 1_500_000, output: 0, cacheRead: 0, cacheWrite: 0 } },
    })
    h.load()
    h.event('session_start')

    const colored = makeTheme('omo-violet', false)
    const tokenText = (tone: 'calm' | 'alert', value: string) =>
      colored.paint('label', 'token:') + colored.paint(tone, value)

    assert.ok((h.row?.render(200).join('') ?? '').includes(tokenText('calm', '1.50M')))

    await h.command('config {"includeSubagents":false}')
    assert.ok((h.row?.render(200).join('') ?? '').includes(tokenText('alert', '1.50M')))

    await h.command('config {"includeSubagents":true}')
    assert.ok((h.row?.render(200).join('') ?? '').includes(tokenText('calm', '1.50M')))

    h.append({
      id: 'm2', type: 'message', timestamp: '2026-11-24T00:00:02Z',
      message: { role: 'assistant', usage: { input: 2_494_999, output: 0, cacheRead: 0, cacheWrite: 0 } },
    })
    h.event('message_end', { message: { role: 'assistant' } })
    assert.ok((h.row?.render(200).join('') ?? '').includes(tokenText('calm', '3.99M')))

    await h.command('config {"includeSubagents":false}')
    assert.ok((h.row?.render(200).join('') ?? '').includes(tokenText('alert', '3.99M')))

    await h.command('config {"includeSubagents":true}')
    assert.ok((h.row?.render(200).join('') ?? '').includes(tokenText('calm', '3.99M')))

    h.append({
      id: 'm3', type: 'message', timestamp: '2026-11-24T00:00:03Z',
      message: { role: 'assistant', usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } },
    })
    h.event('message_end', { message: { role: 'assistant' } })
    assert.ok((h.row?.render(200).join('') ?? '').includes(tokenText('alert', '4.00M')))
  } finally {
    h.event('session_shutdown')
    if (savedNoColor === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = savedNoColor
    if (savedAgentDir === undefined) delete process.env.OMO_CODING_AGENT_DIR
    else process.env.OMO_CODING_AGENT_DIR = savedAgentDir
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    await rm(dir, { recursive: true, force: true })
  }
})

test('OmO auto theme defaults to omo-violet, supports explicit overrides, and falls back to graphite', async () => {
  const savedNoColor = process.env.NO_COLOR
  const h = host()
  try {
    delete process.env.NO_COLOR
    const omo = makeTheme('omo-violet', false)
    const graphite = makeTheme('graphite', false)
    h.load(); h.event('session_start')
    assert.ok((h.row?.render(200).join('') ?? '').includes(omo.paint('sep', ' | ')))

    await h.command('config {"theme":" Auto "}')
    assert.ok((h.row?.render(200).join('') ?? '').includes(omo.paint('sep', ' | ')))

    await h.command('config {"theme":"graphite"}')
    assert.ok((h.row?.render(200).join('') ?? '').includes(graphite.paint('sep', ' | ')))

    await h.command('config {"theme":"nope"}')
    assert.ok((h.row?.render(200).join('') ?? '').includes(graphite.paint('sep', ' | ')))
  } finally {
    h.event('session_shutdown')
    if (savedNoColor === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = savedNoColor
  }
})

test('OmO live-reloads checkout vargus.jsonc edits and deletions in place, preserves t/s and overrides, and isolates explicit fileOptions', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-omo-live-config-'))
  const savedNoColor = process.env.NO_COLOR
  const savedAgentDir = process.env.OMO_CODING_AGENT_DIR
  const savedHome = process.env.HOME
  const sessions: Array<ReturnType<typeof host>> = []
  try {
    delete process.env.NO_COLOR
    process.env.HOME = dir
    process.env.OMO_CODING_AGENT_DIR = join(dir, 'agent')
    const checkout = await fixtureCheckout(dir)
    const sharedConfig = join(checkout, 'vargus.jsonc')
    const explicitConfig = join(dir, 'explicit.jsonc')
    await writeFile(sharedConfig, '{"theme":"omo-violet"}')
    await writeFile(explicitConfig, '{"theme":"graphite"}')

    t.mock.timers.enable({ apis: ['setInterval'] })
    const mod = await import(pathToFileURL(join(checkout, 'src/hosts/omo/register.ts')).href + '?live')
    const omo = makeTheme('omo-violet', false)
    const graphite = makeTheme('graphite', false)
    const daylight = makeTheme('daylight', false)

    // 1. Default loader polls checkout vargus.jsonc every 1s, reconfigures in place, and keeps live t/s.
    const live = host('tui', dir)
    sessions.push(live)
    live.load(mod.default)
    live.event('session_start')
    const row = () => live.row?.render(200).join('') ?? ''
    assert.equal(live.listeners, 1)
    assert.ok(row().includes(omo.paint('sep', ' | ')))
    assert.match(row(), /sol/)

    // Establish a live decode t/s reading.
    let perf = 1000
    t.mock.method(performance, 'now', () => perf)
    const msg = { role: 'assistant', usage: { input: 100, output: 120, cacheRead: 400, cacheWrite: 0 }, stopReason: 'stop' }
    live.event('message_start', { message: { role: 'assistant' } })
    perf += 200
    live.event('message_update', { message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_start' } })
    perf += 800
    live.event('message_update', { message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_end' } })
    live.append({ id: 'm1', type: 'message', timestamp: '', message: msg })
    live.event('message_end', { message: msg })
    assert.match(row(), /150t\/s/)

    // Edit vargus.jsonc without /reload -> applies on next 1s tick and preserves 150t/s.
    await writeFile(sharedConfig, '{"theme":"graphite","model":false,"rateLimits":false}')
    t.mock.timers.tick(1000)
    assert.ok(row().includes(graphite.paint('sep', ' | ')))
    assert.doesNotMatch(row(), /sol/)
    assert.equal(live.listeners, 0)
    assert.match(row(), /150t\/s/)

    // Broken JSONC mid-edit retains the last valid options.
    await writeFile(sharedConfig, '{broken')
    t.mock.timers.tick(1000)
    assert.ok(row().includes(graphite.paint('sep', ' | ')))
    assert.doesNotMatch(row(), /sol/)
    assert.match(row(), /150t\/s/)

    // Deleting vargus.jsonc reverts to defaults on next 1s tick and preserves 150t/s.
    await rm(sharedConfig)
    t.mock.timers.tick(1000)
    assert.ok(row().includes(omo.paint('sep', ' | ')))
    assert.match(row(), /sol/)
    assert.equal(live.listeners, 1)
    assert.match(row(), /150t\/s/)

    // 2. configuredVargus keeps precedence: /vargus config > --config > vargus.jsonc > defaults.
    const layered = host('tui', dir)
    sessions.push(layered)
    layered.load(mod.configuredVargus(explicitConfig))
    layered.event('session_start')
    await layered.command('config {"model":false}')
    await writeFile(sharedConfig, '{"model":true,"context":false,"theme":"daylight"}')
    t.mock.timers.tick(1000)
    const layeredRow = layered.row?.render(200).join('') ?? ''
    assert.ok(layeredRow.includes(graphite.paint('sep', ' | ')))
    assert.doesNotMatch(layeredRow, /sol/)
    assert.doesNotMatch(layeredRow, /ctx:/)
    assert.equal(layeredRow.includes(daylight.paint('sep', ' | ')), false)

    // 3. Explicit fileOptions in vargus(api, {}) does not read or poll checkout vargus.jsonc.
    const explicitOnly = host('tui', dir)
    sessions.push(explicitOnly)
    explicitOnly.load(api => mod.default(api, {}))
    explicitOnly.event('session_start')
    t.mock.timers.tick(1000)
    assert.match(explicitOnly.row?.render(200).join('') ?? '', /sol/)
  } finally {
    for (const s of sessions) s.event('session_shutdown')
    if (savedNoColor === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = savedNoColor
    if (savedAgentDir === undefined) delete process.env.OMO_CODING_AGENT_DIR
    else process.env.OMO_CODING_AGENT_DIR = savedAgentDir
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    await rm(dir, { recursive: true, force: true })
  }
})
