import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_STALE_MS } from '../../src/core/limits.ts'
import {
  collectOmo,
  collectOmoAgents,
  collectOmoSubagentSkills,
  createOmoHistory,
  foldOmoEntry,
  omoHistoryReducer,
  omoSettingsReducer,
  OMO_CONFIG_ENTRY,
} from '../../src/hosts/omo/collect.ts'
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
  assert.equal(v.session.defaultEffort, undefined)
  const withDefault = collectOmo({ ...h.ctx, model: { ...h.ctx.model!, defaultThinkingLevel: 'medium' } }, [], '/home/u', now)
  assert.equal(withDefault.session.defaultEffort, 'medium')
  assert.equal(withDefault.session.effort, 'high')
  assert.equal(v.session.startedAt, now - 60000)
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
  assert.equal(collectOmoSubagentSkills(h.ctx).size, 0)
})

test('agent counts use distinct task IDs from accepted spawns', () => {
  const h = host([
    assistant('a', [call('task', 'task', { tasks: [{}, {}, {}] })]),
    result('spawn', 'task', 'task', { mode: 'spawn', task_id: 'a', items: [{ task_id: 'a' }, { task_id: 'b' }, { task_id: '' }] }),
    result('again', 'task-2', 'task', { mode: 'spawn', task_id: 'a' }),
    result('output', 'out', 'task_output', { task_id: 'c' }),
    message('dag', { role: 'custom', customType: 'omo-senpi.dag-run', details: { runId: 'run-1', status: 'paused' } }),
  ])
  const counts = collectOmo(h.ctx, [], undefined, now).session.counts
  assert.deepEqual(counts, { tokens: 12, tools: 1, agents: 2, skills: 0 })
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

test('quotas show window labels without account names, omit spend_limit, and keep recent readings on error without stale marks', () => {
  const accounts: AccountLimits[] = [{
    provider: 'chatgpt-subscription', account: 'a', reportedAt: new Date(now - MAX_STALE_MS).toISOString(),
    windows: [
      { id: 'codex:primary', label: '5h', windowMinutes: 300, usedPercent: 0 },
      { id: 'codex:secondary', label: '7d', usedPercent: 40, resetsAt: new Date(now + 1000).toISOString() },
      { id: 'spend_limit', label: 'spend', usedPercent: 63 },
      { id: 'spend_limit', label: 'spend', windowMinutes: 10080, usedPercent: 55 },
      { id: 'spend_limit', label: '5h', windowMinutes: 300, usedPercent: 20 },
      { id: 'codex:review', label: 'review', windowMinutes: 120, usedPercent: 100 },
    ],
  }, {
    provider: 'chatgpt-subscription', account: 'b', reportedAt: new Date(now).toISOString(), error: 'auth stale',
    windows: [{ id: 'codex:primary', label: '5h', usedPercent: 50 }],
  }]
  const limits = collectOmo(host().ctx, accounts, undefined, now).limits
  assert.deepEqual(limits, [
    { label: '5h', percent: 0, resetsAt: null },
    { label: '5h', percent: 50, resetsAt: null },
    { label: '7d', percent: 40, resetsAt: now + 1000 },
    { label: 'review', percent: 100, resetsAt: null },
  ])
})

test('expired, invalid and unsupported quota values never become zero readings', () => {
  const fresh = { provider: 'chatgpt-subscription', account: 'a', reportedAt: new Date(now).toISOString() }
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
  assert.deepEqual(limits, [])
})

test('quota windows follow the selected provider across subscription and API model switches', () => {
  const ctx = host().ctx
  const accounts: AccountLimits[] = [
    { provider: 'chatgpt-subscription', account: 'chatgpt', reportedAt: new Date(now).toISOString(),
      windows: [{ id: '5h', label: '5h', usedPercent: 37 }] },
    { provider: 'kimi-coding', account: 'kimi', reportedAt: new Date(now).toISOString(),
      windows: [{ id: 'monthly', label: '1mo', usedPercent: 62 }] },
  ]
  for (const [provider, expected] of [
    ['chatgpt-subscription', [37]], ['kimi-coding', [62]], ['deepseek', []],
  ] as const) {
    const selected = { ...ctx, model: { id: 'model', provider } }
    assert.deepEqual(collectOmo(selected, accounts, undefined, now).limits.map(w => typeof w === 'string' ? w : w.percent), expected)
  }
  assert.deepEqual(collectOmo({ ...ctx, model: undefined }, accounts, undefined, now).limits, [])
})

test('malformed persisted message data is ignored at the host boundary', () => {
  const h = host([
    message('null', null), message('array', []),
    message('bad', { role: 'assistant', usage: { input: NaN, output: -1 }, content: [null, {}] }),
  ])
  assert.deepEqual(collectOmo(h.ctx, [], undefined, now).session.counts, {
    tokens: 0, tools: 0, agents: 0, skills: 0,
  })
  assert.equal(h.ctx.sessionManager.reduceHistory(omoHistoryReducer).counts.tokens, 0)
})

test('foldOmoEntry counts id-less JSONL entries separately and collectOmoAgents exposes memoized agents', () => {
  const state = createOmoHistory()
  foldOmoEntry(state, {
    type: 'message',
    message: { role: 'assistant', content: [call('c1', 'read')], usage: { input: 10, output: 5 } },
  }, 'line:0')
  foldOmoEntry(state, {
    id: '',
    type: 'message',
    message: { role: 'assistant', content: [call('c2', 'write')], usage: { input: 20, output: 10 } },
  }, 'line:1')
  assert.deepEqual(state.counts, { tokens: 45, tools: 2, agents: 0, skills: 0 })
  assert.equal(state.entries.size, 0)

  const h = host([
    assistant('a', [call('t1', 'task')]),
    result('r1', 't1', 'task', { mode: 'spawn', items: [{ task_id: 'st_00000001' }, { task_id: 'st_00000002' }] }),
  ])
  assert.deepEqual([...collectOmoAgents(h.ctx)].sort(), ['st_00000001', 'st_00000002'])
})

test('agent counts exclude confirmed pre-launch refusals while keeping runtime errors and earlier accepted runs', () => {
  // 1. Single spawn receipts: refused model_unavailable vs completed.
  const single = host([
    assistant('a1', [call('t1', 'task'), call('t2', 'task')]),
    result('r1', 't1', 'task', {
      mode: 'spawn',
      task_id: 'st_00000001',
      status: 'error',
      failure_kind: 'model_unavailable',
      failure_reason: 'model_not_in_child_profile',
    }),
    result('r2', 't2', 'task', { mode: 'spawn', task_id: 'st_00000002', status: 'completed' }),
  ])
  assert.deepEqual([...collectOmoAgents(single.ctx)], ['st_00000002'])
  assert.equal(collectOmo(single.ctx, [], undefined, now).session.counts.agents, 1)

  // 2. Batch details.items[]: pre-launch refusals (with or without failure_reason) are excluded individually,
  //    while bare status:'error', post-launch failure kinds, and tasks with run_stats still count.
  const batch = host([
    assistant('b1', [call('tb', 'task')]),
    result('rb', 'tb', 'task', {
      mode: 'spawn',
      status: 'error',
      items: [
        { task_id: 'st_00000001', status: 'error', failure_kind: 'model_unavailable', failure_reason: 'model_not_in_child_profile' },
        { task_id: 'st_0000000a', status: 'error', failure_kind: 'model_unavailable' },
        { task_id: 'st_0000000b', status: 'error', failure_kind: 'tools_unavailable' },
        { task_id: 'st_0000000c', status: 'error', failure_kind: 'isolation_unavailable' },
        { task_id: 'st_0000000d', status: 'error', failure_kind: 'depth-exceeded' },
        { task_id: 'st_0000000e', status: 'error', failure_kind: 'session-create-failed' },
        { task_id: 'st_0000000f', status: 'error', failure_kind: 'host_unavailable' },
        { task_id: 'st_00000010', status: 'error', failure_kind: 'session_unavailable' },
        { task_id: 'st_00000002', status: 'completed' },
        { task_id: 'st_00000003', status: 'error', error_message: 'tool failed during run' },
        { task_id: 'st_00000004', status: 'error', failure_kind: 'child-unresponsive' },
        { task_id: 'st_00000005', status: 'error', failure_kind: 'model_chain_exhausted' },
        { task_id: 'st_00000006', status: 'error', failure_kind: 'session_unavailable', run_stats: { tool_calls: 1 } },
        { task_id: 'st_00000007', status: 'error', failure_kind: 'host_unavailable', effective_model: { model_id: 'gpt-6.1-sol' } },
        { task_id: 'st_00000008', status: 'error', failure_kind: 'host_unavailable', effective_model: 'openai/gpt-6.1-sol' },
        { task_id: 'st_00000009', status: 'error', failure_kind: 'session_unavailable', host_session: { id: 'hs-1' } },
        { task_id: 'st_00000011', status: 'error', failure_kind: 'host_unavailable', pid: 4321 },
      ],
    }),
  ])
  assert.deepEqual(
    [...collectOmoAgents(batch.ctx)].sort(),
    ['st_00000002', 'st_00000003', 'st_00000004', 'st_00000005', 'st_00000006', 'st_00000007', 'st_00000008', 'st_00000009', 'st_00000011'],
  )

  // 3. Reused task_id: an earlier accepted run is never dropped by a later pre-launch refusal.
  const reused = host([
    result('u1', 'tu1', 'task', { mode: 'spawn', task_id: 'st_00000002', status: 'completed' }),
    result('u2', 'tu2', 'task', {
      mode: 'spawn',
      task_id: 'st_00000002',
      status: 'error',
      failure_kind: 'model_unavailable',
      failure_reason: 'model_not_in_child_profile',
    }),
  ])
  assert.deepEqual([...collectOmoAgents(reused.ctx)], ['st_00000002'])
})

test('explicitly resolved task skills attribute to accepted children, exclude missing/refusals, and deduplicate replays', () => {
  // 1. Upstream OmO 5.1.61 single spawn receipt: 1 resolved + 1 missing -> 0 main skills, 1 child skill.
  const single = host([
    assistant('a1', [call('t1', 'task', { load_skills: ['audit', 'missing'] })]),
    result('r1', 't1', 'task', {
      mode: 'spawn',
      task_id: 'st_00000001',
      status: 'completed',
      skills: {
        requested: ['audit', 'missing'],
        resolved: ['audit'],
        missing: ['missing'],
        rejected: [{ name: 'unsafe', reason: 'blocked' }],
      },
    }),
    // Replaying the exact same receipt (same entry id or a second receipt for the same task_id) must not double-count.
    result('r1', 't1', 'task', {
      mode: 'spawn',
      task_id: 'st_00000001',
      status: 'completed',
      skills: { requested: ['audit'], resolved: ['audit'], missing: [] },
    }),
    result('r1-again', 't1-again', 'task', {
      mode: 'spawn',
      task_id: 'st_00000001',
      status: 'completed',
      skills: { requested: ['audit'], resolved: ['audit', 'audit', '', '  ', 42], missing: [] },
    }),
    // Non-task or non-spawn receipts carrying skills must be ignored.
    result('r-other-tool', 'o1', 'task_output', {
      mode: 'spawn',
      task_id: 'st_00000099',
      skills: { requested: ['ignored'], resolved: ['ignored'], missing: [] },
    }),
    result('r-other-mode', 'o2', 'task', {
      mode: 'status',
      task_id: 'st_00000098',
      skills: { requested: ['ignored'], resolved: ['ignored'], missing: [] },
    }),
  ])
  assert.deepEqual(collectOmo(single.ctx, [], undefined, now).session.counts, {
    tokens: 12, tools: 1, agents: 1, skills: 0,
  })
  const singleSkills = collectOmoSubagentSkills(single.ctx)
  assert.deepEqual([...singleSkills.keys()], ['st_00000001'])
  assert.deepEqual([...singleSkills.get('st_00000001')!], ['audit'])

  // 2. Batch details.items[]: per-item attribution, same skill across two distinct children counts once per child,
  //    older receipts without skills stay valid, and refused or empty-task_id items contribute zero skills.
  const batch = host([
    assistant('b1', [call('tb', 'task')]),
    result('rb', 'tb', 'task', {
      mode: 'spawn',
      task_id: 'st_00000001',
      status: 'running',
      items: [
        {
          task_id: 'st_00000001',
          status: 'completed',
          skills: { requested: ['audit', 'audit', 'missing'], resolved: ['audit', 'audit'], missing: ['missing'] },
        },
        {
          task_id: 'st_00000002',
          status: 'completed',
          skills: { requested: ['audit', 'review'], resolved: ['audit', ' review '], missing: [] },
        },
        {
          task_id: 'st_00000003',
          status: 'completed',
          // Older receipt omitting `skills`.
        },
        {
          // Confirmed pre-launch refusal still carries `skills` in OmO 5.1.61 start_failed -> must be excluded.
          task_id: 'st_00000004',
          status: 'error',
          failure_kind: 'model_unavailable',
          failure_reason: 'model_not_in_child_profile',
          skills: { requested: ['blocked'], resolved: ['blocked'], missing: [] },
        },
        {
          // Batch plan_unresolved/depth_denied emits task_id: '' with skills -> must be excluded.
          task_id: '',
          status: 'error',
          error_message: 'depth denied',
          skills: { requested: ['denied-skill'], resolved: ['denied-skill'], missing: [] },
        },
        {
          // Post-launch runtime error (bare status:'error') stays accepted and keeps its resolved skills.
          task_id: 'st_00000005',
          status: 'error',
          error_message: 'tool failed during run',
          skills: { requested: ['debug'], resolved: ['debug'], missing: [] },
        },
        {
          // Accepted item with only blank/non-string resolved entries must not leave an empty Set in subagentSkills.
          task_id: 'st_00000006',
          status: 'completed',
          skills: { requested: ['missing'], resolved: ['', '   ', 42], missing: ['missing'] },
        },
      ],
    }),
  ])
  assert.equal(collectOmo(batch.ctx, [], undefined, now).session.counts.skills, 0)
  const batchSkills = collectOmoSubagentSkills(batch.ctx)
  assert.deepEqual([...batchSkills.keys()].sort(), ['st_00000001', 'st_00000002', 'st_00000005'])
  assert.equal(batchSkills.has('st_00000006'), false)
  assert.deepEqual([...batchSkills.get('st_00000001')!], ['audit'])
  assert.deepEqual([...batchSkills.get('st_00000002')!].sort(), ['audit', 'review'])
  assert.deepEqual([...batchSkills.get('st_00000005')!], ['debug'])

  // 3. Reused task_id across accepted and refused attempts keeps only accepted resolved skills (both orderings),
  //    and id-less JSONL replay deduplicates by (task_id, skill_name).
  const reusedState = createOmoHistory()
  const acceptedEntry = {
    type: 'message',
    message: {
      role: 'toolResult', toolCallId: 'c1', toolName: 'task',
      details: { mode: 'spawn', task_id: 'st_00000007', status: 'completed', skills: { requested: ['audit'], resolved: ['audit'], missing: [] } },
    },
  }
  const refusedEntry = {
    type: 'message',
    message: {
      role: 'toolResult', toolCallId: 'c2', toolName: 'task',
      details: {
        mode: 'spawn', task_id: 'st_00000007', status: 'error', failure_kind: 'tools_unavailable',
        skills: { requested: ['nope'], resolved: ['nope'], missing: [] },
      },
    },
  }
  foldOmoEntry(reusedState, refusedEntry, 'line:0')
  foldOmoEntry(reusedState, acceptedEntry, 'line:1')
  foldOmoEntry(reusedState, acceptedEntry, 'line:2')
  foldOmoEntry(reusedState, refusedEntry, 'line:3')
  assert.equal(reusedState.counts.skills, 0)
  assert.deepEqual([...reusedState.subagentSkills.get('st_00000007')!], ['audit'])
})
