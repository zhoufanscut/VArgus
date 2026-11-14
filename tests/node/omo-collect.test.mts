import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_STALE_MS } from '../../src/core/limits.ts'
import { collectOmo, omoHistoryReducer, omoSettingsReducer, OMO_CONFIG_ENTRY } from '../../src/hosts/omo/collect.ts'
import type { AccountLimits, HistoryReducer, NativeContext, SessionEntry } from '../../src/hosts/omo/contracts.ts'

const now = Date.parse('2026-11-14T12:00:00Z')
const message = (id: string, value: unknown): SessionEntry => ({
  id, type: 'message', timestamp: new Date(now).toISOString(), message: value,
})
const call = (id: string, name: string, args: unknown = {}, runtimeItemKey?: string) => ({
  type: 'toolCall', id, name, arguments: args, ...(runtimeItemKey ? { runtimeItemKey } : {}),
})
const assistant = (id: string, content: unknown[] = [], input = 10, output = 2) => message(id, {
  role: 'assistant', content, usage: { input, output, cacheRead: 100, cacheWrite: 50, totalTokens: 162 },
})
const result = (id: string, toolCallId: string, toolName: string, details: unknown = {}, isError = false) =>
  message(id, { role: 'toolResult', toolCallId, toolName, details, isError, usage: { input: 10000, output: 5000 } })

function host(entries: SessionEntry[] = []) {
  const memo = new Map<object, { state: unknown; through: number }>()
  let folded = 0
  const ctx: NativeContext = {
    mode: 'tui', cwd: '/repo', model: { id: 'gpt-6.1-sol', provider: 'chatgpt-subscription' },
    thinkingLevel: 'high',
    sessionManager: {
      getSessionId: () => 'main',
      getHeader: () => ({ timestamp: new Date(now - 60000).toISOString() }),
      reduceHistory<S>(reducer: HistoryReducer<S>): S {
        const previous = memo.get(reducer)
        let state = previous ? previous.state as S : reducer.initial()
        for (let i = previous?.through ?? 0; i < entries.length; i++) {
          state = reducer.add(state, entries[i]!)
          folded++
        }
        memo.set(reducer, { state, through: entries.length })
        return state
      },
    },
    getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
  }
  return { ctx, entries, folded: () => folded }
}

test('main assistant input plus output excludes cache buckets and nested tool usage', () => {
  const h = host([assistant('a'), result('r', 'nested', 'task'), assistant('b', [], 20, 3)])
  const v = collectOmo(h.ctx, [], '/home/u', now)
  assert.equal(v.session.counts.tokens, 35)
  assert.equal(v.session.model, 'gpt-6.1-sol')
  assert.equal(v.session.effort, 'high')
  assert.equal(v.session.startedAt, now - 60000)
  assert.equal(v.core.host, 'omo')
  assert.equal(v.core.home, '/home/u')
  assert.equal(v.session.contextTokens, 100)
  assert.equal(v.session.contextPercent, 10)
  assert.equal(v.session.contextWindow, 1000)
})

test('stable reducer consumes only appended entries and resume reconstructs all branches', () => {
  const h = host([assistant('a')])
  const first = collectOmo(h.ctx, [], undefined, now)
  assert.equal(h.folded(), 1)
  collectOmo(h.ctx, [], undefined, now)
  assert.equal(h.folded(), 1)
  h.entries.push({ id: 'compaction', type: 'compaction', timestamp: new Date(now).toISOString() })
  h.entries.push(assistant('branch-b', [], 5, 1))
  const current = collectOmo(h.ctx, [], undefined, now)
  assert.equal(h.folded(), 3)
  assert.equal(current.session.counts.tokens, 18)
  assert.equal(first.session.counts.tokens, 12)
  assert.equal(collectOmo(host([...h.entries]).ctx, [], undefined, now).session.counts.tokens, 18)
  assert.equal(collectOmo(host().ctx, [], undefined, now).session.counts.tokens, 0)
})

test('tool counts use persisted main calls and deduplicate entries and runtime call keys', () => {
  const first = assistant('a', [call('same', 'eval', {}, 'exe:one'), call('same', 'read')])
  const h = host([first, first, assistant('b', [call('same', 'eval', {}, 'exe:one'), call('same', 'write')])])
  h.entries.push(result('nested', 'same/1', 'read', { nestedCalls: [{ name: 'bash' }], toolCallCount: 100 }))
  const v = collectOmo(h.ctx, [], undefined, now)
  assert.equal(v.session.counts.tools, 3)
  assert.equal(v.session.counts.tokens, 24)
  assert.equal(v.session.counts.agents, 0)
})

test('skill availability, SKILL.md reads and child load requests do not establish skill loads', () => {
  const h = host([
    assistant('a', [
      call('skill', 'read', { path: '/skills/bun/SKILL.md' }),
      call('failed', 'read', { path: '/skills/browser/SKILL.md' }),
      call('doc', 'read', { path: '/docs/skills.md' }),
      call('task', 'task', { load_skills: ['browser'] }),
    ]),
    result('r', 'skill', 'read'),
    result('r-duplicate', 'skill', 'read'),
    result('f', 'failed', 'read', {}, true),
    result('doc-r', 'doc', 'read'),
    message('catalog', { role: 'custom', customType: 'skills.catalog', details: { skills: ['bun', 'browser'] } }),
  ])
  assert.equal(collectOmo(h.ctx, [], undefined, now).session.counts.skills, 0)
})

