import { describe, expect, mock, test, type Engine, type MockClock } from 'claude-code/testing'
import type { ConfigRow, On, TurnStepChunk, TurnStepInput, TurnStepServerToolUse } from 'claude-code'
import { fixtureFsPath } from './fixture-path'

// The session collector (src/hosts/claude/collect/session.ts), driven through the mod's own
// hooks; what it collected is read off the line it writes.

// The session area's fragments only, uncoloured.
const MINE = {
  options: { folder: false, rateLimits: false, repo: false, branch: false, status: false },
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
  stopReason: 'end_turn' | null
  // optional scripted chunks + clock advances for streaming t/s tests
  streamChunks: readonly { delayMs?: number; chunk: TurnStepChunk }[]
  streamClosed: number
  serverToolUses?: readonly TurnStepServerToolUse[]
  // what the mod last saved to $.state, and what a state read answers
  saved: unknown
  restore: unknown
  // a session.compact answers skipped (a hook vetoed it)
  compactSkipped: boolean
  // the session id; an ended session's id is written no more, so a test
  // moves it on as /clear and a resume do
  id: string
}

function world(on: On, clock: MockClock, mockProcess = true): World {
  const w: World = {
    lines: [], model: 'claude-opus-5-5[1m]', startedAt: 0, percent: 20, usageRefused: false, usageCalls: 0, usageHeld: false, releaseUsage: undefined, saved: undefined, restore: undefined, compactSkipped: false, id: 'S1',
    usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 90000, cache_creation_input_tokens: 7000 },
    stopReason: 'end_turn',
    streamChunks: [],
    streamClosed: 0,
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
    if (!e.path.endsWith('.live')) w.lines.push(e.text)
    return { value: undefined }
  })
  if (mockProcess) on('process.run', async () => ({
    value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('turn.step', async function* ($, e) {
    try {
      for (const item of w.streamChunks) {
        if (item.delayMs) await clock.advance(item.delayMs)
        yield item.chunk
      }
    } finally {
      w.streamClosed += 1
    }
    return {
      turnId: e.turnId, index: e.index, answer: '', toolUses: [],
      ...(w.serverToolUses ? { serverToolUses: w.serverToolUses } : {}),
      stopReason: w.stopReason, usage: w.usage && { ...w.usage, model: e.model },
    }
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
    w.usage = { ...w.usage!, cache_read_input_tokens: 0 }
    const calls = w.usageCalls
    await step($, { effort: 'low', agentId: 'a1' })
    expect(w.usageCalls).toBe(calls)
    expect(await line(clock, w)).toBe('opus:high | ctx:21% | token:3.0k(91.8%) | session:0m')
  })

  test('tokens: folds main and subagent tokens by default (cache tokens left out); cache% stays main-only', MINE, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    await $.session.start(start)
    w.usage = { input_tokens: 12000, output_tokens: 300, cache_read_input_tokens: 500000, cache_creation_input_tokens: 4000 }
    await step($)
    await step($, { agentId: 'a1' })
    expect(await line(clock, w)).toContain('token:24.6k(96.9%)')
    w.usage = null
    await step($)
    expect(await line(clock, w)).toContain('token:24.6k |')
    // the step's response is passed on unchanged
    w.usage = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }
    expect((await step($)).usage).toEqual({ ...w.usage, model: 'claude-opus-5-5' })
  })

  test('call counts fold main and subagent calls by default and persist subagent calls separately', MINE, async ($, on) => {
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
    // a subagent's call is persisted separately and included under the default option
    await call('Bash', { command: 'ls', agentId: 'a1' })
    expect(await line(clock, w)).toBe('opus | ctx:20% | session:0m | 🔧6 🤖1 ⚡1')
    await clock.settle()
    expect(w.saved).toEqual({
      tokens: 0, tools: 5, agents: 1, skills: 1,
      subagents: { tokens: 0, tools: 1, agents: 0, skills: 0 },
    })
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
    expect(await line(clock, w)).toBe('sonnet | ctx:86% | session:0m')
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
    expect(w.saved).toEqual({ tokens: 0, tools: 0, agents: 0, skills: 0 })
    // context and start stay unknown until the first main response reads them
    w.percent = 3
    w.startedAt = 1000
    expect(await line(clock, w)).toBe('opus | ctx:0%')
    await step($)
    expect(await line(clock, w)).toBe('opus | ctx:3% | token:1.5k(91.8%) | session:0m')
  })

  test('a usage response from before /clear cannot restore old context or session start', MINE, async ($, on) => {
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

    // The independent read after a main step follows the same rule.
    w.releaseUsage = undefined
    w.usageHeld = true
    const pending = step($)
    await flush()
    await clock.advance(0)
    const release = w.releaseUsage as (() => void) | undefined
    expect(release).toBeDefined()
    await $.session.end({ reason: 'clear', sessionId: 'S2', resume: { id: 'S2' } })
    w.id = 'S3'
    w.usageHeld = false
    release?.()
    await pending
    expect(await line(clock, w)).toBe('opus | ctx:0%')
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
    expect(await line(clock, w)).toBe('opus | ctx:64% | token:1.5k(91.8%) | session:3h0m')
    // a later tick takes no reading of its own; the turn-end push still stands
    w.percent = 65
    expect(await line(clock, w)).toBe('opus | ctx:64% | token:1.5k(91.8%) | session:3h0m')
    await $.session.measure({ context: { window: 200000, percent: 66 }, rateLimits: [], changed: ['context'] })
    w.percent = 67
    expect(await line(clock, w)).toBe('opus | ctx:66% | token:1.5k(91.8%) | session:3h0m')
    const afterMeasure = w.usageCalls
    w.percent = 99
    expect(await line(clock, w)).toBe('opus | ctx:66% | token:1.5k(91.8%) | session:3h0m')
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
    expect(await line(clock, w)).toBe('opus | ctx:3% | token:1.5k(91.8%) | session:0m')
    // each later main response replaces the fill, with no polling between
    w.percent = 4
    await step($)
    expect(await line(clock, w)).toBe('opus | ctx:4% | token:3.0k(91.8%) | session:0m')
    // with the first main response read, the ordinary push path stands again
    await $.session.measure({ context: { window: 200000, percent: 5 }, rateLimits: [], changed: ['context'] })
    expect(await line(clock, w)).toBe('opus | ctx:5% | token:3.0k(91.8%) | session:0m')
    const afterSteps = w.usageCalls
    w.percent = 99
    expect(await line(clock, w)).toBe('opus | ctx:5% | token:3.0k(91.8%) | session:0m')
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
    expect(await line(clock, w)).toBe('opus | ctx:0% | token:1.5k(91.8%)')
  })

  test('an interrupted request keeps the last cache reading and an installed compaction clears it across reload', MINE, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    await $.session.start(start)
    await step($)
    expect(await line(clock, w)).toContain('token:1.5k(91.8%)')
    w.usage = null
    w.stopReason = null
    await step($)
    expect(await line(clock, w)).toContain('token:1.5k(91.8%)')
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never)
    expect(await line(clock, w)).toContain('token:1.5k |')
    await clock.settle()
    w.restore = w.saved
    await $.session.start(start)
    expect(await line(clock, w)).toContain('token:1.5k |')
  })

  test('counts saved in $.state are taken back at session.start (a hot reload)', MINE, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    await $.session.start(start)
    await step($)
    await clock.settle()
    expect(w.saved).toEqual({ tokens: 1500, tools: 0, agents: 0, skills: 0, cacheHitPercent: 9000 / 98 })
    w.restore = w.saved
    await $.session.start(start)
    expect(await line(clock, w)).toContain('token:1.5k(91.8%)')
    w.restore = { tokens: 70000, tools: 9, agents: 2, skills: 1, workflows: 3 }
    await $.session.start(start)
    expect(await line(clock, w)).toContain('token:70.0k | session:0m | 🔧9 🤖2 ⚡1')
    await step($)
    await clock.settle()
    expect(w.saved).toEqual({ tokens: 71500, tools: 9, agents: 2, skills: 1, cacheHitPercent: 9000 / 98 })
  })

  test('decode t/s excludes TTFT and server tools, ignores bursts/subagents, survives reload and clears on switch/compact', MINE, async ($, on) => {
    const clock = mock.clock(on, { now: 1000 })
    const w = world(on, clock)
    await $.session.start(start)
    // 2000ms TTFT before thinking starts, then 2500ms thinking+text with 500ms server tool => 2000ms decode for 500 tokens => 250t/s
    w.streamChunks = [
      { delayMs: 2000, chunk: { kind: 'thinking', index: 0, text: 'plan' } },
      { delayMs: 1000, chunk: { kind: 'text', index: 1, text: 'hello' } },
      { delayMs: 1500, chunk: { kind: 'stop', stopReason: 'end_turn', usage: { ...w.usage!, model: 'claude-opus-5-5' } } },
    ]
    w.serverToolUses = [
      { id: 'st1', name: 'advisor', input: {}, startedAt: 3200, endedAt: 3600 },
      { id: 'st2', name: 'advisor', input: {}, startedAt: 3400, endedAt: 3700 },
    ]
    const seen: TurnStepChunk[] = []
    const gen = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
    for (;;) {
      const next = await gen.next()
      if (next.done) break
      seen.push(next.value)
    }
    expect(seen.map(c => c.kind)).toEqual(['thinking', 'text', 'stop'])
    expect(await line(clock, w)).toContain('token:1.5k(91.8%, 250t/s)')

    // A short burst (< 500ms) or single chunk preserves the last valid rate.
    w.serverToolUses = undefined
    w.streamChunks = [
      { chunk: { kind: 'text', index: 0, text: 'quick' } },
      { delayMs: 200, chunk: { kind: 'text', index: 0, text: '!' } },
      { chunk: { kind: 'stop', stopReason: 'end_turn', usage: { ...w.usage!, model: 'claude-opus-5-5' } } },
    ]
    await step($)
    expect(await line(clock, w)).toContain('token:3.0k(91.8%, 250t/s)')

    // A single-chunk non-streamed burst (even with a late stop) preserves the last valid rate.
    w.streamChunks = [
      { chunk: { kind: 'text', index: 0, text: 'whole' } },
      { delayMs: 1000, chunk: { kind: 'stop', stopReason: 'end_turn', usage: { ...w.usage!, model: 'claude-opus-5-5' } } },
    ]
    await step($)
    expect(await line(clock, w)).toContain('token:4.5k(91.8%, 250t/s)')

    // A subagent's slower stream adds tokens under default options without replacing the main loop's rate or cache%.
    w.streamChunks = [
      { chunk: { kind: 'text', index: 0, text: 'sub' } },
      { delayMs: 5000, chunk: { kind: 'text', index: 0, text: 'agent' } },
      { chunk: { kind: 'stop', stopReason: 'end_turn', usage: { ...w.usage!, model: 'claude-opus-5-5' } } },
    ]
    await step($, { agentId: 'a1' })
    expect(await line(clock, w)).toContain('token:6.0k(91.8%, 250t/s)')

    // Hot reload restores the rate from $.state.
    await clock.settle()
    expect((w.saved as { tokensPerSecond?: number }).tokensPerSecond).toBe(250)
    w.restore = { ...(w.saved as Record<string, unknown>), tokensPerSecond: 125 }
    await $.session.start(start)
    expect(await line(clock, w)).toContain('token:6.0k(91.8%, 125t/s)')

    // A model switch clears the stale rate.
    w.model = 'claude-sonnet-5'
    expect(await line(clock, w)).toContain('token:6.0k(91.8%) |')

    // Record another rate, then verify unfinished server tools, interrupted steps,
    // missing usage, compaction, /clear, and stepStarting model switches.
    w.streamChunks = [
      { chunk: { kind: 'text', index: 0, text: 'a' } },
      { delayMs: 1500, chunk: { kind: 'text', index: 0, text: 'b' } },
      { chunk: { kind: 'stop', stopReason: 'end_turn', usage: { ...w.usage!, model: 'claude-sonnet-5' } } },
    ]
    // Unfinished server tool (endedAt absent) started 500ms before stop => 1000ms decode => 500t/s
    w.serverToolUses = [{ id: 'st-open', name: 'advisor', input: {}, startedAt: clock.now() + 1000 }]
    await step($, { model: 'claude-sonnet-5' })
    w.serverToolUses = undefined
    expect(await line(clock, w)).toContain('token:7.5k(91.8%, 500t/s)')

    // Interrupted step (usage null, stopReason null) preserves the rate.
    w.streamChunks = []
    w.usage = null
    w.stopReason = null
    await step($, { model: 'claude-sonnet-5' })
    expect(await line(clock, w)).toContain('token:7.5k(91.8%, 500t/s)')

    // Completed step without usage clears both cache hit and t/s.
    w.stopReason = 'end_turn'
    await step($, { model: 'claude-sonnet-5' })
    expect(await line(clock, w)).toContain('token:7.5k |')

    // Compaction clears t/s.
    w.usage = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 90000, cache_creation_input_tokens: 7000 }
    w.streamChunks = [
      { chunk: { kind: 'text', index: 0, text: 'a' } },
      { delayMs: 1000, chunk: { kind: 'text', index: 0, text: 'b' } },
      { chunk: { kind: 'stop', stopReason: 'end_turn', usage: { ...w.usage, model: 'claude-sonnet-5' } } },
    ]
    await step($, { model: 'claude-sonnet-5' })
    expect(await line(clock, w)).toContain('token:9.0k(91.8%, 500t/s)')
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never)
    expect(await line(clock, w)).toContain('token:9.0k |')

    // stepStarting with a new model persists the clear to $.state even if the step is interrupted before refresh.
    await step($, { model: 'claude-sonnet-5' })
    expect(await line(clock, w)).toContain('token:10.5k(91.8%, 500t/s)')
    w.streamChunks = []
    w.usage = null
    w.stopReason = null
    await step($, { model: 'claude-haiku-5-5' })
    await clock.settle()
    expect((w.saved as { tokensPerSecond?: number }).tokensPerSecond).toBeUndefined()

    // /clear also clears tokensPerSecond in $.state.
    w.usage = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 90000, cache_creation_input_tokens: 7000 }
    w.stopReason = 'end_turn'
    w.streamChunks = [
      { chunk: { kind: 'text', index: 0, text: 'a' } },
      { delayMs: 1000, chunk: { kind: 'text', index: 0, text: 'b' } },
      { chunk: { kind: 'stop', stopReason: 'end_turn', usage: { ...w.usage, model: 'claude-haiku-5-5' } } },
    ]
    await step($, { model: 'claude-haiku-5-5' })
    await clock.settle()
    expect((w.saved as { tokensPerSecond?: number }).tokensPerSecond).toBe(500)
    await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } })
    w.id = 'S2'
    await clock.settle()
    expect((w.saved as { tokensPerSecond?: number }).tokensPerSecond).toBeUndefined()
  })

  test('refused clock.now does not break turn.step and latches once per step', MINE, async ($, on) => {
    let clockCalls = 0
    on('clock.now', async () => {
      clockCalls += 1
      throw new Error('clock refused')
    })
    on('clock.after', async () => ({ value: undefined }) as never)
    on('clock.every', async () => ({ value: undefined }) as never)
    const w = world(on, undefined as unknown as MockClock)
    await $.session.start({ cwd: '/home/u/x', surface: 'terminal', isInteractive: false })
    w.streamChunks = [
      { chunk: { kind: 'text', index: 0, text: 'a' } },
      { chunk: { kind: 'text', index: 0, text: 'b' } },
      { chunk: { kind: 'stop', stopReason: 'end_turn', usage: { ...w.usage!, model: 'claude-opus-5-5' } } },
    ]
    clockCalls = 0
    const res = await step($)
    expect(res.stopReason).toBe('end_turn')
    expect(res.usage?.output_tokens).toBe(500)
    // First-chunk clock check latched once; never re-queried on subsequent chunks.
    expect(clockCalls).toBe(1)
  })

  test('early stream abort closes the inner turn.step generator cleanly', MINE, async ($, on) => {
    const clock = mock.clock(on, { now: 1000 })
    const w = world(on, clock)
    await $.session.start(start)
    const closedBefore = w.streamClosed
    w.streamChunks = [
      { chunk: { kind: 'text', index: 0, text: 'first' } },
      { chunk: { kind: 'text', index: 0, text: 'second' } },
    ]
    const gen = $.turn.step({ turnId: 't2', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
    const first = await gen.next()
    expect(first.done).toBe(false)
    await gen.return(undefined as never)
    expect(w.streamClosed).toBe(closedBefore + 1)
  })

  const MINE_MAIN_ONLY = { options: { ...MINE.options, includeSubagents: false } }

  test('default includeSubagents: true folds subagent tokens and calls while keeping ctx, cache%, t/s and effort main-only', MINE, async ($, on) => {
    const clock = mock.clock(on, { now: 1000 })
    const w = world(on, clock)
    await $.session.start(start)
    const call = (tool: string, more: Record<string, unknown> = {}) =>
      $.tool.call({ tool, tool_use_id: `u${Math.random()}`, ...more } as never)

    // Main-loop step: 12.3k tokens, 96.9% cache hit, 300 output tokens over 1200ms => 250t/s.
    w.percent = 21
    w.usage = { input_tokens: 12000, output_tokens: 300, cache_read_input_tokens: 500000, cache_creation_input_tokens: 4000 }
    w.streamChunks = [
      { delayMs: 500, chunk: { kind: 'text', index: 0, text: 'a' } },
      { delayMs: 1200, chunk: { kind: 'text', index: 0, text: 'b' } },
      { chunk: { kind: 'stop', stopReason: 'end_turn', usage: { ...w.usage, model: 'claude-opus-5-5' } } },
    ]
    await step($, { effort: 'high' })
    await call('Bash', { command: 'ls' })
    await call('Agent', { description: 'd', prompt: 'p' })

    // Subagent step + tools: adds tokens and calls, leaves effort, ctx, cache% and t/s untouched.
    w.percent = 22
    w.usage = { input_tokens: 12000, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    w.streamChunks = [
      { chunk: { kind: 'text', index: 0, text: 'sub' } },
      { delayMs: 5000, chunk: { kind: 'text', index: 0, text: 'agent' } },
      { chunk: { kind: 'stop', stopReason: 'end_turn', usage: { ...w.usage, model: 'claude-opus-5-5' } } },
    ]
    const calls = w.usageCalls
    await step($, { effort: 'low', agentId: 'a1' })
    expect(w.usageCalls).toBe(calls)
    await call('Bash', { command: 'pwd', agentId: 'a1' })
    await call('Agent', { description: 'nested', prompt: 'p', agentId: 'a1' })
    await call('Skill', { skill: 's', agentId: 'a1' })

    expect(await line(clock, w)).toBe('opus:high | ctx:21% | token:24.6k(96.9%, 250t/s) | session:0m | 🔧5 🤖2 ⚡1')
    await clock.settle()
    expect(w.saved).toEqual({
      tokens: 12300, tools: 2, agents: 1, skills: 0,
      subagents: { tokens: 12300, tools: 3, agents: 1, skills: 1 },
      cacheHitPercent: (100 * 500000) / (12000 + 500000 + 4000),
      tokensPerSecond: 250,
    })
  })

  test('default includeSubagents: true displays subagent-only activity when main counts are zero', MINE, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    await $.session.start(start)
    await step($, { agentId: 'a1' })
    await $.tool.call({ tool: 'Bash', tool_use_id: 'u1', command: 'ls', agentId: 'a1' } as never)
    expect(await line(clock, w)).toBe('opus | ctx:20% | token:1.5k | session:0m | 🔧1')
  })

  test('hot-reload restore enables subagent counts retroactively from $.state (false -> true)', MINE, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    w.restore = {
      tokens: 1500, tools: 2, agents: 1, skills: 0,
      subagents: { tokens: 3000, tools: 4, agents: 1, skills: 2 },
      cacheHitPercent: 9000 / 98,
    }
    await $.session.start(start)
    expect(await line(clock, w)).toBe('opus | ctx:20% | token:4.5k(91.8%) | session:0m | 🔧6 🤖2 ⚡2')
  })

  test('hot-reload restore hides subagent counts retroactively (true -> false) while keeping them persisted', MINE_MAIN_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    w.restore = {
      tokens: 1500, tools: 2, agents: 1, skills: 0,
      subagents: { tokens: 3000, tools: 4, agents: 1, skills: 2 },
      cacheHitPercent: 9000 / 98,
    }
    await $.session.start(start)
    expect(await line(clock, w)).toBe('opus | ctx:20% | token:1.5k(91.8%) | session:0m | 🔧2 🤖1')
    await step($)
    await clock.settle()
    expect(w.saved).toEqual({
      tokens: 3000, tools: 2, agents: 1, skills: 0,
      subagents: { tokens: 3000, tools: 4, agents: 1, skills: 2 },
      cacheHitPercent: 9000 / 98,
    })
  })

  test('in-process applyOptions toggles includeSubagents via reload-plugins, config and matching config.set', MINE, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock, false)
    mock.store(on)
    const provider = { plugin: 'vargus@vargus', tier: 'user' as const }
    const row: ConfigRow = {
      key: 'vargus.includeSubagents', label: 'Include subagents', kind: 'boolean',
      value: true, provider, isLocked: false,
    }
    let file = '{}\n'
    let staged = ''
    on('fs.exists', async ($, e) => ({ value: fixtureFsPath(e.path).endsWith('/vargus.jsonc') }))
    on('fs.read', async ($, e) => {
      if (fixtureFsPath(e.path).endsWith('/vargus.jsonc')) return { value: file }
      throw new Error('ENOENT')
    })
    on('fs.stat', async ($, e) => ({
      value: { kind: 'file', isLink: false, realPath: e.path, size: file.length, mtimeMs: 0 },
    }))
    on('config.list', async () => ({ value: [row] }))
    on('config.set', async ($, e) => {
      row.value = e.value
      return { value: row.value }
    })
    on('process.run', async ($, e) => {
      const index = e.argv.findIndex(arg => arg.endsWith('/replace-config.sh'))
      if (index >= 0) {
        const op = e.argv[index + 1]
        if (op === 'prepare') staged = e.init?.stdin?.slice(file.length) ?? ''
        if (op === 'commit') file = staged
      }
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('command.run', async () => ({ text: 'ok' }))
    const command = (name: string) => $.command.run({
      command: name, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 },
    })

    await $.session.start(start)
    await step($)
    await $.tool.call({ tool: 'Bash', tool_use_id: 'u1', command: 'ls' } as never)
    await step($, { agentId: 'a1' })
    await $.tool.call({ tool: 'Bash', tool_use_id: 'u2', command: 'pwd', agentId: 'a1' } as never)
    await $.tool.call({ tool: 'Agent', tool_use_id: 'u3', description: 'd', prompt: 'p', agentId: 'a1' } as never)
    await $.tool.call({ tool: 'Skill', tool_use_id: 'u4', skill: 's', agentId: 'a1' } as never)
    expect(await line(clock, w)).toBe('opus | ctx:20% | token:3.0k(91.8%) | session:0m | 🔧4 🤖1 ⚡1')

    file = '{"includeSubagents":false}\n'
    await command('reload-plugins')
    expect(await line(clock, w)).toBe('opus | ctx:20% | token:1.5k(91.8%) | session:0m | 🔧1')

    file = '{"includeSubagents":true}\n'
    await command('config')
    expect(await line(clock, w)).toBe('opus | ctx:20% | token:3.0k(91.8%) | session:0m | 🔧4 🤖1 ⚡1')

    file = '{"includeSubagents":false}\n'
    await command('reload-plugins')
    expect(await line(clock, w)).toBe('opus | ctx:20% | token:1.5k(91.8%) | session:0m | 🔧1')

    // Setting true matches given.includeSubagents (true), triggering in-process applyOptions.
    expect(await $.config.set({
      key: 'vargus.includeSubagents', previous: false, value: true, provider, origin: { kind: 'composer' },
    })).toEqual({ value: true })
    expect(file).toBe('{"includeSubagents":true}\n')
    expect(await line(clock, w)).toBe('opus | ctx:20% | token:3.0k(91.8%) | session:0m | 🔧4 🤖1 ⚡1')
  })

  test('legacy $.state without subagents resets in-memory subagentCounts cleanly on session.start', MINE, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    await $.session.start(start)
    await step($, { agentId: 'a1' })
    await $.tool.call({ tool: 'Bash', tool_use_id: 'u1', command: 'ls', agentId: 'a1' } as never)
    expect(await line(clock, w)).toBe('opus | ctx:20% | token:1.5k | session:0m | 🔧1')

    w.restore = { tokens: 5000, tools: 2, agents: 0, skills: 0 }
    await $.session.start(start)
    expect(await line(clock, w)).toBe('opus | ctx:20% | token:5.0k | session:0m | 🔧2')

    await step($)
    await clock.settle()
    expect(w.saved).toEqual({ tokens: 6500, tools: 2, agents: 0, skills: 0, cacheHitPercent: 9000 / 98 })
  })

  test('/clear and resume reset both main and subagent counts in memory and $.state', MINE, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    await $.session.start(start)
    await step($)
    await step($, { agentId: 'a1' })
    await $.tool.call({ tool: 'Bash', tool_use_id: 'u1', command: 'ls', agentId: 'a1' } as never)
    expect(await line(clock, w)).toBe('opus | ctx:20% | token:3.0k(91.8%) | session:0m | 🔧1')
    await clock.settle()
    expect((w.saved as { subagents?: unknown }).subagents).toEqual({ tokens: 1500, tools: 1, agents: 0, skills: 0 })

    await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } })
    w.id = 'S2'
    await clock.settle()
    expect(w.saved).toEqual({ tokens: 0, tools: 0, agents: 0, skills: 0 })
    expect(await line(clock, w)).toBe('opus | ctx:0%')
    await step($)
    expect(await line(clock, w)).toBe('opus | ctx:20% | token:1.5k(91.8%) | session:0m')

    await step($, { agentId: 'a2' })
    await $.tool.call({ tool: 'Skill', tool_use_id: 'u2', skill: 's', agentId: 'a2' } as never)
    expect(await line(clock, w)).toBe('opus | ctx:20% | token:3.0k(91.8%) | session:0m | 🔧1 ⚡1')

    await $.session.end({ reason: 'resume', sessionId: 'S2', resume: { id: 'S3' } })
    w.id = 'S3'
    await clock.settle()
    expect(w.saved).toEqual({ tokens: 0, tools: 0, agents: 0, skills: 0 })
    expect(await line(clock, w)).toBe('opus | ctx:0%')
    await step($)
    expect(await line(clock, w)).toBe('opus | ctx:20% | token:1.5k(91.8%) | session:0m')
  })
})
