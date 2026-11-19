import type { Fragment, Rgb, Theme } from '../../core/types.ts'
import { cleanText } from '../text.ts'

// 2. model: the model's short name, with `:effort` when the effort option is on
// and the model has one (`opus:high`) (DESIGN, "Fragments"; VantageHUD's
// elements/model.js, format `short`). Recorded Fast mode adds `(fast)`.

const EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

function normalizeEffort(effort: string): string {
  const level = effort.trim().toLowerCase()
  return level === 'none' ? 'off' : level
}

export function effortColor(t: Theme, effort: string | number, defaultEffort: string | undefined): Rgb {
  const { gradLow, gradHigh } = t.rgb
  if (typeof effort !== 'string') return gradHigh
  const level = normalizeEffort(effort)
  const baseline = normalizeEffort(defaultEffort ?? '') || 'high'
  const defaultRank = EFFORT_LEVELS.indexOf(baseline)
  const atOrAbove = level === baseline || (defaultRank >= 0 && EFFORT_LEVELS.indexOf(level) >= defaultRank)
  return atOrAbove ? gradLow : gradHigh
}

export const model: Fragment = ({ v, display, o, t }) => {
  const { modelName: name, speed } = display
  if (!name) return null
  const suffix = speed ? t.paint('faint', `(${speed})`) : ''
  const effort = o.effort ? v.session.effort : undefined
  if (effort === undefined || effort === '') return t.paint('gradLow', name) + suffix
  const level = cleanText(String(effort)).toLowerCase()
  return t.paint('label', `${name}:`) + t.paint(effortColor(t, effort, v.session.defaultEffort), level) + suffix
}
