import { describe, expect, test } from 'claude-code/testing'

import { initialLimits, modelLabel, parseUsage, retryAfterMs, type LimitsValues, type UsageData } from '../src/collect/limits'
import { initialSession } from '../src/collect/session'
import { initialVcs } from '../src/collect/vcs'
import type { FragmentInput, Theme } from '../src/core/types'
import { en, type Labels } from '../src/i18n/en'
import { DEFAULTS, type Options } from '../src/options'
import { limits } from '../src/render/fragments/limits'
import { makeTheme } from '../src/theme'

// The limits fragment and the usage API's parser (DESIGN, "Rules carried over
// from VantageHUD": Usage API, Usage cache and staleness, Limits display).

const NOW = Date.parse('2026-10-15T12:00:00.000Z')
const MIN = 60_000
const at = (ms: number) => new Date(NOW + ms).toISOString()

function draw(
  limitsValues: Partial<LimitsValues>,
  o: Partial<Options> = {},
  { l = en as Labels, t = makeTheme('graphite', true) }: { l?: Labels; t?: Theme } = {},
): string | null {
  const f: FragmentInput = {
    v: {
      core: { cwd: '/', home: undefined, columns: undefined, isWsl: false },
      session: initialSession(),
      limits: { ...initialLimits(), ...limitsValues },
      vcs: initialVcs(),
    },
    o: { ...DEFAULTS, ...o },
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

const api = (over: Partial<UsageData> = {}): UsageData => ({ sonnet: null, opus: null, others: [], extra: null, ...over })
const good = (data: UsageData): Partial<LimitsValues> => ({ api: data, lastSuccessAt: NOW - MIN, error: null })

describe('limits fragment', () => {
  test('the engine windows: 5h:4%(4h37m) 7d:39%(5d6h)', async () => {
    expect(draw({ engine })).toBe('5h:4%(4h37m) 7d:39%(5d6h)')
  })

  test('a window past its reset is not drawn; one with no reset time is kept', async () => {
    expect(draw({
      engine: [
        { kind: 'five_hour', percentUsed: 92, resetsAt: at(-1) },
        { kind: 'seven_day', percentUsed: 10 },
      ],
    })).toBe('7d:10%')
    expect(draw({ ...good(api({ opus: { percent: 50, resetsAt: NOW } })) })).toBeNull()
    expect(draw({ ...good(api({ opus: { percent: 50, resetsAt: null } })) })).toBe('op:50%')
  })

  test('sn: from 80 %; op: always', async () => {
    const r = NOW + 25 * 60 * MIN
    expect(draw(good(api({ sonnet: { percent: 79.4, resetsAt: r }, opus: { percent: 3, resetsAt: r } }))))
      .toBe('op:3%(1d1h)')
    expect(draw(good(api({ sonnet: { percent: 79.5, resetsAt: r }, opus: { percent: 3, resetsAt: r } }))))
      .toBe('sn:80%(1d1h) op:3%(1d1h)')
  })

  test('other models only with otherModelWeekly, each from 80 %, labelled by the API', async () => {
    const data = api({ others: [{ label: 'fb', percent: 90, resetsAt: null }, { label: 'hk', percent: 10, resetsAt: null }] })
    expect(draw(good(data))).toBeNull()
    expect(draw(good(data), { otherModelWeekly: true })).toBe('fb:90%')
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
    const opus = { percent: 12, resetsAt: NOW + 61 * MIN }
    expect(draw({ engine, api: api({ opus }), lastSuccessAt: NOW - 14 * MIN, error: 'network' }))
      .toBe('5h:4%(4h37m) 7d:39%(5d6h) op:12%*(~1h1m)')
  })

  test('past 15 min after the last good read: the error instead of the numbers', async () => {
    const stale = (error: LimitsValues['error']) =>
      draw({ engine: engine.slice(0, 1), api: api({ opus: { percent: 12, resetsAt: null } }), lastSuccessAt: NOW - 15 * MIN - 1, error })
    expect(stale('network')).toBe('5h:4%(4h37m) [API err]')
    expect(stale('auth')).toBe('5h:4%(4h37m) [API auth]')
    expect(stale('rate_limited')).toBe('5h:4%(4h37m) [API 429]')
    // at 15 min still shown, stale
    expect(draw({ api: api({ opus: { percent: 12, resetsAt: null } }), lastSuccessAt: NOW - 15 * MIN, error: 'auth' }))
      .toBe('op:12%*')
  })

  test('a 429 with data shows the data, no badge; with none, the faint badge', async () => {
    expect(draw({ api: api({ opus: { percent: 5, resetsAt: null } }), lastSuccessAt: NOW, error: 'rate_limited' }))
      .toBe('op:5%*')
    expect(draw({ error: 'rate_limited' })).toBe('[API 429]')
  })

  test('colours: labels and resets in label, percent by the gradient, * faint, 429 faint, errors gradMid', async () => {
    const base = makeTheme('graphite', true)
    const t: Theme = {
      ...base,
      paint: (c, text) => `<${typeof c === 'string' ? c : 'g' + c.join(',')}>${text}`,
      gradient: p => [p, 0, 0],
    }
    expect(draw({ api: api({ opus: { percent: 12, resetsAt: NOW + 5 * MIN } }), lastSuccessAt: NOW, error: 'network' }, {}, { t }))
      .toBe('<label>op:<g12,0,0>12%<faint>*<label>(~5m)')
    expect(draw({ error: 'rate_limited' }, {}, { t })).toBe('<faint>[API 429]')
    expect(draw({ error: 'auth' }, {}, { t })).toBe('<gradMid>[API auth]')
    expect(draw({ engine: [{ kind: 'spend_limit', percentUsed: 130 }] }, { spendLimit: true }, { t }))
      .toBe('<label>spend:<g100,0,0>130%')
  })

  test('every word comes from the labels table', async () => {
    const marked = Object.fromEntries(Object.keys(en).map(k => [k, `⟦${k}⟧`])) as Labels
    const all = {
      engine: [...engine, { kind: 'spend_limit', percentUsed: 1 }],
      ...good(api({
        sonnet: { percent: 90, resetsAt: null }, opus: { percent: 1, resetsAt: null },
        extra: { percent: 1, resetsAt: null, spentUsd: 1, limitUsd: 2 },
      })),
    }
    const text = draw(all, { spendLimit: true }, { l: marked })!
    expect(text).toBe('⟦fiveHour⟧:4%(4h37m) ⟦sevenDay⟧:39%(5d6h) ⟦sonnetWeekly⟧:90% ⟦opusWeekly⟧:1% ⟦extra⟧:1%($1.00/$2.00) ⟦spendLimit⟧:1%')
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
    seven_day_opus: null,
    seven_day_sonnet: null,
    limits: [
      { kind: 'weekly_scoped', percent: 12, resets_at: '2026-10-20T00:00:00Z', scope: { model: { display_name: 'Opus' } } },
      { kind: 'weekly_scoped', percent: 81, resets_at: null, scope: { model: { display_name: 'Sonnet' } } },
      { kind: 'weekly_scoped', percent: 50, scope: { model: { display_name: 'Fable' } } },
      { kind: 'weekly_scoped', percent: 70, scope: { model: { display_name: 'Fable' } } },
      { kind: 'weekly_scoped', percent: 99, scope: { surface: 'web', model: { display_name: 'Haiku' } } },
      { kind: 'weekly_all', percent: 39 },
    ],
    extra_usage: { is_enabled: true, limit_usd: 50, spent_usd: 12.5, utilization: null, resets_at: '2026-11-01T00:00:00Z' },
  }

  test('per-model weekly from limits[] weekly_scoped; the highest per label; surface-scoped skipped', async () => {
    expect(parseUsage(body)).toEqual({
      opus: { percent: 12, resetsAt: Date.parse('2026-10-20T00:00:00Z') },
      sonnet: { percent: 81, resetsAt: null },
      others: [{ label: 'fb', percent: 70, resetsAt: null }],
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
    expect(parseUsage({ five_hour: null })).toEqual({ sonnet: null, opus: null, others: [], extra: null })
  })

  test('model labels: first letter + first consonant after it, letters only', async () => {
    expect([modelLabel('Sonnet'), modelLabel('Opus'), modelLabel('Fable'), modelLabel('Claude Opus 5')])
      .toEqual(['sn', 'op', 'fb', 'cl'])
    expect(modelLabel('\x1b[31mOpus')).toBe('op')
    expect(modelLabel('中文')).toBeNull()
  })

  test('Retry-After: seconds only, capped at 1 h', async () => {
    expect(retryAfterMs('120')).toBe(120_000)
    expect(retryAfterMs('999999')).toBe(3_600_000)
    expect(retryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT')).toBe(0)
    expect(retryAfterMs(undefined)).toBe(0)
  })
})
