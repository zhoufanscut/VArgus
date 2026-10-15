import { describe, expect, mock, test, type MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

// The line file (DESIGN, "The line file"), driven through the mod's own hooks.

const DATA = '/home/u/.claude/plugins/data/vargus-vargus'

// The folder alone, uncoloured, so the line's text is known; the fragments
// have tests of their own.
const FOLDER_ONLY = {
  options: {
    model: false, rateLimits: false, context: false, tokens: false, session: false,
    callCounts: false, repo: false, branch: false, status: false,
  },
}

type World = {
  writes: { path: string; text: string }[]
  runs: string[][]
  id: string
  // mv's exit code, or 'throw' for a refused process
  mv: number | 'throw'
  // a cwd function, to change the text between ticks
  cwd: () => string
  // hold each fs.write, and each rm, this long on the mock clock
  holdMs: number
  rmHoldMs: number
  inFlight: number
  maxInFlight: number
  started: unknown[]
}

function world(on: On, clock: MockClock, env: Record<string, string> = { HOME: '/home/u', NO_COLOR: '1' }): World {
  const w: World = {
    writes: [], runs: [], id: 'S1', mv: 0, cwd: () => '/home/u/proj/x',
    holdMs: 0, rmHoldMs: 0, inFlight: 0, maxInFlight: 0, started: [],
  }
  mock.env(on, env)
  // Calls on `$` are answered `{ value }`; session.start needs a bottom too.
  on('session.start', async ($, e) => {
    w.started.push(e)
    return { cwd: e.cwd }
  })
  on('session.id', async () => ({ value: w.id }))
  on('session.cwd', async () => ({ value: w.cwd() }))
  on('session.end', async ($, e) => ({ sessionId: e.sessionId }))
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
    if (e.argv[0] === 'rm' && w.rmHoldMs) await clock.sleep(w.rmHoldMs)
    if (w.mv === 'throw') throw new Error('refused')
    return { value: { exitCode: w.mv, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return w
}

const start = { cwd: '/home/u/proj/x', surface: 'terminal', isInteractive: true } as const

describe('line file', () => {
  test('writes a temp file, then mv puts it in place; session.start passes on unchanged', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 42 })
    const w = world(on, clock)
    await $.session.start(start)
    await clock.settle()
    expect(w.started).toEqual([start])
    expect(w.writes).toEqual([{ path: `${DATA}/S1/line.42.tmp`, text: '~/proj/x' }])
    expect(w.runs).toEqual([['mv', '-f', `${DATA}/S1/line.42.tmp`, `${DATA}/S1/line`]])
  })

  test('a tick with the same text and id writes nothing; a new id writes again', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 1 })
    const w = world(on, clock)
    await $.session.start(start)
    await clock.advance(1000)
    expect(w.writes).toHaveLength(1)
    w.id = 'S2'
    await clock.advance(1000)
    expect(w.writes.map(x => x.path)).toEqual([`${DATA}/S1/line.1.tmp`, `${DATA}/S2/line.1.tmp`])
  })

  test('when mv fails the line is written directly, and counts as written', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 7 })
    const w = world(on, clock)
    w.mv = 1
    await $.session.start(start)
    await clock.advance(1000)
    expect(w.writes.map(x => x.path)).toEqual([`${DATA}/S1/line.7.tmp`, `${DATA}/S1/line`])
  })

  test('when mv is refused (throws) the line is written directly', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 7 })
    const w = world(on, clock)
    w.mv = 'throw'
    await $.session.start(start)
    await clock.settle()
    expect(w.writes.map(x => x.path)).toEqual([`${DATA}/S1/line.7.tmp`, `${DATA}/S1/line`])
  })

  test('one write at a time; the newest waiting text wins', FOLDER_ONLY, async ($, on) => {
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

  test('CLAUDE_CONFIG_DIR picks the data folder', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 3 })
    const w = world(on, clock, { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/cfg' })
    await $.session.start(start)
    await clock.settle()
    expect(w.writes[0]?.path).toBe('/cfg/plugins/data/vargus-vargus/S1/line.3.tmp')
  })

  test('a relative CLAUDE_CONFIG_DIR: nothing written', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 3 })
    const w = world(on, clock, { HOME: '/home/u', CLAUDE_CONFIG_DIR: 'rel' })
    await $.session.start(start)
    await clock.advance(1000)
    expect(w.writes).toEqual([])
  })

  test('nothing is written outside an interactive session', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 3 })
    const w = world(on, clock)
    await $.session.start({ ...start, surface: null, isInteractive: false })
    await clock.advance(2000)
    expect(w.writes).toEqual([])
  })

  test('no HOME and no CLAUDE_CONFIG_DIR: nothing written', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 3 })
    const w = world(on, clock, {})
    await $.session.start(start)
    await clock.advance(1000)
    expect(w.writes).toEqual([])
  })

  test('an empty session id: nothing written', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 3 })
    const w = world(on, clock)
    w.id = ''
    await $.session.start(start)
    await clock.advance(1000)
    expect(w.writes).toEqual([])
  })
})

