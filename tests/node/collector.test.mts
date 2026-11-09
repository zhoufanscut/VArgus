import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CodexCollector } from '../../src/hosts/codex/collect'
import { render } from '../../src/render'
import { DEFAULTS } from '../../src/options'
import { makeTheme } from '../../src/theme'
import { en } from '../../src/i18n/en'

const thread = (id: string, parentThreadId: string | null = null) => ({ id, parentThreadId, cwd: '/repo', createdAt: 1, model: 'gpt-6.1-sol', reasoningEffort: 'high' })
function start(c: CodexCollector, id = 'main') {
  c.fromClient({ id: 1, method: 'thread/start', params: {} })
  c.fromServer({ id: 1, result: { thread: thread(id), model: 'gpt-6.1-sol', reasoningEffort: 'high' } })
}
const usage = (threadId: string, inputTokens = 20000, cachedInputTokens = 16000, outputTokens = 400) => ({
  method: 'thread/tokenUsage/updated', params: { threadId, turnId: 'turn1', tokenUsage: {
    total: { inputTokens, cachedInputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    last: { inputTokens: 39000, cachedInputTokens: 30000, outputTokens: 1000, totalTokens: 40000 },
    modelContextWindow: 200000,
  } },
})

test('Codex readings: repeated cumulative totals, child attribution, short display and native context gauge', () => {
  const c = new CodexCollector('/repo', '/home/u', () => 60000)
  assert.equal(c.snapshot(), undefined)
  start(c)
  assert.equal(c.snapshot()!.session.contextPercent, undefined)
  c.fromServer(usage('main'))
  c.fromServer(usage('main'))
  assert.equal(c.snapshot()!.session.counts.tokens, 4400)
  assert.equal(c.snapshot()!.session.contextPercent, 15)
  c.fromServer({ method: 'thread/started', params: { thread: thread('child', 'main') } })
  c.fromServer(usage('child', 1000, 800, 100))
  assert.equal(c.active, 'main')
  assert.equal(c.snapshot()!.session.counts.tokens, 4700)
  const v = c.snapshot()!
  const text = render({ v, o: DEFAULTS, l: en, t: makeTheme('graphite', true), now: 60000 })
  assert.match(text, /sol:high/)
  assert.equal(v.session.model, 'gpt-6.1-sol')
  assert.match(text, /ctx:15%/)
  assert.match(text, /token:4\.7k/)
  c.fromServer({ method: 'item/started', params: { threadId: 'main', item: { id: 'compact1', type: 'contextCompaction' } } })
  assert.equal(c.snapshot()!.session.contextPercent, undefined)
  c.fromServer(usage('main'))
  assert.equal(c.snapshot()!.session.contextPercent, 15)
})

test('Codex thread switches isolate counts; failed requests do not change the active thread', () => {
  const c = new CodexCollector('/repo', undefined)
  start(c)
  c.fromServer(usage('main'))
  c.fromClient({ id: 2, method: 'thread/resume', params: { threadId: 'other' } })
  c.fromServer({ id: 2, error: { message: 'not found' } })
  assert.equal(c.active, 'main')
  c.fromClient({ id: 3, method: 'thread/resume', params: { threadId: 'other' } })
  c.fromServer({ id: 3, result: { thread: thread('other'), model: 'gpt-6-luna', reasoningEffort: 'low' } })
  assert.equal(c.snapshot()!.session.counts.tokens, 0)
  assert.equal(c.snapshot()!.session.model, 'gpt-6-luna')
  c.fromClient({ id: 4, method: 'turn/start', params: { threadId: 'other', model: 'gpt-6.1-sol', effort: 'xhigh', cwd: '/different' } })
  c.fromServer({ id: 4, result: { turn: {} } })
  assert.equal(c.snapshot()!.core.cwd, '/different')
  assert.equal(c.snapshot()!.session.effort, 'xhigh')
})

test('Codex quota windows use reported duration and sparse notifications preserve other windows', () => {
  const c = new CodexCollector('/repo', undefined)
  start(c)
  c.fromClient({ id: 2, method: 'account/rateLimits/read' })
  c.fromServer({ id: 2, result: { rateLimitsByLimitId: { codex: {
    primary: { usedPercent: 24, windowDurationMins: 300, resetsAt: 9000000000 },
    secondary: { usedPercent: 61, windowDurationMins: 10080, resetsAt: 9000000000 },
  } } } })
  c.fromServer({ method: 'account/rateLimits/updated', params: { rateLimits: {
    limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 15, resetsAt: 9000000000 }, secondary: null,
  } } })
  assert.deepEqual(c.snapshot()!.limits.engine.map(l => [l.label, l.percentUsed]), [['15m', 25], ['7d', 61]])
  c.fromServer({ method: 'account/updated', params: { authMode: null } })
  assert.deepEqual(c.snapshot()!.limits.engine, [])
})

