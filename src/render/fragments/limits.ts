import type { QuotaWindow } from '../../core/limits.ts'
import type { Fragment, Theme } from '../../core/types.ts'
import { formatDuration } from '../format.ts'
import { cleanText } from '../text.ts'

// One window: label, percent by the gradient, stale `*`, the time to reset.
// Null for a window past its reset: its percent belongs to the window that
// just ended. A window with no reset time is kept (the API can send null).
function drawWindow(t: Theme, now: number, w: QuotaWindow): string | null {
  if (w.resetsAt !== null && w.resetsAt <= now) return null
  const rounded = Math.max(0, Math.round(w.percent))
  const pct = w.unclamped ? rounded : Math.min(100, rounded)
  let out = t.paint('label', `${cleanText(w.label)}:`) + t.paint(t.gradient(Math.min(100, pct)), `${pct}%`)
  if (w.stale) out += t.paint('faint', '*')
  if (w.cost) out += t.paint('faint', `($${w.cost.spentUsd.toFixed(2)}/$${w.cost.limitUsd.toFixed(2)})`)
  if (w.resetsAt !== null) out += t.paint('label', `(${w.stale ? '~' : ''}${formatDuration((w.resetsAt - now) / 60_000)})`)
  return out
}

export const limits: Fragment = ({ v, l, t, now }) => {
  const parts = v.limits.map(reading => {
    switch (reading) {
      case 'rate_limited': return t.paint('faint', l.apiRateLimited)
      case 'auth': return t.paint('gradMid', l.apiAuth)
      case 'network': return t.paint('gradMid', l.apiError)
      default: return drawWindow(t, now, reading)
    }
  })
  return parts.filter(Boolean).join(' ') || null
}
