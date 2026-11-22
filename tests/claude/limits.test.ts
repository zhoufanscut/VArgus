import { describe, expect, test } from 'claude-code/testing'

import { claudeQuotaReadings, initialClaudeLimits, type ClaudeLimits, type UsageData } from '../../src/hosts/claude/quota'
import { parseUsage, retryAfterMs } from '../../src/hosts/claude/collect/limits'
import { directUsageProvider } from '../../src/hosts/claude/collect/usage-providers'
import { initialSession } from '../../src/hosts/claude/collect/session'
import { claudeDisplay } from '../../src/hosts/claude/display'
import { initialVcs } from '../../src/hosts/claude/collect/vcs'
import type { FragmentInput, Theme } from '../../src/core/types'
import { en, type Labels } from '../../src/i18n/en'
import { DEFAULTS, type Options } from '../../src/options'
import { limits } from '../../src/render/fragments/limits'
import { makeTheme } from '../../src/theme'

// The limits fragment and the usage API's parser (DESIGN, "Rules carried over
// from VantageHUD": Usage API, Usage cache and staleness, Limits display).

const NOW = Date.parse('2026-10-15T12:00:00.000Z')
const MIN = 60_000
const at = (ms: number) => new Date(NOW + ms).toISOString()

function draw(
  limitsValues: Partial<ClaudeLimits>,
  o: Partial<Options> = {},
  { l = en as Labels, t = makeTheme('graphite', true) }: { l?: Labels; t?: Theme } = {},
): string | null {
  const options = { ...DEFAULTS, ...o }
  const f: FragmentInput = {
    v: {
      core: { cwd: '/', home: undefined, columns: undefined, isWsl: false },
      session: initialSession(),
      limits: claudeQuotaReadings({ ...initialClaudeLimits(), ...limitsValues }, options, l, NOW),
      vcs: initialVcs(),
    },
    display: claudeDisplay(initialSession()),
    o: options,
    l,
    t,
    now: NOW,
  }
  return limits(f)
}

const engine = [
  { kind: 'five_hour', percentUsed: 4, resetsAt: at(277 * MIN) },
  { kind: 'seven_day', percentUsed: 39.4, resetsAt: at((5 * 24 + 6) * 60 * MIN + 30 * MIN) },
]

const api = (over: Partial<UsageData> = {}): UsageData => ({ extra: null, ...over })
const good = (data: UsageData): Partial<ClaudeLimits> => ({ api: data, lastSuccessAt: NOW - MIN, error: null })

