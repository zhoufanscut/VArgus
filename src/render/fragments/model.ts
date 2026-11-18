import type { Fragment, Rgb, Theme } from '../../core/types.ts'
import { cleanText } from '../text.ts'

// 2. model: the model's short name, with `:effort` when the effort option is on
// and the model has one (`opus:high`) (DESIGN, "Fragments"; VantageHUD's
// elements/model.js, format `short`). Recorded Fast mode adds `(fast)`.

// Effort uses three flat tiers: low → alert, medium → middle, high and
// higher → calm. An unknown level or a numeric budget also uses calm.
export function effortColor(t: Theme, effort: string | number | undefined): Rgb {
  const { gradLow, gradMid, gradHigh } = t.rgb
  switch (String(effort ?? 'max').toLowerCase()) {
    case 'low': return gradHigh
    case 'medium': return gradMid
    default: return gradLow
  }
}

export const model: Fragment = ({ v, display, o, t }) => {
  const { modelName: name, speed } = display
  if (!name) return null
  const suffix = speed ? t.paint('faint', `(${speed})`) : ''
  const effort = o.effort ? v.session.effort : undefined
  if (effort === undefined || effort === '') return t.paint(effortColor(t, undefined), name) + suffix
  const level = cleanText(String(effort)).toLowerCase()
  return t.paint('label', `${name}:`) + t.paint(effortColor(t, effort), level) + suffix
}
