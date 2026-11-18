import { describe, expect, mock, test, type Engine, type MockClock } from 'claude-code/testing'
import type { On, TurnStepInput } from 'claude-code'

// The session collector (src/hosts/claude/collect/session.ts), driven through the mod's own
// hooks; what it collected is read off the line it writes.

// The session area's fragments only, uncoloured.
const MINE = {
  options: { folder: false, rateLimits: false, repo: false, branch: false, status: false, workflowRuns: true },
}

type World = {
  lines: string[]
  model: string
  startedAt: number
  percent: number | undefined
  // usage() refused (a thrown read), and how many times it was asked
  usageRefused: boolean
  usageCalls: number
  // Hold a usage response after capturing its values, then release it manually.
  usageHeld: boolean
  releaseUsage: (() => void) | undefined
  // the usage each turn.step's response reports
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } | null
  // what the mod last saved to $.state, and what a state read answers
  saved: unknown
  restore: unknown
  // a session.compact answers skipped (a hook vetoed it)
  compactSkipped: boolean
  // the session id; an ended session's id is written no more, so a test
  // moves it on as /clear and a resume do
  id: string
}

function world(on: On, clock: MockClock): World {
  const w: World = {
    lines: [], model: 'claude-opus-5-5[1m]', startedAt: 0, percent: 20, usageRefused: false, usageCalls: 0, usageHeld: false, releaseUsage: undefined, saved: undefined, restore: undefined, compactSkipped: false, id: 'S1',
    usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 90000, cache_creation_input_tokens: 7000 },
  }
  mock.env(on, { HOME: '/home/u', NO_COLOR: '1' })
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: w.id }))
  on('session.cwd', async () => ({ value: '/home/u/x' }))
  on('session.model', async () => ({ value: w.model }))
  on('session.usage', async () => {
    w.usageCalls += 1
    const startedAt = w.startedAt, percent = w.percent
    if (w.usageHeld) await new Promise<void>(resolve => { w.releaseUsage = resolve })
    if (w.usageRefused) throw new Error('refused')
    return { value: { startedAt, context: { window: 200000, percent }, rateLimits: [] } }
  })
  on('fs.write', async ($, e) => {
    w.lines.push(e.text)
    return { value: undefined }
  })
  on('process.run', async () => ({
    value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: w.usage && { ...w.usage, model: e.model } }
  })
  on('tool.call', async () => ({ result: 'ok' }) as never)
  on('session.measure', async ($, e) => ({ changed: e.changed }))
  on('session.compact', async () =>
    (w.compactSkipped ? { skip: 'no' } : { messages: [{ role: 'user', text: 'summary', toolUses: [] }] }) as never)
  on('session.end', async ($, e) => ({ sessionId: e.sessionId }))
  // The kit answers $.state beneath these.
  on('state.set', async ($, e, next) => {
    w.saved = e.value
    return next(e)
  })
  on('state.get', async ($, e, next) => (w.restore ? { value: { value: w.restore, version: 1 } } : next(e)) as never)
  void clock
  return w
}

const start = { cwd: '/home/u/x', surface: 'terminal', isInteractive: true } as const

async function step($: Engine, e: Partial<TurnStepInput> = {}) {
  const s = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1, ...e })
  let r = await s.next()
  while (!r.done) r = await s.next()
  return r.value
}

