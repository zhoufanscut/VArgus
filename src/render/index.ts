import type { Fragment, FragmentInput, Theme } from '../core/types.ts'
import type { Options } from '../options.ts'
import { calls } from './fragments/calls.ts'
import { context } from './fragments/context.ts'
import { folder } from './fragments/folder.ts'
import { limits } from './fragments/limits.ts'
import { model } from './fragments/model.ts'
import { session } from './fragments/session.ts'
import { tokens } from './fragments/tokens.ts'
import { branch, repo, status } from './fragments/vcs.ts'
import { stringWidth } from './width.ts'

// VantageHUD 0.6.0's order (DESIGN, "Fragments"), each behind its option.
export const ORDER: readonly (readonly [keyof Options, Fragment])[] = [
  ['folder', folder],
  ['model', model],
  ['rateLimits', limits],
  ['context', context],
  ['tokens', tokens],
  ['session', session],
  ['callCounts', calls],
  ['repo', repo],
  ['branch', branch],
  ['status', status],
]

const SEPARATOR = ' | '

export function joinParts(parts: readonly string[], t?: Theme): string {
  return parts.join(t ? t.paint('sep', SEPARATOR) : SEPARATOR)
}

// Pure: values + options + width → the line's fragments. A fragment that throws
// is left out, never the line; when the row is too narrow, whole fragments are
// dropped from the end (DESIGN, "Fragments").
export function renderParts(f: FragmentInput, order: typeof ORDER = ORDER): string[] {
  const parts: string[] = []
  for (const [option, fragment] of order) {
    if (!f.o[option]) continue
    try {
      const text = fragment(f)
      if (text) parts.push(text)
    } catch {
      // this fragment only
    }
  }
  const separator = f.t.paint('sep', SEPARATOR)
  const columns = f.v.core.columns
  while (columns !== undefined && parts.length > 1 && stringWidth(parts.join(separator)) > columns) {
    parts.pop()
  }
  return parts
}

export function render(f: FragmentInput, order: typeof ORDER = ORDER): string {
  return joinParts(renderParts(f, order), f.t)
}
