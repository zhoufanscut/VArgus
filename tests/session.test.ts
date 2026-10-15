import { describe, expect, mock, test, type Engine, type MockClock } from 'claude-code/testing'
import type { On, TurnStepInput } from 'claude-code'

// The session collector (src/collect/session.ts), driven through the mod's own
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
  // the usage each turn.step's response reports
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } | null
  // what the mod last saved to $.state, and what a state read answers
  saved: unknown
  restore: unknown
}

function world(on: On, clock: MockClock): World {
  const w: World = {
    lines: [], model: 'claude-opus-5-5[1m]', startedAt: 0, percent: 20, usageRefused: false, usageCalls: 0, saved: undefined, restore: undefined,
    usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 90000, cache_creation_input_tokens: 7000 },
  }
  mock.env(on, { HOME: '/home/u', NO_COLOR: '1' })
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'S1' }))
  on('session.cwd', async () => ({ value: '/home/u/x' }))
  on('session.model', async () => ({ value: w.model }))
  on('session.usage', async () => {
    w.usageCalls += 1
    if (w.usageRefused) throw new Error('refused')
    return { value: { startedAt: w.startedAt, context: { window: 200000, percent: w.percent }, rateLimits: [] } }
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

describe('session collector', () => {
  test('model and context from the host at start; effort from the main loop\'s step', MINE, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    await $.session.start(start)
    expect(await line(clock, w)).toBe('opus | ctx:20% | session:0m')
    await step($, { effort: 'high' })
    // a subagent's effort is not the session's
    await step($, { effort: 'low', agentId: 'a1' })
    expect(await line(clock, w)).toBe('opus:high | ctx:20% | token:3.0k | session:0m')
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
    expect(await line(clock, w)).toContain('token:1.5k')
    await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } })
    await clock.settle()
    expect(w.saved).toEqual({ tokens: 0, tools: 0, agents: 0, skills: 0, workflows: 0 })
    // context and start read again on the next tick (usage() starts over)
    w.percent = 3
    w.startedAt = 1000
    expect(await line(clock, w)).toBe('opus | ctx:3% | session:0m')
  })

  test('after a resume context and start are read again, not left at ctx:0% until the next turn', MINE, async ($, on) => {
    const clock = mock.clock(on, { now: 10 * 3_600_000 })
    const w = world(on, clock)
    await $.session.start(start)
    expect(await line(clock, w)).toBe('opus | ctx:20% | session:10h0m')
    // the resumed conversation: 64 % full, begun 3 h ago
    w.percent = 64
    w.startedAt = 7 * 3_600_000
    await $.session.end({ reason: 'resume', sessionId: 'S1', resume: { id: 'S2' } })
    expect(await line(clock, w)).toBe('opus | ctx:64% | session:3h0m')
    // each answer taken until the next turn's measure: a first answer that
    // still described the session left is corrected on the next tick
    w.percent = 65
    expect(await line(clock, w)).toBe('opus | ctx:65% | session:3h0m')
    // after the measure, not asked again
    await $.session.measure({ context: { window: 200000, percent: 66 }, rateLimits: [], changed: ['context'] })
    const calls = w.usageCalls
    w.percent = 99
    expect(await line(clock, w)).toBe('opus | ctx:66% | session:3h0m')
    expect(w.usageCalls).toBe(calls)
  })

  test('a refused usage() after /clear keeps the line', MINE, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    await $.session.start(start)
    expect(await line(clock, w)).toBe('opus | ctx:20% | session:0m')
    w.usageRefused = true
    await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } })
    expect(await line(clock, w)).toBe('opus | ctx:0%')
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
