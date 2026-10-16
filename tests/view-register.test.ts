import { describe, expect, mock, test, type Engine, type MockClock } from 'claude-code/testing'
import type { On, TurnStepInput } from 'claude-code'

// The detail view's wiring in hooks/register.ts (DESIGN, "The detail view"):
// off by default, nothing registered; on, /vargus toggles the pane, the open
// pane is redrawn each second, a close stops that, and agents' tokens reach it.
// The redraws stop in the plugin's ui.close hook, which every close passes
// (the command's, Esc's, the close mark's); the kit's engine `$` cannot raise
// a person's close, so the command's stands for them.

type Calls = { writes: number; refuseRegister: boolean; registered: unknown[]; opened: unknown[]; closed: unknown[]; invalidated: number; panes: { id: string }[] }

function world(on: On, clock: MockClock): Calls {
  const c: Calls = { writes: 0, refuseRegister: false, registered: [], opened: [], closed: [], invalidated: 0, panes: [] }
  mock.env(on, { HOME: '/home/u', NO_COLOR: '1' })
  on('session.start', async () => ({ cwd: '/home/u/x' }))
  on('session.id', async () => ({ value: 'S1' }))
  on('session.cwd', async () => ({ value: '/home/u/x' }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 40000, percent: 20 }, rateLimits: [] } }))
  on('fs.write', async () => {
    c.writes += 1
    return { value: undefined }
  })
  on('process.run', async () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('command.register', async ($, e) => {
    if (c.refuseRegister) throw new Error('refused')
    c.registered.push(e)
    return { value: { command: 'vargus' } }
  })
  on('ui.panes', async () => ({ value: c.panes.map(p => ({ ...p, title: 'VArgus', isShown: true, isFocused: false, isPlaced: true })) }) as never)
  on('ui.open', async ($, e) => {
    c.opened.push(e)
    c.panes = [{ id: e.id }]
    return { value: { isPlaced: true } }
  })
  on('ui.close', async ($, e) => {
    c.closed.push(e)
    c.panes = []
    return { value: undefined }
  })
  on('ui.invalidate', async () => {
    c.invalidated += 1
    return { value: undefined }
  })
  on('ui.render', async () => ({ type: 'Text', children: ['sentinel'] }) as never)
  on('agent.spawn', async () => ({ model: 'haiku', agentId: 'a1' }))
  on('turn.step', async function* ($, e) {
    return {
      answer: '', toolUses: [], stopReason: 'end_turn', turnId: e.turnId, index: e.index,
      usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 5000, cache_creation_input_tokens: 700 },
    } as never
  })
  on('session.end', async () => ({ sessionId: 'S1' }))
  void clock
  return c
}

const start = { cwd: '/home/u/x', surface: 'terminal', isInteractive: true } as const
const ON = { options: { detailView: true, repo: false, branch: false, status: false } }

async function step($: Engine, e: Partial<TurnStepInput> = {}) {
  const s = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1, ...e })
  let r = await s.next()
  while (!r.done) r = await s.next()
}

async function pane($: Engine): Promise<string> {
  const tree = await $.ui.render({
    surface: 'terminal', component: 'Pane', requestId: 'vargus',
    viewport: { columns: 80, rows: 40, isFullscreen: false },
    props: { title: 'VArgus', isFocused: false, bodyColumns: 76, placement: 'inline' },
  } as never)
  return JSON.stringify(tree)
}

describe('detail view: off by default', () => {
  test('no command, and the Pane is left to the hooks beneath', { options: { repo: false, branch: false, status: false } }, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const c = world(on, clock)
    await $.session.start(start)
    expect(c.registered).toEqual([])
    expect(await pane($)).toContain('sentinel')
  })
})

describe('detail view: on', () => {
  test('session.start registers /vargus; it opens the pane, closable by Esc, with no text row', ON, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const c = world(on, clock)
    await $.session.start(start)
    expect(c.registered).toEqual([{ name: 'vargus', description: 'Open or close the VArgus detail view' }])
    expect(await $.command.run({ command: 'vargus', args: '' } as never)).toEqual({})
    expect(c.opened).toEqual([{ id: 'vargus', title: 'VArgus', closeOnEscape: true }])
  })

  test('a refused command.register costs the view, never the line', ON, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const c = world(on, clock)
    c.refuseRegister = true
    await $.session.start(start)
    const before = c.writes
    await clock.advance(1000)
    expect(c.writes).toBeGreaterThan(before)
  })

  test('the open pane redraws each second; /vargus again closes it and the redraws stop', ON, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const c = world(on, clock)
    await $.session.start(start)
    await clock.advance(3000)
    expect(c.invalidated).toBe(0)
    await $.command.run({ command: 'vargus', args: '' } as never)
    await clock.advance(3000)
    expect(c.invalidated).toBe(3)
    await $.command.run({ command: 'vargus', args: '' } as never)
    expect(c.closed).toEqual([{ id: 'vargus', origin: { kind: 'plugin' } }])
    await clock.advance(3000)
    expect(c.invalidated).toBe(3)
  })

  test('the pane draws the cards: context in tokens, an agent by its type, then /clear empties the list', ON, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    world(on, clock)
    await $.session.start(start)
    await clock.advance(1000)
    await $.agent.spawn({ prompt: 'p', description: 'look around', subagentType: 'Explore', background: false, fork: false } as never)
    await step($)
    await step($, { agentId: 'a1' })
    const drawn = await pane($)
    expect(drawn).not.toContain('sentinel')
    for (const word of ['Limits', 'Context', '40.0k', ' / 200.0k tokens', 'Tokens', 'main', 'Explore', 'look around', 'total']) {
      expect([word, drawn.includes(word)]).toEqual([word, true])
    }
    await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S2' } } as never)
    expect(await pane($)).toContain('no requests yet')
  })
})
