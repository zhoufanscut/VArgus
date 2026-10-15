import type { Fragment } from '../../core/types'
import { formatDuration } from '../format'

// 7. session time: `session:24m`, since $.session.usage().startedAt: a resumed
// session's whole age, /clear starting it over (DESIGN, "Fragments";
// VantageHUD's elements/session.js). Hidden until the start is known.

// The tier colour over 8 hours: 0-8 h mapped onto 0-100 %, so calm under
// 5.6 h, watch to 6.8 h, alert beyond.
const FULL_MINUTES = 8 * 60

export const session: Fragment = ({ v, l, t, now }) => {
  const start = v.session.startedAt
  if (start === undefined) return null
  const minutes = Math.max(0, Math.floor((now - start) / 60_000))
  return t.paint('label', `${l.session}:`) + t.paint(t.gradient((minutes / FULL_MINUTES) * 100), formatDuration(minutes))
}
