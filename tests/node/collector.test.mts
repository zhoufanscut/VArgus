import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CodexCollector } from '../../src/hosts/codex/collect.ts'
import { render } from '../../src/render/index.ts'
import { DEFAULTS } from '../../src/options.ts'
import { makeTheme } from '../../src/theme/index.ts'
import { en } from '../../src/i18n/en.ts'

function start(c: CodexCollector) {
  c.start('/repo', 1)
  const v = c.snapshot()!
  v.session.model = 'gpt-6.1-sol'
  v.session.effort = 'high'
}
const usage = (inputTokens = 20000, cachedInputTokens = 16000, outputTokens = 400) => ({
  total: { inputTokens, cachedInputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
  last: { inputTokens: 39000, cachedInputTokens: 30000, outputTokens: 1000, totalTokens: 40000 },
  modelContextWindow: 200000,
})

test('saved-log readings keep cumulative totals per view, short display and native context gauge', () => {
  const c = new CodexCollector('/repo', '/home/u')
  assert.equal(c.snapshot(), undefined)
  start(c)
  assert.equal(c.snapshot()!.session.contextPercent, undefined)
  c.updateUsage(usage())
  c.updateUsage(usage())
  assert.equal(c.snapshot()!.session.counts.tokens, 4400)
  assert.equal(c.snapshot()!.session.contextPercent, 15)
  const v = c.snapshot()!
  const text = render({ v, o: DEFAULTS, l: en, t: makeTheme('graphite', true), now: 60000 })
  assert.match(text, /sol:high/)
  assert.equal(v.session.model, 'gpt-6.1-sol')
  assert.match(text, /ctx:15%/)
  assert.match(text, /token:4\.4k/)
  c.completeItem({ id: 'compact1', type: 'contextCompaction' })
  assert.equal(c.snapshot()!.session.contextPercent, undefined)
  c.updateUsage(usage())
  assert.equal(c.snapshot()!.session.contextPercent, 15)
})

test('separate saved-log collectors isolate usage, counters and metadata', () => {
  const parent = new CodexCollector('/repo', undefined)
  start(parent)
  parent.updateUsage(usage())
  parent.completeItem({ id: 'same-item-id', type: 'commandExecution' })
  const child = new CodexCollector('/different', undefined)
  child.start('/different', 42)
  assert.equal(child.snapshot()!.session.counts.tokens, 0)
  assert.equal(child.snapshot()!.core.cwd, '/different')
  assert.equal(child.snapshot()!.session.startedAt, 42000)
  assert.equal(child.snapshot()!.session.model, undefined)
  child.updateUsage(usage(700, 500, 50))
  child.completeItem({ id: 'same-item-id', type: 'commandExecution' })
  assert.equal(child.snapshot()!.session.counts.tokens, 250)
  assert.equal(child.snapshot()!.session.counts.tools, 1)
  assert.equal(parent.snapshot()!.session.counts.tokens, 4400)
  assert.equal(parent.snapshot()!.session.counts.tools, 1)
})

test('Codex quota windows use reported duration and sparse notifications preserve other windows', () => {
  const c = new CodexCollector('/repo', undefined)
  start(c)
  c.updateLimits({
    limitId: 'codex', primary: { usedPercent: 24, windowDurationMins: 300, resetsAt: 9000000000 },
    secondary: { usedPercent: 61, windowDurationMins: 10080, resetsAt: 9000000000 },
  })
  c.updateLimits({
    limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 15, resetsAt: 9000000000 }, secondary: null,
  })
  assert.deepEqual(c.snapshot()!.limits.engine.map(l => [l.label, l.percentUsed]), [['15m', 25], ['7d', 61]])
  c.updateLimits({
    limitId: 'model', normalModelSlug: 'gpt-6.1-sol', primary: { usedPercent: 70, windowDurationMins: 300, resetsAt: null },
  })
  assert.deepEqual(c.snapshot()!.limits.engine.map(l => [l.label, l.percentUsed]), [['5h', 70]])
  c.snapshot()!.session.model = 'gpt-6-luna'
  assert.deepEqual(c.snapshot()!.limits.engine.map(l => [l.label, l.percentUsed]), [['15m', 25], ['7d', 61]])
})

test('item identities prevent duplicate tool counts; messages and subagent tools do not inflate lead counts', () => {
  const c = new CodexCollector('/repo', undefined)
  start(c)
  for (const item of [
    { id: 'tool1', type: 'commandExecution' }, { id: 'tool1', type: 'commandExecution' },
    { id: 'agent1', type: 'subAgentActivity', kind: 'started' }, { id: 'agent1', type: 'subAgentActivity', kind: 'started' },
    { id: 'message', type: 'agentMessage' },
  ]) c.completeItem(item)
  assert.deepEqual(c.snapshot()!.session.counts, { tokens: 0, tools: 1, agents: 1, skills: 0, workflows: 0 })
})