test('item identities prevent duplicate tool counts; messages and subagent tools do not inflate lead counts', () => {
  const c = new CodexCollector('/repo', undefined)
  start(c)
  for (const item of [
    { id: 'tool1', type: 'commandExecution' }, { id: 'tool1', type: 'commandExecution' },
    { id: 'agent1', type: 'collabAgentToolCall', tool: 'spawnAgent' }, { id: 'message', type: 'agentMessage' },
  ]) c.fromServer({ method: 'item/started', params: { threadId: 'main', item } })
  c.fromServer({ method: 'item/started', params: { threadId: 'child', item: { id: 'tool2', type: 'commandExecution' } } })
  assert.deepEqual(c.snapshot()!.session.counts, { tokens: 0, tools: 2, agents: 1, skills: 0, workflows: 0 })
})

test('server requests with a colliding id do not consume a pending client request', () => {
  const c = new CodexCollector('/repo', undefined)
  c.fromClient({ id: 1, method: 'thread/start', params: {} })
  c.fromServer({ id: 1, method: 'item/commandExecution/requestApproval', params: {} })
  c.fromServer({ id: 1, result: { thread: thread('main'), model: 'gpt-6.1-sol' } })
  assert.equal(c.snapshot()!.session.model, 'gpt-6.1-sol')
})

test('title/recap helper requests cannot take over the selected user conversation', () => {
  const c = new CodexCollector('/repo', undefined)
  start(c)
  c.fromServer(usage('main'))
  for (const [index, source] of ['thread_title', 'system'].entries()) {
    const id = `helper-${index}`
    const helper = { ...thread(id), ephemeral: true, threadSource: source }
    c.fromClient({ id: `start-${id}`, method: 'thread/start', params: { ephemeral: true, threadSource: source } })
    c.fromServer({ id: `start-${id}`, result: { thread: helper, model: 'gpt-6-luna' } })
    c.fromServer({ method: 'thread/started', params: { thread: helper } })
    c.fromClient({ id: `turn-${id}`, method: 'turn/start', params: { threadId: id, effort: null } })
    c.fromServer({ id: `turn-${id}`, result: { turn: {} } })
    c.fromServer(usage(id, 777, 0, 9))
    assert.equal(c.active, 'main')
    assert.equal(c.snapshot()!.session.counts.tokens, 4400)
    assert.equal(c.snapshot()!.session.contextPercent, 15)
    assert.equal(c.snapshot()!.session.effort, 'high')
  }
  const user = { ...thread('temporary-user'), ephemeral: true, threadSource: 'user' }
  c.fromClient({ id: 9, method: 'thread/start', params: { ephemeral: true, threadSource: 'user' } })
  c.fromServer({ id: 9, result: { thread: user } })
  assert.equal(c.active, user.id)
  c.fromServer({ method: 'thread/started', params: { thread: thread('unsolicited-root') } })
  assert.equal(c.active, user.id)
})

test('explicit child selection shows that child and its descendants; null effort inherits', () => {
  const c = new CodexCollector('/repo', undefined)
  start(c)
  const child = { ...thread('child', 'main'), model: 'gpt-6-luna', reasoningEffort: 'low' }
  c.fromServer({ method: 'thread/started', params: { thread: child } })
  c.fromServer(usage('main', 2000, 500, 100))
  c.fromServer(usage('child', 700, 500, 50))
  assert.equal(c.snapshot()!.session.counts.tokens, 1850)
  c.fromClient({ id: 2, method: 'thread/resume', params: { threadId: 'child' } })
  c.fromServer({ id: 2, result: { thread: child, model: child.model, reasoningEffort: 'low' } })
  assert.equal(c.active, 'child')
  assert.equal(c.snapshot()!.session.counts.tokens, 250)
  c.fromClient({ id: 3, method: 'turn/start', params: { threadId: 'child', effort: null } })
  c.fromServer({ id: 3, result: { turn: {} } })
  assert.equal(c.snapshot()!.session.effort, 'low')
  assert.equal(c.snapshot()!.session.counts.tokens, 250)
})