test('agent identities and workflow notices count once without inferring requested or hidden work', () => {
  const h = host([
    assistant('a', [call('task', 'task', { tasks: [{}, {}, {}] })]),
    result('spawn', 'task', 'task', { mode: 'spawn', task_id: 'a', items: [{ task_id: 'a' }, { task_id: 'b' }, { task_id: '' }] }),
    result('again', 'task-2', 'task', { mode: 'spawn', task_id: 'a' }),
    result('output', 'out', 'task_output', { task_id: 'c' }),
    message('dag', { role: 'custom', customType: 'omo-senpi.dag-run', details: { runId: 'run-1', status: 'paused' } }),
    message('dag-end', { role: 'custom', customType: 'omo-senpi.dag-run', details: { runId: 'run-1', status: 'completed' } }),
  ])
  const counts = collectOmo(h.ctx, [], undefined, now).session.counts
  assert.equal(counts.agents, 2)
  assert.equal(counts.workflows, 1)
})

test('settings restore disabled state and full options across reload and malformed records', () => {
  const setting = (id: string, data: unknown): SessionEntry => ({
    id, type: 'custom', timestamp: new Date(now).toISOString(), customType: OMO_CONFIG_ENTRY, data,
  })
  const entries = [
    setting('off', { enabled: false, options: { tokens: false } }),
    setting('bad', []),
    setting('bad-values', { enabled: 'true', options: null }),
  ]
  const h = host(entries)
  assert.deepEqual(h.ctx.sessionManager.reduceHistory(omoSettingsReducer), {
    enabled: false, options: { tokens: false },
  })
  assert.deepEqual(host([...entries]).ctx.sessionManager.reduceHistory(omoSettingsReducer), {
    enabled: false, options: { tokens: false },
  })
  entries.push(setting('on', { enabled: true, options: { theme: 'graphite' } }))
  assert.deepEqual(h.ctx.sessionManager.reduceHistory(omoSettingsReducer), {
    enabled: true, options: { theme: 'graphite' },
  })
})

test('unknown context and invalid header stay unknown', () => {
  const h = host()
  h.ctx.getContextUsage = () => ({ tokens: null, percent: null, contextWindow: 1000 })
  h.ctx.sessionManager.getHeader = () => ({ timestamp: 'invalid' })
  const v = collectOmo(h.ctx, [], undefined, now)
  assert.equal(v.session.contextTokens, undefined)
  assert.equal(v.session.contextPercent, undefined)
  assert.equal(v.session.contextWindow, 1000)
  assert.equal(v.session.startedAt, undefined)
  h.ctx.getContextUsage = () => undefined
  assert.equal(collectOmo(h.ctx, [], undefined, now).session.contextWindow, undefined)
})

test('quotas show window labels without account names and preserve readings and stale errors', () => {
  const accounts: AccountLimits[] = [{
    provider: 'chatgpt-subscription', account: 'a', reportedAt: new Date(now - MAX_STALE_MS).toISOString(),
    windows: [
      { id: 'codex:primary', label: '5h', windowMinutes: 300, usedPercent: 0 },
      { id: 'codex:secondary', label: '7d', usedPercent: 40, resetsAt: new Date(now + 1000).toISOString() },
      { id: 'codex:review', label: 'review', windowMinutes: 120, usedPercent: 100 },
    ],
  }, {
    provider: 'chatgpt-subscription', account: 'b', reportedAt: new Date(now).toISOString(), error: 'auth stale',
    windows: [{ id: 'codex:primary', label: '5h', usedPercent: 50 }],
  }]
  const limits = collectOmo(host().ctx, accounts, undefined, now).limits
  assert.deepEqual(limits.engine.map(w => w.kind), ['five_hour', 'seven_day', 'codex:review', 'five_hour'])
  assert.deepEqual(limits.engine.map(w => w.percentUsed), [0, 40, 100, 50])
  assert.deepEqual(limits.engine.map(w => w.label), ['5h', '7d', 'review', '5h'])
  assert.equal(limits.engine[3]?.stale, true)
  assert.equal(limits.engine[0]?.stale, undefined)
  assert.equal(limits.engine[1]?.resetsAt, new Date(now + 1000).toISOString())
})

test('expired, invalid and unsupported quota values never become zero readings', () => {
  const fresh = { provider: 'p', account: 'a', reportedAt: new Date(now).toISOString() }
  const windows = [{ id: 'x', label: 'x', usedPercent: 10 }]
  const limits = collectOmo(host().ctx, [
    { ...fresh, windows, reportedAt: new Date(now - MAX_STALE_MS - 1).toISOString() },
    { ...fresh, windows, reportedAt: 'invalid' },
    { ...fresh, windows: [
      { id: 'nan', label: 'nan', usedPercent: NaN },
      { id: 'negative', label: 'negative', usedPercent: -1 },
      { id: 'overflow', label: 'overflow', usedPercent: 101 },
    ] },
  ], undefined, now).limits
  assert.deepEqual(limits.engine, [])
  assert.equal(limits.api, null)
})

test('malformed persisted message data is ignored at the host boundary', () => {
  const h = host([
    message('null', null), message('array', []),
    message('bad', { role: 'assistant', usage: { input: NaN, output: -1 }, content: [null, {}] }),
  ])
  assert.deepEqual(collectOmo(h.ctx, [], undefined, now).session.counts, {
    tokens: 0, tools: 0, agents: 0, skills: 0, workflows: 0,
  })
  assert.equal(h.ctx.sessionManager.reduceHistory(omoHistoryReducer).counts.tokens, 0)
})
