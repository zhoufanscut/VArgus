import type { Fragment } from '../../core/types'

// 4. context: `ctx:20%` (DESIGN, "Fragments"; VantageHUD's elements/context.js
// with its default thresholds, built in per DESIGN "Config").
// The colour moves at WARNING and CRITICAL (gradLow / gradMid / gradHigh), so
// it flips in step with the CRITICAL word; COMPRESS? shows from COMPACT.
// Shared with the detail view's Context card (src/view/model.ts).
export const WARNING = 70
export const COMPACT = 80
export const CRITICAL = 85

// Before the first reading the percent is unknown and shows as 0 %, as
// VantageHUD's did (its getContextPercent fell back to 0).
export const context: Fragment = ({ v, l, t }) => {
  const percent = Math.min(100, Math.max(0, Math.round(v.session.contextPercent ?? 0)))
  const suffix = percent >= CRITICAL ? ` ${l.critical}` : percent >= COMPACT ? ` ${l.compress}` : ''
  return t.paint('label', `${l.context}:`) + t.paint(t.gradient(percent, [WARNING, CRITICAL]), `${percent}%${suffix}`)
}
