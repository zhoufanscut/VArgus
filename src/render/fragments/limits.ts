import type { Fragment, Theme } from '../../core/types'
import { MAX_STALE_MS } from '../../collect/limits'
import { formatDuration } from '../format'

// The rate limits (DESIGN, "Fragments" row 3; "Rules carried over from
// VantageHUD": Limits display, Usage cache and staleness):
// `5h:4%(4h37m) 7d:39%(5d6h) sn:85%(2d1h) op:12%(2d1h) extra:40%($20.00/$50.00)(9d2h) spend:63%(25d3h)`.

// Sonnet's weekly, and other models' with otherModelWeekly on, show from this
// percent (VantageHUD's sonnetWeeklyVisibility default): a model barely used
// would otherwise sit at 0% on every line.
export const MODEL_WEEKLY_FROM = 80

type Window = {
  label: string
  percent: number
  resetsAt: number | null
  stale?: boolean
  // the spend limit's percent is not clamped: an exceeded one reads 104%
  unclamped?: boolean
  // extra usage's `($spent/$limit)`, between the percent and the reset
  dollars?: string
}

// One window: label, percent by the gradient, stale `*`, the time to reset.
// Null for a window past its reset: its percent belongs to the window that
// just ended. A window with no reset time is kept (the API can send null).
function drawWindow(t: Theme, now: number, w: Window): string | null {
  if (w.resetsAt !== null && w.resetsAt <= now) return null
  const rounded = Math.max(0, Math.round(w.percent))
  const pct = w.unclamped ? rounded : Math.min(100, rounded)
  let out = t.paint('label', `${w.label}:`) + t.paint(t.gradient(Math.min(100, pct)), `${pct}%`)
  if (w.stale) out += t.paint('faint', '*')
  if (w.dollars) out += t.paint('faint', w.dollars)
  if (w.resetsAt !== null) out += t.paint('label', `(${w.stale ? '~' : ''}${formatDuration((w.resetsAt - now) / 60_000)})`)
  return out
}

function engineTime(iso: string | undefined): number | null {
  const ms = iso ? Date.parse(iso) : NaN
  return Number.isNaN(ms) ? null : ms
}

export const limits: Fragment = ({ v, o, l, t, now }) => {
  const L = v.limits
  const parts: (string | null)[] = []
  const engine = (kind: string) => L.engine.find(r => r.kind === kind)

  // The engine's windows are live: never stale-marked.
  for (const [kind, label] of [['five_hour', l.fiveHour], ['seven_day', l.sevenDay]] as const) {
    const r = engine(kind)
    if (r) parts.push(drawWindow(t, now, { label, percent: r.percentUsed, resetsAt: engineTime(r.resetsAt) }))
  }

  // The usage API's numbers: shown up to 15 min after the last good read,
  // stale-marked while the last read failed; past that, the error instead.
  const api = L.api && L.lastSuccessAt !== null && now - L.lastSuccessAt <= MAX_STALE_MS ? L.api : null
  const stale = L.error !== null
  if (api) {
    const shown = (p: number) => Math.round(p) >= MODEL_WEEKLY_FROM
    if (api.sonnet && shown(api.sonnet.percent)) parts.push(drawWindow(t, now, { label: l.sonnetWeekly, ...api.sonnet, stale }))
    if (api.opus) parts.push(drawWindow(t, now, { label: l.opusWeekly, ...api.opus, stale }))
    // Other models' labels come from the API's model name, letters only.
    if (o.otherModelWeekly) {
      for (const m of api.others) if (shown(m.percent)) parts.push(drawWindow(t, now, { ...m, stale }))
    }
    if (api.extra) {
      const dollars = `($${api.extra.spentUsd.toFixed(2)}/$${api.extra.limitUsd.toFixed(2)})`
      parts.push(drawWindow(t, now, { label: l.extra, ...api.extra, stale, dollars }))
    }
  } else if (L.error === 'rate_limited') {
    parts.push(t.paint('faint', l.apiRateLimited))
  } else if (L.error === 'auth') {
    parts.push(t.paint('gradMid', l.apiAuth))
  } else if (L.error === 'network') {
    parts.push(t.paint('gradMid', l.apiError))
  }

  // A Claude gateway's spend limit, opt-in. No dollars: the engine gives
  // none (DESIGN, "What VArgus cannot show").
  const spend = o.spendLimit ? engine('spend_limit') : undefined
  if (spend) {
    parts.push(drawWindow(t, now, {
      label: l.spendLimit, percent: spend.percentUsed, resetsAt: engineTime(spend.resetsAt), unclamped: true,
    }))
  }

  const text = parts.filter(Boolean).join(' ')
  return text || null
}
