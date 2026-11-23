import type { Fragment } from '../../core/types.ts'

// 4. context: `ctx:20%` (DESIGN, "Fragments"): calm below 80%, alert from 80%.
const ALERT_PERCENT = 80

export const context: Fragment = ({ display, l, t }) => {
  const percent = Math.min(100, Math.max(0, Math.round(display.contextPercent)))
  return t.paint('label', `${l.context}:`) + t.paint(percent >= ALERT_PERCENT ? 'alert' : 'calm', `${percent}%`)
}
