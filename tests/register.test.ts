import { describe, expect, mock, test, type Engine, type MockClock } from 'claude-code/testing'
import type { On, TurnStepInput } from 'claude-code'

// hooks/register.ts, the wiring: each hook passes the event on and returns
// what the hooks beneath it answered, untouched; the width from the
// PromptHint viewport; NO_COLOR, the theme option and WSL as the line shows
// them; the model re-read on each tick.

type World = { lines: string[]; model: string }

// The bottoms answer with sentinels: values no mod would make up, so a hook
// that rebuilt or replaced the answer is seen.
const SENTINEL = {
  start: { cwd: '/sentinel/start' },
  measure: { changed: ['rateLimits'] },
  // turnId and index are the step's own (the kit checks them)
  step: {
    answer: 'sentinel answer', toolUses: [], stopReason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, model: 'm' },
  },
  tool: { result: 'sentinel output' },
  end: { sessionId: 'sentinel-session' },
}

function world(on: On, clock: MockClock, env: Record<string, string> = { HOME: '/home/u', NO_COLOR: '1' }): World {
  const w: World = { lines: [], model: 'claude-opus-5-5[1m]' }
  mock.env(on, env)
  on('session.start', async () => SENTINEL.start)
  on('session.id', async () => ({ value: 'S1' }))
  on('session.cwd', async () => ({ value: '/home/u/x' }))
  on('session.model', async () => ({ value: w.model }))
  on('session.usage', async () => ({
    value: { startedAt: 0, context: { window: 200000, percent: 20 }, rateLimits: [] },
  }))
  on('fs.write', async ($, e) => {
    w.lines.push(e.text)
    return { value: undefined }
  })
  on('process.run', async () => ({
    value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('turn.step', async function* ($, e) {
    return { ...SENTINEL.step, turnId: e.turnId, index: e.index } as never
  })
  on('ui.render', async () => ({ type: 'Text', children: ['sentinel hint'] }) as never)
  on('tool.call', async () => SENTINEL.tool as never)
  on('session.measure', async () => SENTINEL.measure as never)
  on('session.end', async () => SENTINEL.end)
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

// No vcs fragments: the world answers no git.
const NO_VCS = { options: { repo: false, branch: false, status: false } }

describe('register: each hook returns what the hooks beneath it answered', () => {
  test('session.start, session.measure, turn.step (the result whole), tool.call, session.end', NO_VCS, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    world(on, clock)
    expect(await $.session.start(start)).toEqual(SENTINEL.start)
    expect(await $.session.measure({ context: { window: 200000, percent: 30 }, rateLimits: [], changed: ['context'] }))
      .toEqual(SENTINEL.measure)
    expect(await step($)).toEqual({ ...SENTINEL.step, turnId: 't1', index: 0 })
    expect(await $.tool.call({ tool: 'Bash', tool_use_id: 'u1', command: 'ls' } as never)).toEqual(SENTINEL.tool)
    expect(await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } })).toEqual(SENTINEL.end)
  })
})

describe('register: the line as the host sets it up', () => {
  test('a PromptHint viewport 20 columns wide drops whole fragments from the end', NO_VCS, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    await $.session.start(start)
    expect(await line(clock, w)).toBe('~/x | opus | ctx:20% | session:0m')
    const drawn = await $.ui.render({
      surface: 'terminal', component: 'PromptHint', requestId: 'r1',
      viewport: { columns: 20, rows: 40 }, props: { isDraft: false, isWorking: false, hint: '' },
    } as never)
    // the row it draws is the one beneath it (the kit stamps its `part`)
    expect((drawn as { children?: unknown }).children).toEqual(['sentinel hint'])
    expect(await line(clock, w)).toBe('~/x | opus | ctx:20%')
  })

  test('without NO_COLOR the line carries colour codes, graphite by default', NO_VCS, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock, { HOME: '/home/u' })
    await $.session.start(start)
    // graphite's sep #3f3f3f
    expect(await line(clock, w)).toContain('\x1b[38;2;63;63;63m | \x1b[0m')
  })

  test('the theme option picks the palette: ember', { options: { ...NO_VCS.options, theme: 'ember' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock, { HOME: '/home/u' })
    await $.session.start(start)
    // ember's sep #665c54
    expect(await line(clock, w)).toContain('\x1b[38;2;102;92;84m | \x1b[0m')
  })

  test('WSLENV set: call counts as text', NO_VCS, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock, { HOME: '/home/u', NO_COLOR: '1', WSLENV: 'WT_SESSION' })
    await $.session.start(start)
    await $.tool.call({ tool: 'Bash', tool_use_id: 'u1', command: 'ls' } as never)
    expect(await line(clock, w)).toContain('| T:1')
  })

  test('a model switch shows on the next tick, with no session.measure', NO_VCS, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    await $.session.start(start)
    expect(await line(clock, w)).toContain('| opus |')
    w.model = 'claude-sonnet-5'
    expect(await line(clock, w)).toContain('| sonnet |')
  })
})
