import type { Fragment } from '../../core/types.ts'

// 4. context: `ctx:20%` (DESIGN, "Fragments"; VantageHUD's elements/context.js
// with its default thresholds, built in per DESIGN "Config").
// The colour moves at WARNING and CRITICAL (gradLow / gradMid / gradHigh), so
// it flips in step with the CRITICAL word; COMPRESS? shows from COMPACT.
// Shared with the detail view's Context card (src/hosts/claude/view/model.ts).
export const WARNING = 70
export const COMPACT = 80
export const CRITICAL = 85

export const context: Fragment = ({ display, l, t }) => {
  if (display.contextPercent === undefined) return null
  const percent = Math.min(100, Math.max(0, Math.round(display.contextPercent)))
  const suffix = percent >= CRITICAL ? ` ${l.critical}` : percent >= COMPACT ? ` ${l.compress}` : ''
  return t.paint('label', `${l.context}:`) + t.paint(t.gradient(percent, [WARNING, CRITICAL]), `${percent}%${suffix}`)
}