describe('the session folder at session.end', () => {
  const end = (reason: 'clear' | 'resume' | 'prompt_input_exit', id = 'S1') =>
    ({ reason, sessionId: id, resume: { id } }) as const
  const rm = (id: string) => ['rm', '-rf', '--', `${DATA}/${id}`]

  test('is removed, and nothing more is written for that id', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 1 })
    const w = world(on, clock)
    let n = 0
    w.cwd = () => `/home/u/p${n++}`
    await $.session.start(start)
    await clock.settle()
    expect(await $.session.end(end('prompt_input_exit'))).toEqual({ sessionId: 'S1' })
    const writes = w.writes.length
    await clock.advance(3000)
    expect(w.runs.at(-1)).toEqual(rm('S1'))
    expect(w.writes).toHaveLength(writes)
  })

  test('after /clear the old folder goes and the new id is written', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 1 })
    const w = world(on, clock)
    await $.session.start(start)
    await clock.settle()
    await $.session.end(end('clear'))
    w.id = 'S2'
    await clock.advance(1000)
    expect(w.runs).toContainEqual(rm('S1'))
    expect(w.writes.map(x => x.path)).toEqual([`${DATA}/S1/line.1.tmp`, `${DATA}/S2/line.1.tmp`])
  })

  test('a write in flight finishes before the folder is removed', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 1 })
    const w = world(on, clock)
    w.holdMs = 500
    await $.session.start(start)
    // the first write is held in fs.write
    await clock.advance(100)
    expect(w.inFlight).toBe(1)
    const ending = $.session.end(end('prompt_input_exit'))
    await clock.advance(400)
    await ending
    expect(w.runs.map(r => r[0])).toEqual(['mv', 'rm'])
  })

  test('an id that is not a plain name is not removed', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 1 })
    const w = world(on, clock)
    await $.session.start(start)
    await clock.settle()
    for (const id of ['..', 'a/b', '']) await $.session.end(end('prompt_input_exit', id))
    expect(w.runs.filter(r => r[0] === 'rm')).toEqual([])
  })

  test('a later resume of the ended session writes its line again', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 1 })
    const w = world(on, clock)
    await $.session.start(start)
    await clock.settle()
    await $.session.end(end('clear'))
    w.id = 'S2'
    await clock.advance(1000)
    await $.session.end(end('resume', 'S2'))
    w.id = 'S1'
    await clock.advance(1000)
    expect(w.writes.map(x => x.path).at(-1)).toBe(`${DATA}/S1/line.1.tmp`)
  })

  test('nothing is written while the removal runs', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 1 })
    const w = world(on, clock)
    let n = 0
    w.cwd = () => `/home/u/p${n++}`
    w.rmHoldMs = 1500
    await $.session.start(start)
    await clock.settle()
    const writes = w.writes.length
    const ending = $.session.end(end('prompt_input_exit'))
    await clock.advance(2000)
    await ending
    expect(w.runs.at(-1)).toEqual(rm('S1'))
    expect(w.writes).toHaveLength(writes)
  })

  test('a relative CLAUDE_CONFIG_DIR: nothing removed', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 1 })
    const w = world(on, clock, { HOME: '/home/u', CLAUDE_CONFIG_DIR: 'rel' })
    await $.session.start(start)
    await clock.settle()
    await $.session.end(end('prompt_input_exit'))
    expect(w.runs).toEqual([])
  })

  test('outside an interactive session nothing is removed', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 1 })
    const w = world(on, clock)
    await $.session.start({ ...start, surface: null, isInteractive: false })
    await $.session.end(end('prompt_input_exit'))
    expect(w.runs).toEqual([])
  })
})
