import type { Fragment } from '../../core/types.ts'
import { formatDuration } from '../format.ts'

// 7. session time: `session:24m`, since $.session.usage().startedAt: a resumed
// session's whole age, /clear starting it over (DESIGN, "Fragments";
// VantageHUD's elements/session.js). Hidden until the start is known.

// Calm under 12 hours, alert from 12 hours.
const ALERT_MINUTES = 12 * 60

export const session: Fragment = ({ v, l, t, now }) => {
  const start = v.session.startedAt
  if (start === undefined) return null
  const minutes = Math.max(0, Math.floor((now - start) / 60_000))
  return t.paint('label', `${l.session}:`) + t.paint(minutes >= ALERT_MINUTES ? 'alert' : 'calm', formatDuration(minutes))
}
