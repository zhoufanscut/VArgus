import { describe, expect, mock, test, type MockClock } from 'claude-code/testing'
import type { HttpInit, HttpResponse, On, SessionAuthorization, SessionRateLimit } from 'claude-code'

// The limits collector driven through the mod's own hooks (DESIGN, "Usage
// cache and staleness"). Every fragment but the limits is off, so the line
// file holds the limits fragment alone; direct provider reads are answered by
// an `http.fetch` hook (no network).

const ONLY_LIMITS = {
  folder: false, model: false, context: false, tokens: false, session: false,
  callCounts: false, repo: false, branch: false, status: false,
}
const opts = { options: ONLY_LIMITS }

const T0 = Date.parse('2026-10-15T09:00:00.000Z')
const SEC = 1000
const MIN = 60 * SEC
const KIMI_URL = 'https://api.kimi.com/coding/v1/usages'
const KIMI_ENV = {
  ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/',
  ANTHROPIC_AUTH_TOKEN: 'kimi-secret',
}
const KIMI_BODY = JSON.stringify({
  usages: {
    limit_5h: { used_ratio: 0.2453, reset_time: '2026-10-15T13:37:00Z' },
    limit_month_total: { used_ratio: 0.1109, reset_time: '2026-11-15T09:00:00Z' },
  },
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
    answer: () => reply(200, KIMI_BODY), holdMs: 0, started: false,
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
  test('default Anthropic session (unset ANTHROPIC_BASE_URL) ignores legacy OAuth cache and never calls session.authorize', opts, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const legacyOauthCache = {
      'usage:': {
        data: { extra: { percent: 33, resetsAt: null, spentUsd: 33, limitUsd: 100 }, others: [] },
        lastSuccessAt: T0, error: null, retryAt: T0 + 80 * SEC, rateLimitedCount: 0,
      },
    }
    const w = world(on, clock, {}, legacyOauthCache)
    w.engine = [
      { kind: 'five_hour', percentUsed: 4 },
      { kind: 'seven_day', percentUsed: 39 },
      { kind: 'spend_limit', percentUsed: 63 },
    ]
    await $.session.start(start)
    await clock.advance(200 * SEC)
    expect(w.fetches).toHaveLength(0)
    expect(w.authorizations).toBe(0)
    expect(line(w)).toBe('5h:4% 7d:39%')
  })

  test('explicit Anthropic ANTHROPIC_BASE_URL also uses engine windows only', opts, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on, clock, { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' })
    await $.session.start(start)
    await clock.advance(200 * SEC)
    expect(w.fetches).toHaveLength(0)
    expect(w.authorizations).toBe(0)
    expect(line(w)).toBe('5h:4%')
  })

  test('session.start: engine windows from usage(), direct provider read is not awaited', opts, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on, clock, KIMI_ENV)
    w.holdMs = 5 * SEC
    // Returns although the read is held until the test moves the clock: an
    // awaited read would never let it return.
    await $.session.start(start)
    await clock.advance(SEC)
    expect(w.fetches).toHaveLength(1)
    expect(line(w)).toBe('5h:4%')
    await clock.advance(5 * SEC)
    expect(line(w)).toBe('5h:4% 1mo:11%(30d23h)')
    expect(w.authorizations).toBe(0)
    expect(w.fetches[0]).toEqual({ url: KIMI_URL, init: { headers: { Authorization: 'Bearer kimi-secret' } } })
  })

  test('Kimi: direct 5h and 1mo usage with the env credential, never session.authorize', opts, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on, clock, KIMI_ENV)
    w.engine = []
    await $.session.start(start)
    await clock.advance(SEC)
    expect(w.fetches).toEqual([{
      url: KIMI_URL,
      init: { headers: { Authorization: 'Bearer kimi-secret' } },
    }])
    expect(w.authorizations).toBe(0)
    expect(line(w)).toBe('5h:25%(4h36m) 1mo:11%(30d23h)')
  })

  test('Kimi: direct providers bypass the nonessential-traffic flag, never session.authorize', opts, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on, clock, {
      ...KIMI_ENV,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    })
    w.engine = []
    await $.session.start(start)
    await clock.advance(SEC)
    expect(w.fetches).toHaveLength(1)
    expect(w.authorizations).toBe(0)
    expect(line(w)).toBe('5h:25%(4h36m) 1mo:11%(30d23h)')
  })

  test('session.measure pushes the engine windows and omits spend_limit', { options: { ...ONLY_LIMITS, spendLimit: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on, clock)
    await $.session.start(start)
    await clock.settle()
    await $.session.measure({
      context: { window: 200_000 }, changed: ['rateLimits'],
      rateLimits: [
        { kind: 'five_hour', percentUsed: 7 },
        { kind: 'seven_day', percentUsed: 40 },
        { kind: 'spend_limit', percentUsed: 80 },
      ],
    })
    await clock.advance(SEC)
    expect(line(w)).toBe('5h:7% 7d:40%')
  })

  test('one read at a time: a read held past the 15 s check is not started again', opts, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on, clock, KIMI_ENV)
    w.engine = []
    w.holdMs = 20 * SEC
    await $.session.start(start)
    await clock.advance(16 * SEC)
    expect(w.fetches).toHaveLength(1)
    await clock.advance(5 * SEC)
    expect(w.fetches).toHaveLength(1)
    expect(line(w)).toBe('5h:25%(4h36m) 1mo:11%(30d23h)')
  })

  test('the direct provider API is read every 90 s', opts, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on, clock, KIMI_ENV)
    await $.session.start(start)
    await clock.advance(89 * SEC)
    expect(w.fetches).toHaveLength(1)
    await clock.advance(1 * SEC)
    expect(w.fetches).toHaveLength(2)
    await clock.advance(90 * SEC)
    expect(w.fetches).toHaveLength(3)
  })

  test('one cache per provider and config directory: keyed by CLAUDE_CONFIG_DIR and tolerates pre-upgrade fields', opts, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const cached = {
      // A pre-upgrade cache can also contain legacy model-specific weekly and extra fields.
      data: {
        sonnet: { percent: 99, resetsAt: null }, opus: { percent: 45, resetsAt: null },
        others: [], extra: { percent: 33, resetsAt: null, spentUsd: 33, limitUsd: 100 },
        fiveHour: { percent: 18, resetsAt: null }, monthly: { percent: 33, resetsAt: null },
      },
      lastSuccessAt: T0 - 10 * SEC, error: null, retryAt: T0 + 80 * SEC, rateLimitedCount: 0,
    }
    const w = world(on, clock, { ...KIMI_ENV, CLAUDE_CONFIG_DIR: '/cfg/a' }, {
      'usage:kimi.com:/cfg/a': cached,
      'usage:kimi.com:/cfg/b': { ...cached, retryAt: 0 },
    })
    w.engine = []
    await $.session.start(start)
    await clock.advance(SEC)
    expect(w.fetches).toHaveLength(0)
    expect(line(w)).toBe('5h:18% 1mo:33%')
    await clock.advance(89 * SEC)
    expect(w.fetches).toHaveLength(1)
  })

  test('a cache of another config directory is not read', opts, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const cached = {
      data: { monthly: { percent: 33, resetsAt: null } },
      lastSuccessAt: T0, error: null, retryAt: T0 + 80 * SEC, rateLimitedCount: 0,
    }
    const w = world(on, clock, { ...KIMI_ENV, CLAUDE_CONFIG_DIR: '/cfg/b' }, { 'usage:kimi.com:/cfg/a': cached })
    w.engine = []
    await $.session.start(start)
    await clock.advance(SEC)
    expect(w.fetches).toHaveLength(1)
    expect(line(w)).toBe('5h:25%(4h36m) 1mo:11%(30d23h)')
  })

  test('401 is an auth error, 403 and throw are network errors; each shown when there is no data', opts, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on, clock, KIMI_ENV)
    w.answer = () => reply(401)
    await $.session.start(start)
    await clock.advance(SEC)
    expect(line(w)).toBe('5h:4% [API AUTH]')
    w.answer = () => reply(403)
    await clock.advance(120 * SEC)
    expect(w.fetches).toHaveLength(2)
    expect(line(w)).toBe('5h:4% [API ERR]')
    w.answer = () => 'throw'
    await clock.advance(120 * SEC)
    expect(w.fetches).toHaveLength(3)
    expect(line(w)).toBe('5h:4% [API ERR]')
  })

  test('after a 401 the next read waits the 2 min retry pace', opts, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on, clock, KIMI_ENV)
    w.answer = () => reply(401)
    await $.session.start(start)
    await clock.advance(119 * SEC)
    expect(w.fetches).toHaveLength(1)
    await clock.advance(SEC)
    expect(w.fetches).toHaveLength(2)
  })

  test('after a failed read the last numbers stay cleanly for 15 min without stale marks; then the error', opts, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on, clock, KIMI_ENV)
    await $.session.start(start)
    await clock.advance(SEC)
    expect(line(w)).toBe('5h:4% 1mo:11%(30d23h)')
    w.answer = () => reply(401)
    await clock.advance(90 * SEC)
    expect(line(w)).toBe('5h:4% 1mo:11%(30d23h)')
    // at 15 min after the good read: still shown cleanly
    await clock.advance(15 * MIN - 91 * SEC)
    expect(line(w)).toBe('5h:4% 1mo:11%(30d23h)')
    await clock.advance(SEC)
    expect(line(w)).toBe('5h:4% [API AUTH]')
  })

  test('429 honours a numeric Retry-After; the badge only when there is no data', opts, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on, clock, KIMI_ENV)
    w.answer = () => reply(429, '', { 'retry-after': '600' })
    await $.session.start(start)
    await clock.advance(SEC)
    expect(line(w)).toBe('5h:4% [API 429]')
    await clock.advance(598 * SEC)
    expect(w.fetches).toHaveLength(1)
    w.answer = () => reply(200, KIMI_BODY)
    await clock.advance(16 * SEC)
    expect(w.fetches).toHaveLength(2)
    expect(line(w)).toBe('5h:4% 1mo:11%(30d23h)')
  })

  // An hour of mock clock in 1 s ticks takes past the kit's 5000 ms default.
  test('a Retry-After past an hour is capped at an hour', { ...opts, timeoutMs: 30_000 }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on, clock, KIMI_ENV)
    w.answer = () => reply(429, '', { 'retry-after': '86400' })
    await $.session.start(start)
    await clock.advance(60 * MIN - SEC)
    expect(w.fetches).toHaveLength(1)
    await clock.advance(15 * SEC)
    expect(w.fetches).toHaveLength(2)
  })

  const freshCache = {
    'usage:kimi.com:': {
      data: { monthly: { percent: 33, resetsAt: null } },
      lastSuccessAt: T0, error: null, retryAt: T0 + 80 * SEC, rateLimitedCount: 0,
    },
  }

  const skippedCases: [string, Record<string, string>][] = [
    ['non-matching ANTHROPIC_BASE_URL', { ANTHROPIC_BASE_URL: 'https://gateway.example.com', ANTHROPIC_AUTH_TOKEN: 'secret' }],
    ['missing Kimi credential', { ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/' }],
  ]
  for (const [label, env] of skippedCases) {
    test(`${label}: no fetch and cached store entry is not shown`, opts, async ($, on) => {
      const clock = mock.clock(on, { now: T0 })
      const w = world(on, clock, env, freshCache)
      await $.session.start(start)
      await clock.advance(200 * SEC)
      expect(w.fetches).toHaveLength(0)
      expect(w.authorizations).toBe(0)
      expect(line(w)).toBe('5h:4%')
    })
  }

  test('hidden rate limits stop collection with a legacy detail view setting',
    { options: { ...ONLY_LIMITS, rateLimits: false, detailView: true } }, async ($, on) => {
      const clock = mock.clock(on, { now: T0 })
      const w = world(on, clock, KIMI_ENV)
      await $.session.start(start)
      await clock.advance(100 * SEC)
      expect(w.started).toBe(true)
      expect(w.fetches).toHaveLength(0)
      expect(w.authorizations).toBe(0)
    })

  test('nothing is read outside an interactive session', opts, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on, clock, KIMI_ENV)
    await $.session.start({ ...start, surface: null, isInteractive: false })
    await clock.advance(200 * SEC)
    expect(w.fetches).toHaveLength(0)
    expect(w.started).toBe(true)
  })
})
