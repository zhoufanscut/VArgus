import { describe, expect, mock, test, type MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

// The line file (DESIGN, "The line file"), driven through the mod's own hooks.

const DATA = '/home/u/.claude/plugins/data/vargus-vargus'

type World = {
  writes: { path: string; text: string }[]
  runs: string[][]
  id: string
  // mv's exit code, or 'throw' for a refused process
  mv: number | 'throw'
  // a cwd function, to change the text between ticks
  cwd: () => string
  // hold each fs.write this long on the mock clock
  holdMs: number
  inFlight: number
  maxInFlight: number
  started: unknown[]
}

function world(on: On, clock: MockClock, env: Record<string, string> = { HOME: '/home/u' }): World {
  const w: World = {
    writes: [], runs: [], id: 'S1', mv: 0, cwd: () => '/home/u/proj/x',
    holdMs: 0, inFlight: 0, maxInFlight: 0, started: [],
  }
  mock.env(on, env)
  // Calls on `$` are answered `{ value }`; session.start needs a bottom too.
  on('session.start', async ($, e) => {
    w.started.push(e)
    return { cwd: e.cwd }
  })
  on('session.id', async () => ({ value: w.id }))
  on('session.cwd', async () => ({ value: w.cwd() }))
  on('fs.write', async ($, e) => {
    w.inFlight += 1
    w.maxInFlight = Math.max(w.maxInFlight, w.inFlight)
    if (w.holdMs) await clock.sleep(w.holdMs)
    w.inFlight -= 1
    w.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('process.run', async ($, e) => {
    w.runs.push([...e.argv])
    if (w.mv === 'throw') throw new Error('refused')
    return { value: { exitCode: w.mv, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return w
}

const start = { cwd: '/home/u/proj/x', surface: 'terminal', isInteractive: true } as const

describe('line file', () => {
  test('writes a temp file, then mv puts it in place; session.start passes on unchanged', async ($, on) => {
    const clock = mock.clock(on, { now: 42 })
    const w = world(on, clock)
    await $.session.start(start)
    await clock.settle()
    expect(w.started).toEqual([start])
    expect(w.writes).toEqual([{ path: `${DATA}/S1/line.42.tmp`, text: '~/proj/x' }])
    expect(w.runs).toEqual([['mv', '-f', `${DATA}/S1/line.42.tmp`, `${DATA}/S1/line`]])
  })

  test('a tick with the same text and id writes nothing; a new id writes again', async ($, on) => {
    const clock = mock.clock(on, { now: 1 })
    const w = world(on, clock)
    await $.session.start(start)
    await clock.advance(1000)
    expect(w.writes).toHaveLength(1)
    w.id = 'S2'
    await clock.advance(1000)
    expect(w.writes.map(x => x.path)).toEqual([`${DATA}/S1/line.1.tmp`, `${DATA}/S2/line.1.tmp`])
  })

  test('when mv fails the line is written directly, and counts as written', async ($, on) => {
    const clock = mock.clock(on, { now: 7 })
    const w = world(on, clock)
    w.mv = 1
    await $.session.start(start)
    await clock.advance(1000)
    expect(w.writes.map(x => x.path)).toEqual([`${DATA}/S1/line.7.tmp`, `${DATA}/S1/line`])
  })

  test('when mv is refused (throws) the line is written directly', async ($, on) => {
    const clock = mock.clock(on, { now: 7 })
    const w = world(on, clock)
    w.mv = 'throw'
    await $.session.start(start)
    await clock.settle()
    expect(w.writes.map(x => x.path)).toEqual([`${DATA}/S1/line.7.tmp`, `${DATA}/S1/line`])
  })

  test('one write at a time; the newest waiting text wins', async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    let n = 0
    w.cwd = () => `/home/u/p${n++}`
    w.holdMs = 3500
    await $.session.start(start)
    for (let i = 0; i < 7; i++) await clock.advance(1000)
    const texts = w.writes.map(x => x.text)
    expect(w.maxInFlight).toBe(1)
    expect(texts[0]).toBe('~/p0')
    expect(texts).not.toContain('~/p1')
    expect(texts).not.toContain('~/p2')
    expect(texts).toContain('~/p3')
  })

  test('CLAUDE_CONFIG_DIR picks the data folder', async ($, on) => {
    const clock = mock.clock(on, { now: 3 })
    const w = world(on, clock, { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/cfg' })
    await $.session.start(start)
    await clock.settle()
    expect(w.writes[0]?.path).toBe('/cfg/plugins/data/vargus-vargus/S1/line.3.tmp')
  })

  test('a relative CLAUDE_CONFIG_DIR: nothing written', async ($, on) => {
    const clock = mock.clock(on, { now: 3 })
    const w = world(on, clock, { HOME: '/home/u', CLAUDE_CONFIG_DIR: 'rel' })
    await $.session.start(start)
    await clock.advance(1000)
    expect(w.writes).toEqual([])
  })

  test('nothing is written outside an interactive session', async ($, on) => {
    const clock = mock.clock(on, { now: 3 })
    const w = world(on, clock)
    await $.session.start({ ...start, surface: null, isInteractive: false })
    await clock.advance(2000)
    expect(w.writes).toEqual([])
  })

  test('no HOME and no CLAUDE_CONFIG_DIR: nothing written', async ($, on) => {
    const clock = mock.clock(on, { now: 3 })
    const w = world(on, clock, {})
    await $.session.start(start)
    await clock.advance(1000)
    expect(w.writes).toEqual([])
  })

  test('an empty session id: nothing written', async ($, on) => {
    const clock = mock.clock(on, { now: 3 })
    const w = world(on, clock)
    w.id = ''
    await $.session.start(start)
    await clock.advance(1000)
    expect(w.writes).toEqual([])
  })
})
