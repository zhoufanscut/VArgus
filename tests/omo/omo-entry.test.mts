import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, lstat, mkdir, mkdtemp, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises'
import { fixtureCheckout } from '../checkout.mts'
import { tmpdir, release } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import vargus, { type OmoApi } from '../../src/hosts/omo/register.ts'
import { main } from '../../src/cli.ts'
import { collectOmoAgents } from '../../src/hosts/omo/collect.ts'
import { projectStateKey } from '../../src/hosts/omo/subagents.ts'
import type { HistoryReducer, SessionEntry } from '../../src/hosts/omo/contracts.ts'
import { makeTheme } from '../../src/theme/index.ts'

function host(mode = 'tui') {
  const entries: SessionEntry[] = []
  const handlers = new Map<string, (event: unknown, ctx: Context) => void>()
  type Context = Parameters<Parameters<OmoApi['on']>[1]>[1]
  let command: Parameters<OmoApi['registerCommand']>[1] | undefined
  let footerHidden = false
  let row: { render(width: number): string[]; invalidate(): void } | undefined
  let listeners = 0
  const ctx: Context = {
    modelRegistry: { getProviderAuth: async () => undefined },
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
  const isWsl = Boolean(process.env.WSL_DISTRO_NAME || process.env.WSLENV || /microsoft/i.test(release()))
  const theme = makeTheme('graphite', false)
  const staleMark = isWsl ? '!:stale' : '⌛stale'
  const styledSuffix = theme.paint('sep', ' | ') + (isWsl ? theme.paint('label', '!:stale') : '⌛' + theme.paint('label', 'stale'))
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

test('OmO includeSubagents defaults off, folds and deduplicates when toggled on, and keeps main metrics untouched', async t => {
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

  vargus(api, {})
  handlers.get('session_start')?.({}, ctx)
  try {
    // Default off: zero subagent reads, main-only counts (200 tokens, 88.9% cache, 1 tool, 1 agent).
    const offLine = lineText()
    assert.match(offLine, /token:200\(88\.9%\)/)
    assert.match(offLine, /🔧1 🤖1|T:1 A:1/)
    assert.equal(getSessionIdCalls, 0)

    // Toggle on via /vargus config: folds child (500 tok, 2 tools) + grandchild (300 tok, 1 tool) => 1.0k, 4 tools, 2 agents.
    // Cache hit (88.9%), decode t/s, and ctx (25%) stay strictly main-only; skills remain omitted.
    let now = 100_000
    t.mock.method(Date, 'now', () => now)
    let perf = 1000
    t.mock.method(performance, 'now', () => perf)
    await command!.handler('config {"includeSubagents":true}', ctx)
    const onLine = await waitForLine(/token:1\.0k\(88\.9%\)/)
    assert.match(onLine, /ctx:25%/)
    assert.match(onLine, /🔧4 🤖2|T:4 A:2/)
    assert.doesNotMatch(onLine, /⚡|S:/)
    assert.ok(renderCount > 0)
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

    // Toggling back off immediately reverts to main-only counts (400 tokens, 1 tool, 1 agent).
    await command!.handler('config {"includeSubagents":false}', ctx)
    const reverted = lineText()
    assert.match(reverted, /token:400\(88\.9%\)/)
    assert.match(reverted, /🔧1 🤖1|T:1 A:1/)

    // When both tokens and callCounts are false, includeSubagents: true performs no subagent scans.
    const callsBefore = getSessionIdCalls
    await command!.handler('config {"includeSubagents":true,"tokens":false,"callCounts":false}', ctx)
    assert.equal(getSessionIdCalls, callsBefore)
  } finally {
    handlers.get('session_shutdown')?.({}, ctx)
  }
})
