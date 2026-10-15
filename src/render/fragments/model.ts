import type { Fragment, Rgb, Theme } from '../../core/types'
import { cleanText } from '../text'

// 2. model: the model's short name, with `:effort` when the effort option is on
// and the model has one (`opus:high`) (DESIGN, "Fragments"; VantageHUD's
// elements/model.js, format `short`).

// The short name (VantageHUD's modelFamilyKey), so a family that ships later
// needs no change: a Claude id or name gives the word after `claude`
// (`claude-opus-5-5[1m]` → opus), or for a legacy id (`claude-3-5-sonnet-…`)
// the family named in it; an ARN (an inference profile names no model) its
// service; anything else (a gateway's model) its first word (`gpt-4o` → gpt).
// VantageHUD cut that last word to 14 columns with `...`; here a long name
// is kept whole and the row drops whole fragments instead.
export function shortModelName(model: string): string | null {
  const id = model.trim().toLowerCase()
  if (id === '') return null
  const family = id.includes('claude') ? (AFTER_CLAUDE.exec(id)?.[1] ?? LEGACY_FAMILY.exec(id)?.[0]) : undefined
  if (family) return family
  if (id.startsWith('arn:')) return id.split(':')[2] || 'arn'
  return id.split(/[\s\-_/]+/).find(word => word !== '') ?? id
}

// `claude-opus-5-5`, `claude opus 5.5`: the word after claude, from a letter.
const AFTER_CLAUDE = /claude[-\s]+([a-z][a-z0-9.]*)/
// A legacy id puts the version first: the leftmost family name in it.
const LEGACY_FAMILY = /opus|sonnet|haiku|fable/

// Effort mapped onto the three tier colours, inverted so more effort reads
// calmer: max → gradLow ... low → gradHigh, each level its own hue
// (VantageHUD's EFFORT_COLOR). An unknown level or a numeric budget → gradLow.
export function effortColor(t: Theme, effort: string | number | undefined): Rgb {
  const { gradLow, gradMid, gradHigh } = t.rgb
  switch (String(effort ?? 'max').toLowerCase()) {
    case 'low': return gradHigh
    case 'medium': return t.lerp(gradMid, gradHigh, 0.5)
    case 'high': return gradMid
    case 'xhigh': return t.lerp(gradLow, gradMid, 0.5)
    default: return gradLow
  }
}

export const model: Fragment = ({ v, o, t }) => {
  const name = v.session.model === undefined ? null : shortModelName(cleanText(v.session.model))
  if (!name) return null
  const effort = o.effort ? v.session.effort : undefined
  if (effort === undefined || effort === '') return t.paint(effortColor(t, undefined), name)
  const level = cleanText(String(effort)).toLowerCase()
  return t.paint('label', `${name}:`) + t.paint(effortColor(t, effort), level)
}
