import type { Fragment, Rgb, Theme } from '../../core/types.ts'
import { cleanText } from '../text.ts'

// 2. model: the model's short name, with `:effort` when the effort option is on
// and the model has one (`opus:high`) (DESIGN, "Fragments"; VantageHUD's
// elements/model.js, format `short`). Model variants (`(carbon)`) and recorded
// Fast mode (`(fast)`) follow in a faint parenthetical suffix.

const EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

function normalizeEffort(effort: string): string {
  const level = effort.trim().toLowerCase()
  return level === 'none' ? 'off' : level
}

export function effortColor(t: Theme, effort: string | number, defaultEffort: string | undefined): Rgb {
  const { calm, alert } = t.rgb
  if (typeof effort !== 'string') return alert
  const level = normalizeEffort(effort)
  const baseline = normalizeEffort(defaultEffort ?? '') || 'high'
  const defaultRank = EFFORT_LEVELS.indexOf(baseline)
  const atOrAbove = level === baseline || (defaultRank >= 0 && EFFORT_LEVELS.indexOf(level) >= defaultRank)
  return atOrAbove ? calm : alert
}

export const model: Fragment = ({ v, display, o, t }) => {
  const { modelName: name, modelVariant: variant, speed } = display
  if (!name) return null
  const details: string[] = []
  if (variant) details.push(cleanText(variant))
  if (speed) details.push(speed)
  const suffix = details.length ? t.paint('faint', `(${details.join(', ')})`) : ''
  const effort = o.effort ? v.session.effort : undefined
  if (effort === undefined || effort === '') return t.paint('label', name) + suffix
  const level = cleanText(String(effort)).toLowerCase()
  return t.paint('label', `${name}:`) + t.paint(effortColor(t, effort, v.session.defaultEffort), level) + suffix
}