describe('limits fragment', () => {
  test('the engine windows: 5h:4%(4h37m) 7d:39%(5d6h)', async () => {
    expect(draw({ engine })).toBe('5h:4%(4h37m) 7d:39%(5d6h)')
  })

  test('direct provider 5h and 1m windows; engine 5h wins without a duplicate', async () => {
    const fiveHour = { percent: 24.53, resetsAt: NOW + 277 * MIN }
    const monthly = { percent: 11.09, resetsAt: NOW + 31 * 24 * 60 * MIN }
    expect(draw(good(api({ fiveHour, monthly })))).toBe('5h:25%(4h37m) 1m:11%(31d0h)')
    expect(draw({ engine: [engine[0]!], ...good(api({ fiveHour: { ...fiveHour, percent: 90 }, monthly })) }))
      .toBe('5h:4%(4h37m) 1m:11%(31d0h)')
    expect(draw({ ...good(api({ fiveHour, monthly })), error: 'network' }))
      .toBe('5h:25%*(~4h37m) 1m:11%*(~31d0h)')
  })

  test('a window past its reset is not drawn; one with no reset time is kept', async () => {
    expect(draw({
      engine: [
        { kind: 'five_hour', percentUsed: 92, resetsAt: at(-1) },
        { kind: 'seven_day', percentUsed: 10 },
      ],
    })).toBe('7d:10%')
    expect(draw({ ...good(api({ monthly: { percent: 50, resetsAt: NOW } })) })).toBeNull()
    expect(draw({ ...good(api({ monthly: { percent: 50, resetsAt: null } })) })).toBe('1m:50%')
  })

  test('extra: with its dollars', async () => {
    const extra = { percent: 40, resetsAt: NOW + 59 * MIN, spentUsd: 20, limitUsd: 50 }
    expect(draw(good(api({ extra })))).toBe('extra:40%($20.00/$50.00)(59m)')
  })

  test('spend: only with spendLimit; percent not clamped; no dollars', async () => {
    const spend = [{ kind: 'spend_limit', percentUsed: 104.4, resetsAt: at((25 * 24 + 3) * 60 * MIN) }]
    expect(draw({ engine: spend })).toBeNull()
    expect(draw({ engine: spend }, { spendLimit: true })).toBe('spend:104%(25d3h)')
    expect(draw({ engine: [{ kind: 'five_hour', percentUsed: 104 }] })).toBe('5h:100%')
  })

  test('after a failed read: the API numbers stale-marked, the engine numbers never', async () => {
    const monthly = { percent: 12, resetsAt: NOW + 61 * MIN }
    expect(draw({ engine, api: api({ monthly }), lastSuccessAt: NOW - 14 * MIN, error: 'network' }))
      .toBe('5h:4%(4h37m) 7d:39%(5d6h) 1m:12%*(~1h1m)')
  })

  test('past 15 min after the last good read: the error instead of the numbers', async () => {
    const stale = (error: ClaudeLimits['error']) =>
      draw({ engine: engine.slice(0, 1), api: api({ monthly: { percent: 12, resetsAt: null } }), lastSuccessAt: NOW - 15 * MIN - 1, error })
    expect(stale('network')).toBe('5h:4%(4h37m) [API err]')
    expect(stale('auth')).toBe('5h:4%(4h37m) [API auth]')
    expect(stale('rate_limited')).toBe('5h:4%(4h37m) [API 429]')
    // at 15 min still shown, stale
    expect(draw({ api: api({ monthly: { percent: 12, resetsAt: null } }), lastSuccessAt: NOW - 15 * MIN, error: 'auth' }))
      .toBe('1m:12%*')
  })

  test('a 429 with data shows the data, no badge; with none, the faint badge', async () => {
    expect(draw({ api: api({ monthly: { percent: 5, resetsAt: null } }), lastSuccessAt: NOW, error: 'rate_limited' }))
      .toBe('1m:5%*')
    expect(draw({ error: 'rate_limited' })).toBe('[API 429]')
  })

  test('colours: labels in label, percent calm <80% and alert >=80%, * cost resets and 429 faint, auth/err alert', async () => {
    const base = makeTheme('graphite', true)
    const t: Theme = {
      ...base,
      paint: (c, text) => `<${typeof c === 'string' ? c : 'rgb'}>${text}`,
    }
    expect(draw({ api: api({ monthly: { percent: 12, resetsAt: NOW + 5 * MIN } }), lastSuccessAt: NOW, error: 'network' }, {}, { t }))
      .toBe('<label>1m:<calm>12%<faint>*<faint>(~5m)')
    expect(draw({ engine: [{ kind: 'five_hour', percentUsed: 79.4 }, { kind: 'seven_day', percentUsed: 79.5 }] }, {}, { t }))
      .toBe('<label>5h:<calm>79% <label>7d:<alert>80%')
    expect(draw({ error: 'rate_limited' }, {}, { t })).toBe('<faint>[API 429]')
    expect(draw({ error: 'auth' }, {}, { t })).toBe('<alert>[API auth]')
    expect(draw({ error: 'network' }, {}, { t })).toBe('<alert>[API err]')
    expect(draw({ engine: [{ kind: 'spend_limit', percentUsed: 130 }] }, { spendLimit: true }, { t }))
      .toBe('<label>spend:<alert>130%')
  })

  test('every word comes from the labels table', async () => {
    const marked = Object.fromEntries(Object.keys(en).map(k => [k, `⟦${k}⟧`])) as Labels
    const all = {
      engine: [...engine, { kind: 'spend_limit', percentUsed: 1 }],
      ...good(api({
        monthly: { percent: 2, resetsAt: null },
        extra: { percent: 1, resetsAt: null, spentUsd: 1, limitUsd: 2 },
      })),
    }
    const text = draw(all, { spendLimit: true }, { l: marked })!
    expect(text).toBe('⟦fiveHour⟧:4%(4h37m) ⟦sevenDay⟧:39%(5d6h) ⟦monthly⟧:2% ⟦extra⟧:1%($1.00/$2.00) ⟦spendLimit⟧:1%')
    expect(draw({ error: 'network' }, {}, { l: marked })).toBe('⟦apiError⟧')
    expect(draw({ error: 'auth' }, {}, { l: marked })).toBe('⟦apiAuth⟧')
    expect(draw({ error: 'rate_limited' }, {}, { l: marked })).toBe('⟦apiRateLimited⟧')
  })

  test('no data: no fragment', async () => {
    expect(draw({})).toBeNull()
  })
})

