import { describe, expect, mock, test, type MockClock } from 'claude-code/testing'
import type { HttpInit, HttpResponse, On, SessionAuthorization, SessionRateLimit } from 'claude-code'

// The limits collector driven through the mod's own hooks (DESIGN, "Rules
// carried over from VantageHUD": Usage API, Usage cache and staleness). Every
// fragment but the limits is off, so the line file holds the limits fragment
// alone; the usage API is answered by an `http.fetch` hook (no network).

const ONLY_LIMITS = {
  folder: false, model: false, context: false, tokens: false, session: false,
  callCounts: false, repo: false, branch: false, status: false,
}
const opts = { options: ONLY_LIMITS }

const T0 = Date.parse('2026-10-15T09:00:00.000Z')
const SEC = 1000
const MIN = 60 * SEC
const URL = 'https://api.anthropic.com/api/oauth/usage'

const BODY = JSON.stringify({
  five_hour: { utilization: 50, resets_at: null },
  seven_day: { utilization: 60, resets_at: null },
  seven_day_opus: null,
  limits: [{ kind: 'weekly_scoped', percent: 12, resets_at: null, scope: { model: { display_name: 'Opus' } } }],
})

const reply = (status: number, text = '', headers: Record<string, string> = {}): HttpResponse =>
  ({ status, ok: status >= 200 && status < 300, headers, text })

type World = {
  writes: string[]
  fetches: { url: string; init?: HttpInit }[]
  authorizations: number
  auth: SessionAuthorization
  engine: SessionRateLimit[]
  answer: () => HttpResponse | 'throw'
  holdMs: number
  started: boolean
}