test('full quota snapshots replace removed windows and buckets; sparse updates still merge', () => {
  const c = new CodexCollector('/repo', undefined)
  start(c)
  const window = { usedPercent: 24, windowDurationMins: 300, resetsAt: 9000000000 }
  c.fromClient({ id: 2, method: 'account/rateLimits/read' })
  c.fromServer({ id: 2, result: { rateLimitsByLimitId: {
    codex: { primary: window }, model: { normalModelSlug: 'gpt-6.1-sol', primary: { ...window, usedPercent: 70 } },
  } } })
  assert.equal(c.snapshot()!.limits.engine[0]!.percentUsed, 70)
  c.fromClient({ id: 3, method: 'account/rateLimits/read' })
  c.fromServer({ id: 3, result: { rateLimitsByLimitId: { codex: { primary: null, secondary: { ...window, windowDurationMins: 10080 } } } } })
  assert.deepEqual(c.snapshot()!.limits.engine.map(w => w.label), ['7d'])
  c.fromServer({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', primary: window, secondary: null } } })
  assert.deepEqual(c.snapshot()!.limits.engine.map(w => w.label), ['5h', '7d'])
})

test('legacy and V2 agent starts are deduplicated by their canonical call item identity', () => {
  const c = new CodexCollector('/repo', undefined)
  start(c)
  const item = { id: 'spawn-call', type: 'subAgentActivity', kind: 'started', agentThreadId: 'child' }
  c.fromServer({ method: 'item/started', params: { threadId: 'main', item } })
  c.fromServer({ method: 'item/started', params: { threadId: 'main', item } })
  c.fromServer({ method: 'item/completed', params: { threadId: 'main', item } })
  c.fromServer({ method: 'item/started', params: { threadId: 'main', item: { ...item, type: 'collabAgentToolCall', tool: 'spawnAgent' } } })
  assert.equal(c.snapshot()!.session.counts.agents, 1)
  assert.equal(c.snapshot()!.session.counts.tools, 1)
  c.fromServer(usage('child', 700, 500, 50))
  assert.equal(c.snapshot()!.session.counts.tokens, 250)
})

test('displayed thread selection follows cached views without changing RPC selection', () => {
  const c = new CodexCollector('/repo', undefined)
  start(c)
  const child = { ...thread('child', 'main'), source: { subAgent: { thread_spawn: { agent_path: '/root/child' } } } }
  c.fromServer({ method: 'thread/started', params: { thread: child } })
  c.fromServer(usage('main')); c.fromServer(usage('child', 700, 500, 50))
  const screen = (footer: string, composer = 'Viewing sub-agent — direct input is disabled') => ({
    lines: ['› ' + composer, '', footer], x: 2, y: 0, visible: true, command: 'codex',
  })
  for (let revisit = 0; revisit < 2; revisit++) {
    const selected = c.displayedThread(screen('`/root/child` · ← for agents'))
    assert.equal(selected, 'child')
    assert.equal(c.snapshot(selected)!.session.counts.tokens, 250)
    assert.equal(c.displayedThread(screen('Main [default]', 'Ask Codex to do anything')), 'main')
    assert.equal(c.snapshot('main')!.session.counts.tokens, 4650)
    assert.equal(c.active, 'main')
  }
  assert.equal(c.displayedThread(screen('`/root/chi…')), undefined)
  assert.equal(c.displayedThread(screen('`/foreign`')), undefined)
  assert.equal(c.displayedThread({ ...screen('`/root/child`'), visible: false }), undefined)
  const alias = { ...child, id: 'alias' }
  c.fromServer({ method: 'thread/started', params: { thread: alias } })
  assert.equal(c.displayedThread(screen('`/root/child`')), undefined)
  // Resume a child through RPC; Main still identifies the observed family root.
  c.fromClient({ id: 9, method: 'thread/resume' })
  c.fromServer({ id: 9, result: { thread: child } })
  assert.equal(c.active, 'child')
  assert.equal(c.displayedThread(screen('Main [default]', 'Ask Codex to do anything')), 'main')
})