describe('usage API parser', () => {
  const body = {
    five_hour: { utilization: 4, resets_at: '2026-10-15T16:00:00Z' },
    seven_day: { utilization: 39 },
    limits: [
      { kind: 'weekly_scoped', percent: 95, scope: { model: { display_name: 'Sonnet' } } },
      { kind: 'weekly_scoped', percent: 12, scope: { model: { display_name: 'Opus' } } },
      { kind: 'weekly_scoped', percent: 99, scope: { model: { display_name: 'Fable' } } },
    ],
    extra_usage: { is_enabled: true, limit_usd: 50, spent_usd: 12.5, utilization: null, resets_at: '2026-11-01T00:00:00Z' },
  }

  test('OAuth keeps extra usage and ignores model-specific weekly limits', async () => {
    expect(parseUsage(body)).toEqual({
      extra: { percent: 25, resetsAt: Date.parse('2026-11-01T00:00:00Z'), spentUsd: 12.5, limitUsd: 50 },
    })
  })

  test('extra: is_enabled false or no limit_usd gives none; utilization wins over spent/limit', async () => {
    expect(parseUsage({ ...body, extra_usage: { ...body.extra_usage, is_enabled: false } })?.extra).toBeNull()
    expect(parseUsage({ ...body, extra_usage: { used_credits: 100, monthly_limit: 1000 } })?.extra).toBeNull()
    expect(parseUsage({ ...body, extra_usage: { ...body.extra_usage, utilization: 33 } })?.extra?.percent).toBe(33)
  })

  test('extra: none when the answer carries used_credits, even beside limit_usd (the plan is unknown)', async () => {
    const both = { ...body.extra_usage, used_credits: 1234, monthly_limit: 5000, currency: 'USD' }
    expect(parseUsage({ ...body, extra_usage: both })?.extra).toBeNull()
    expect(parseUsage({ ...body, extra_usage: { ...both, used_credits: null } })?.extra?.limitUsd).toBe(50)
  })

  test('not the usage shape: null (a failed read)', async () => {
    expect(parseUsage(null)).toBeNull()
    expect(parseUsage([])).toBeNull()
    expect(parseUsage({ error: 'x' })).toBeNull()
    expect(parseUsage({ five_hour: null })).toEqual({ extra: null })
  })

  test('Retry-After: seconds only, capped at 1 h', async () => {
    expect(retryAfterMs('120')).toBe(120_000)
    expect(retryAfterMs('999999')).toBe(3_600_000)
    expect(retryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT')).toBe(0)
    expect(retryAfterMs(undefined)).toBe(0)
  })
})

describe('Kimi direct usage provider', () => {
  test('matches only the two exact coding base URLs, allowing trailing slashes', async () => {
    expect(directUsageProvider('https://api.kimi.com/coding/')?.usageUrl)
      .toBe('https://api.kimi.com/coding/v1/usages')
    expect(directUsageProvider('https://api.kimi.ai/coding')?.usageUrl)
      .toBe('https://api.kimi.ai/coding/v1/usages')
    expect(directUsageProvider('https://api.kimi.com/coding/v1')).toBeNull()
    expect(directUsageProvider('https://api.kimi.com.evil.example/coding/')).toBeNull()
    expect(directUsageProvider('http://api.kimi.com/coding/')).toBeNull()
    expect(directUsageProvider('https://gateway.example.com/coding/')).toBeNull()
  })

  test('parses the measured 5h ratio and membership monthly total', async () => {
    const kimi = directUsageProvider('https://api.kimi.com/coding/')!
    const parsed = kimi.parse({
      usages: {
        limit_5h: { used_ratio: 0.2453, reset_time: '2026-11-10T10:11:17Z' },
        limit_month_total: { used_ratio: 0.1109, reset_time: '2026-12-09T00:00:00Z' },
        limit_month_code: { used_ratio: 0.1107, reset_time: '2026-12-09T00:00:00Z' },
      },
    })
    expect(parsed?.fiveHour?.percent).toBe(24.53)
    expect(parsed?.fiveHour?.resetsAt).toBe(Date.parse('2026-11-10T10:11:17Z'))
    expect(parsed?.monthly?.percent).toBe(11.09)
    expect(parsed?.monthly?.resetsAt).toBe(Date.parse('2026-12-09T00:00:00Z'))
  })

  test('falls back to the 300-minute count window; a non-usage answer fails', async () => {
    const kimi = directUsageProvider('https://api.kimi.com/coding/')!
    expect(kimi.parse({
      limits: [{
        window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
        detail: { limit: '100', used: '25', remaining: '75', resetTime: '2026-11-10T10:11:17.357463Z' },
      }],
    })?.fiveHour).toEqual({ percent: 25, resetsAt: Date.parse('2026-11-10T10:11:17.357463Z') })
    expect(kimi.parse({ error: 'x' })).toBeNull()
  })

  test('keeps monthly with a 5h fallback and accepts the cited remaining-only shape', async () => {
    const kimi = directUsageProvider('https://api.kimi.com/coding/')!
    const mixed = kimi.parse({
      usages: { limit_month_total: { used_ratio: 0.1109, reset_time: '2026-12-09T00:00:00Z' } },
      limits: [{
        window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
        detail: { limit: '100', used: '25', resetTime: '2026-11-10T10:11:17Z' },
      }],
    })
    expect(mixed?.fiveHour).toEqual({ percent: 25, resetsAt: Date.parse('2026-11-10T10:11:17Z') })
    expect(mixed?.monthly).toEqual({ percent: 11.09, resetsAt: Date.parse('2026-12-09T00:00:00Z') })
    const cited = kimi.parse({
      usage: { limit: '100', remaining: '100', resetTime: '2026-03-09T11:16:04.416717Z' },
      limits: [{
        window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
        detail: { limit: '100', remaining: '100', resetTime: '2026-03-03T11:16:04.416717Z' },
      }],
    })
    expect(cited?.fiveHour).toEqual({ percent: 0, resetsAt: Date.parse('2026-03-03T11:16:04.416717Z') })
  })
})