function world(on: On, clock: MockClock, env: Record<string, string> = {}, store: Record<string, unknown> = {}): World {
  const w: World = {
    writes: [], fetches: [], authorizations: 0,
    auth: { handle: 'h1', kind: 'bearer' },
    engine: [{ kind: 'five_hour', percentUsed: 4 }],
    answer: () => reply(200, BODY), holdMs: 0, started: false,
  }
  mock.env(on, { HOME: '/home/u', NO_COLOR: '1', ...env }) // plain text to match
  mock.store(on, store)
  // Calls on `$` are answered `{ value }`; session.start and session.measure
  // need a bottom too.
  on('session.start', async ($, e) => {
    w.started = true
    return { cwd: e.cwd }
  })
  on('session.measure', async ($, e) => ({ changed: e.changed }))
  on('session.id', async () => ({ value: 'S1' }))
  on('session.cwd', async () => ({ value: '/home/u/p' }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('fs.write', async ($, e) => {
    if (e.path.endsWith('.tmp')) w.writes.push(e.text)
    return { value: undefined }
  })
  on('process.run', async () =>
    ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.usage', async () => ({ value: { startedAt: T0, context: { window: 200_000 }, rateLimits: w.engine } }))
  on('session.authorize', async () => {
    w.authorizations += 1
    return { value: w.auth }
  })
  on('http.fetch', async ($, e) => {
    w.fetches.push({ url: e.url, init: e.init })
    if (w.holdMs) await clock.sleep(w.holdMs)
    const a = w.answer()
    if (a === 'throw') throw new Error('refused')
    return { value: a }
  })
  return w
}

const start = { cwd: '/home/u/p', surface: 'terminal', isInteractive: true } as const
const line = (w: World) => w.writes.at(-1)

describe('limits collector', () => {
  test('session.start: engine windows from usage(), the API read with the session handle, not awaited', opts, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on, clock)
    w.holdMs = 5 * SEC
    // Returns although the read is held until the test moves the clock: an
    // awaited read would never let it return.
    await $.session.start(start)
    await clock.advance(SEC)
    expect(w.fetches).toHaveLength(1)
    expect(line(w)).toBe('5h:4%')
    await clock.advance(5 * SEC)
    expect(line(w)).toBe('5h:4% op:12%')
    // never a token or a refresh: only the engine's handle rides the request
    expect(w.fetches[0]).toEqual({ url: URL, init: { headers: { 'anthropic-beta': 'oauth-2025-04-20' }, auth: 'h1' } })
  })

  test('session.measure pushes the engine windows', opts, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on, clock)
    await $.session.start(start)
    await clock.settle()
    await $.session.measure({
      context: { window: 200_000 }, changed: ['rateLimits'],
      rateLimits: [{ kind: 'five_hour', percentUsed: 7 }, { kind: 'seven_day', percentUsed: 40 }],
    })
    await clock.advance(SEC)
    expect(line(w)).toBe('5h:7% 7d:40% op:12%')
  })

  test('one read at a time: a read held past the 15 s check is not started again', opts, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on, clock)
    w.holdMs = 20 * SEC
    await $.session.start(start)
    await clock.advance(16 * SEC)
    expect(w.fetches).toHaveLength(1)
    await clock.advance(5 * SEC)
    expect(w.fetches).toHaveLength(1)
    expect(line(w)).toBe('5h:4% op:12%')
  })

  test('the API is read every 90 s, and a fresh cache in the store is used without a read', opts, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on, clock)
    await $.session.start(start)
    await clock.advance(89 * SEC)
    expect(w.fetches).toHaveLength(1)
    await clock.advance(1 * SEC)
    expect(w.fetches).toHaveLength(2)
    await clock.advance(90 * SEC)
    expect(w.fetches).toHaveLength(3)
  })

  test('one cache per account: keyed by CLAUDE_CONFIG_DIR', opts, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const cached = {
      data: { sonnet: null, opus: { percent: 33, resetsAt: null }, others: [], extra: null },
      lastSuccessAt: T0 - 10 * SEC, error: null, retryAt: T0 + 80 * SEC, rateLimitedCount: 0,
    }
    const w = world(on, clock, { CLAUDE_CONFIG_DIR: '/cfg/a' }, { 'usage:/cfg/a': cached, 'usage:/cfg/b': { ...cached, retryAt: 0 } })
    await $.session.start(start)
    await clock.advance(SEC)
    expect(w.fetches).toHaveLength(0)
    expect(line(w)).toBe('5h:4% op:33%')
    await clock.advance(89 * SEC)
    expect(w.fetches).toHaveLength(1)
  })

  test('a cache of another account is not read', opts, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const cached = {
      data: { sonnet: null, opus: { percent: 33, resetsAt: null }, others: [], extra: null },
      lastSuccessAt: T0, error: null, retryAt: T0 + 80 * SEC, rateLimitedCount: 0,
    }
    const w = world(on, clock, { CLAUDE_CONFIG_DIR: '/cfg/b' }, { 'usage:/cfg/a': cached })
    await $.session.start(start)
    await clock.advance(SEC)
    expect(w.fetches).toHaveLength(1)
    expect(line(w)).toBe('5h:4% op:12%')
  })

  test('401 is an auth error, 403 a network error; each shown when there is no data', opts, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on, clock)
    w.answer = () => reply(401)
    await $.session.start(start)
    await clock.advance(SEC)
    expect(line(w)).toBe('5h:4% [API auth]')
    w.answer = () => reply(403)
    await clock.advance(120 * SEC)
    expect(w.fetches).toHaveLength(2)
    expect(line(w)).toBe('5h:4% [API err]')
    w.answer = () => 'throw'
    await clock.advance(120 * SEC)
    expect(w.fetches).toHaveLength(3)
    expect(line(w)).toBe('5h:4% [API err]')
  })

  test('after a 401 the next read waits the 2 min retry pace (no token to fingerprint)', opts, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on, clock)
    w.answer = () => reply(401)
    await $.session.start(start)
    await clock.advance(119 * SEC)
    expect(w.fetches).toHaveLength(1)
    await clock.advance(SEC)
    expect(w.fetches).toHaveLength(2)
  })

  test('after a failed read the last numbers stay, marked stale, for 15 min; then the error', opts, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on, clock)
    await $.session.start(start)
    await clock.advance(SEC)
    expect(line(w)).toBe('5h:4% op:12%')
    w.answer = () => reply(401)
    await clock.advance(90 * SEC)
    expect(line(w)).toBe('5h:4% op:12%*')
    // at 15 min after the good read: still shown
    await clock.advance(15 * MIN - 91 * SEC)
    expect(line(w)).toBe('5h:4% op:12%*')
    await clock.advance(SEC)
    expect(line(w)).toBe('5h:4% [API auth]')
  })

  test('429 honours a numeric Retry-After; the badge only when there is no data', opts, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on, clock)
    w.answer = () => reply(429, '', { 'retry-after': '600' })
    await $.session.start(start)
    await clock.advance(SEC)
    expect(line(w)).toBe('5h:4% [API 429]')
    await clock.advance(598 * SEC)
    expect(w.fetches).toHaveLength(1)
    w.answer = () => reply(200, BODY)
    await clock.advance(16 * SEC)
    expect(w.fetches).toHaveLength(2)
    expect(line(w)).toBe('5h:4% op:12%')
  })

  // An hour of mock clock in 1 s ticks takes past the kit's 5000 ms default.
  test('a Retry-After past an hour is capped at an hour', { ...opts, timeoutMs: 30_000 }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on, clock)
    w.answer = () => reply(429, '', { 'retry-after': '86400' })
    await $.session.start(start)
    await clock.advance(60 * MIN - SEC)
    expect(w.fetches).toHaveLength(1)
    await clock.advance(15 * SEC)
    expect(w.fetches).toHaveLength(2)
  })

  test('skipped behind a non-Anthropic ANTHROPIC_BASE_URL', opts, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on, clock, { ANTHROPIC_BASE_URL: 'https://gateway.example.com' })
    await $.session.start(start)
    await clock.advance(200 * SEC)
    expect(w.fetches).toHaveLength(0)
    expect(line(w)).toBe('5h:4%')
  })

  test('an Anthropic ANTHROPIC_BASE_URL, or an empty one, is read', opts, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on, clock, { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', CLAUDE_CODE_USE_VERTEX: '0' })
    await $.session.start(start)
    await clock.settle()
    expect(w.fetches).toHaveLength(1)
  })

  for (const flag of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']) {
    test(`skipped with ${flag}`, opts, async ($, on) => {
      const clock = mock.clock(on, { now: T0 })
      const w = world(on, clock, { [flag]: '1' })
      await $.session.start(start)
      await clock.advance(100 * SEC)
      expect(w.fetches).toHaveLength(0)
      expect(w.authorizations).toBe(0)
    })
  }

  test('no credential (authorize null) or an API key: no read, no badge, the engine windows still', opts, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on, clock)
    w.auth = null
    await $.session.start(start)
    await clock.settle()
    expect(w.authorizations).toBe(1)
    w.auth = { handle: 'k', kind: 'api-key' }
    await clock.advance(15 * SEC)
    expect(w.authorizations).toBe(2)
    expect(w.fetches).toHaveLength(0)
    expect(line(w)).toBe('5h:4%')
  })

  // The cache is per config folder, not per login: these sessions must not
  // show the numbers another login left there.
  const freshCache = {
    'usage:': {
      data: { sonnet: null, opus: { percent: 33, resetsAt: null }, others: [], extra: null },
      lastSuccessAt: T0, error: null, retryAt: T0 + 80 * SEC, rateLimitedCount: 0,
    },
  }

  for (const [kind, auth] of [['an API key', { handle: 'k', kind: 'api-key' }], ['no credential', null]] as const) {
    test(`${kind}: a fresh cache in the store is not shown`, opts, async ($, on) => {
      const clock = mock.clock(on, { now: T0 })
      const w = world(on, clock, {}, freshCache)
      w.auth = auth
      await $.session.start(start)
      await clock.advance(SEC)
      expect(line(w)).toBe('5h:4%')
      expect(w.fetches).toHaveLength(0)
    })
  }

  test('behind a non-Anthropic ANTHROPIC_BASE_URL a fresh cache in the store is not shown', opts, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on, clock, { ANTHROPIC_BASE_URL: 'https://gateway.example.com' }, freshCache)
    await $.session.start(start)
    await clock.advance(SEC)
    expect(line(w)).toBe('5h:4%')
  })

  test('nothing is read outside an interactive session', opts, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on, clock)
    await $.session.start({ ...start, surface: null, isInteractive: false })
    await clock.advance(200 * SEC)
    expect(w.fetches).toHaveLength(0)
    expect(w.started).toBe(true)
  })
})