// The line after the next tick.
async function line(clock: MockClock, w: World): Promise<string | undefined> {
  await clock.advance(1000)
  return w.lines.at(-1)
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

describe('session collector', () => {
  test('model and context from the host at start; effort from the main loop\'s step', MINE, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    await $.session.start(start)
    expect(await line(clock, w)).toBe('opus | ctx:20% | session:0m')
    w.percent = 21
    await step($, { effort: 'high' })
    // a subagent's response neither sets effort nor reads the main window
    w.percent = 22
    const calls = w.usageCalls
    await step($, { effort: 'low', agentId: 'a1' })
    expect(w.usageCalls).toBe(calls)
    expect(await line(clock, w)).toBe('opus:high | ctx:21% | token:3.0k | session:0m')
  })

  test('tokens: input + output of every step, subagents too; cache tokens left out', MINE, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    await $.session.start(start)
    w.usage = { input_tokens: 12000, output_tokens: 300, cache_read_input_tokens: 500000, cache_creation_input_tokens: 4000 }
    await step($)
    await step($, { agentId: 'a1' })
    w.usage = null
    await step($)
    expect(await line(clock, w)).toContain('token:24.6k')
    // the step's response is passed on unchanged
    w.usage = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }
    expect((await step($)).usage).toEqual({ ...w.usage, model: 'claude-opus-5-5' })
  })

  test('call counts: the main loop\'s tool calls; Agent, Skill, Workflow runs (not resumes)', MINE, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    await $.session.start(start)
    const call = (tool: string, more: Record<string, unknown> = {}) =>
      $.tool.call({ tool, tool_use_id: `u${Math.random()}`, ...more } as never)
    await call('Bash', { command: 'ls' })
    await call('Agent', { description: 'd', prompt: 'p' })
    await call('Skill', { skill: 's' })
    await call('Workflow', { name: 'w' })
    await call('Workflow', { name: 'w', resumeFromRunId: 'r1' })
    // a subagent's call is not counted
    await call('Bash', { command: 'ls', agentId: 'a1' })
    expect(await line(clock, w)).toBe('opus | ctx:20% | session:0m | 🔧5 🤖1 🔀1 ⚡1')
    await clock.settle()
    expect(w.saved).toEqual({ tokens: 0, tools: 5, agents: 1, skills: 1, workflows: 1 })
  })

  test('session time from usage().startedAt on the mod\'s clock', MINE, async ($, on) => {
    const clock = mock.clock(on, { now: 100_000 })
    const w = world(on, clock)
    w.startedAt = 100_000 - 23 * 60_000
    await $.session.start(start)
    expect(await line(clock, w)).toContain('session:23m')
    // a main response fills an unknown start, never replaces a known one
    w.startedAt = 0
    await step($)
    expect(await line(clock, w)).toContain('session:23m')
  })

  test('session.measure pushes the context and re-reads the model', MINE, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    await $.session.start(start)
    w.model = 'claude-sonnet-5'
    await $.session.measure({ context: { window: 200000, percent: 86 }, rateLimits: [], changed: ['context'] })
    expect(await line(clock, w)).toBe('sonnet | ctx:86% CRITICAL | session:0m')
  })

  test('/clear and resume start the counts over, in $.state too; other ends keep them', MINE, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    await $.session.start(start)
    await step($)
    await $.session.end({ reason: 'logout', sessionId: 'S1', resume: { id: 'S1' } })
    // the logout ended S1, which is written no more; a new id stands in only so
    // the line, and the counts kept, can be read
    w.id = 'S2'
    expect(await line(clock, w)).toContain('token:1.5k')
    await $.session.end({ reason: 'clear', sessionId: 'S2', resume: { id: 'S2' } })
    w.id = 'S3'
    await clock.settle()
    expect(w.saved).toEqual({ tokens: 0, tools: 0, agents: 0, skills: 0, workflows: 0 })
    // context and start stay unknown until the first main response reads them
    w.percent = 3
    w.startedAt = 1000
    expect(await line(clock, w)).toBe('opus | ctx:0%')
    await step($)
    expect(await line(clock, w)).toBe('opus | ctx:3% | token:1.5k | session:0m')
  })

  test('a usage response from before /clear cannot restore the old session start', MINE, async ($, on) => {
    const clock = mock.clock(on, { now: 10 * 3_600_000 })
    const w = world(on, clock)
    await $.session.start(start)
    expect(await line(clock, w)).toBe('opus | ctx:20% | session:10h0m')
    w.usageHeld = true
    await $.session.measure({ context: { window: 200000, percent: 20 }, rateLimits: [], changed: ['context'] })
    await flush()
    expect(w.releaseUsage).toBeDefined()
    await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } })
    w.id = 'S2'
    w.usageHeld = false
    w.startedAt = 7 * 3_600_000
    w.releaseUsage?.()
    await flush()
    expect(await line(clock, w)).toBe('opus | ctx:0%')
    // A read started after the clear still fills the new session's values.
    await $.session.measure({ context: { window: 200000, percent: 64 }, rateLimits: [], changed: ['context'] })
    expect(await line(clock, w)).toBe('opus | ctx:64% | session:3h0m')
  })

  test('after a resume the first main response fills context and start; ticks do not poll', MINE, async ($, on) => {
    const clock = mock.clock(on, { now: 10 * 3_600_000 })
    const w = world(on, clock)
    await $.session.start(start)
    expect(await line(clock, w)).toBe('opus | ctx:20% | session:10h0m')
    // the resumed conversation: 64 % full, begun 3 h ago
    w.percent = 64
    w.startedAt = 7 * 3_600_000
    await $.session.end({ reason: 'resume', sessionId: 'S1', resume: { id: 'S2' } })
    w.id = 'S2'
    const calls = w.usageCalls
    expect(await line(clock, w)).toBe('opus | ctx:0%')
    expect(w.usageCalls).toBe(calls)
    await step($)
    expect(await line(clock, w)).toBe('opus | ctx:64% | token:1.5k | session:3h0m')
    // a later tick takes no reading of its own; the turn-end push still stands
    w.percent = 65
    expect(await line(clock, w)).toBe('opus | ctx:64% | token:1.5k | session:3h0m')
    await $.session.measure({ context: { window: 200000, percent: 66 }, rateLimits: [], changed: ['context'] })
    w.percent = 67
    expect(await line(clock, w)).toBe('opus | ctx:66% | token:1.5k | session:3h0m')
    const afterMeasure = w.usageCalls
    w.percent = 99
    expect(await line(clock, w)).toBe('opus | ctx:66% | token:1.5k | session:3h0m')
    expect(w.usageCalls).toBe(afterMeasure)
  })

  test('a compaction that stands drops the fill until the next main response', MINE, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    await $.session.start(start)
    expect(await line(clock, w)).toBe('opus | ctx:20% | session:0m')
    // the compacted live window: the window alone until its first response
    w.percent = undefined
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never)
    expect(await line(clock, w)).toBe('opus | ctx:0% | session:0m')
    // the host can still push the old fill just after the compaction lands
    await $.session.measure({ context: { window: 200000, percent: 20 }, rateLimits: [], changed: ['rateLimits'] })
    expect(await line(clock, w)).toBe('opus | ctx:0% | session:0m')
    // no tick reads ahead of a response
    const calls = w.usageCalls
    w.percent = 3
    expect(await line(clock, w)).toBe('opus | ctx:0% | session:0m')
    expect(w.usageCalls).toBe(calls)
    await step($)
    expect(await line(clock, w)).toBe('opus | ctx:3% | token:1.5k | session:0m')
    // each later main response replaces the fill, with no polling between
    w.percent = 4
    await step($)
    expect(await line(clock, w)).toBe('opus | ctx:4% | token:3.0k | session:0m')
    // with the first main response read, the ordinary push path stands again
    await $.session.measure({ context: { window: 200000, percent: 5 }, rateLimits: [], changed: ['context'] })
    expect(await line(clock, w)).toBe('opus | ctx:5% | token:3.0k | session:0m')
    const afterSteps = w.usageCalls
    w.percent = 99
    expect(await line(clock, w)).toBe('opus | ctx:5% | token:3.0k | session:0m')
    expect(w.usageCalls).toBe(afterSteps)
  })

  test('a skipped, precompute or subagent compaction leaves the fill and the reading alone', MINE, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    await $.session.start(start)
    const calls = w.usageCalls
    w.compactSkipped = true
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never)
    w.percent = 99
    expect(await line(clock, w)).toBe('opus | ctx:20% | session:0m')
    w.compactSkipped = false
    // precompute installs nothing, whatever it answered
    await $.session.compact({ trigger: 'precompute', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never)
    expect(await line(clock, w)).toBe('opus | ctx:20% | session:0m')
    // a subagent's own transcript is not the main conversation
    await $.session.compact({
      trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }], agentId: 'a1',
    } as never)
    expect(await line(clock, w)).toBe('opus | ctx:20% | session:0m')
    expect(w.usageCalls).toBe(calls)
  })

  test('a refused usage() after /clear keeps the step result and the line', MINE, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    await $.session.start(start)
    expect(await line(clock, w)).toBe('opus | ctx:20% | session:0m')
    w.usageRefused = true
    await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } })
    w.id = 'S2'
    expect((await step($)).stopReason).toBe('end_turn')
    expect(await line(clock, w)).toBe('opus | ctx:0% | token:1.5k')
  })

  test('counts saved in $.state are taken back at session.start (a hot reload)', MINE, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    await $.session.start(start)
    await step($)
    await clock.settle()
    expect(w.saved).toEqual({ tokens: 1500, tools: 0, agents: 0, skills: 0, workflows: 0 })
    w.restore = { tokens: 70000, tools: 9, agents: 0, skills: 0, workflows: 0 }
    await $.session.start(start)
    expect(await line(clock, w)).toContain('token:70.0k | session:0m | 🔧9')
  })
})
