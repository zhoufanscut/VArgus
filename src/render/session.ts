import type { SessionValues } from '../core/session.ts'
import type { SessionDisplay } from '../core/types.ts'
import { cleanText } from './text.ts'

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

export function displaySession(
  session: SessionValues,
  shortName: (id: string) => string | null,
  missingContext?: number,
): SessionDisplay {
  return {
    modelName: shortName(cleanText(session.model ?? '')),
    speed: session.fast ? 'fast' : undefined,
    contextPercent: session.contextPercent ?? missingContext,
    counts: session.counts,
  }
}
