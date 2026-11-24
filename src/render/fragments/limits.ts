import type { QuotaWindow } from '../../core/limits.ts'
import type { Fragment, Theme } from '../../core/types.ts'
import { formatDuration } from '../format.ts'
import { cleanText } from '../text.ts'

const ALERT_PERCENT = 80

// One window: label, calm/alert percent at 80%, and reset time in detail.
// Null for a window past its reset: its percent belongs to the window that
// just ended. A window with no reset time is kept (the API can send null).
function drawWindow(t: Theme, now: number, w: QuotaWindow): string | null {
  if (w.resetsAt !== null && w.resetsAt <= now) return null
  const pct = Math.min(100, Math.max(0, Math.round(w.percent)))
  let out = t.paint('label', `${cleanText(w.label)}:`) + t.paint(pct >= ALERT_PERCENT ? 'alert' : 'calm', `${pct}%`)
  if (w.resetsAt !== null) out += t.paint('detail', `(${formatDuration((w.resetsAt - now) / 60_000)})`)
  return out
}

export const limits: Fragment = ({ v, l, t, now }) => {
  const parts = v.limits.map(reading => {
    switch (reading) {
      case 'rate_limited': return t.paint('alert', l.apiRateLimited)
      case 'auth': return t.paint('alert', l.apiAuth)
      case 'network': return t.paint('alert', l.apiError)
      default: return drawWindow(t, now, reading)
    }
  })
  return parts.filter(Boolean).join(' ') || null
}
