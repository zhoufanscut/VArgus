import type { Fragment, FragmentInput } from '../core/types'
import type { Options } from '../options'
import { calls } from './fragments/calls'
import { context } from './fragments/context'
import { folder } from './fragments/folder'
import { limits } from './fragments/limits'
import { model } from './fragments/model'
import { session } from './fragments/session'
import { tokens } from './fragments/tokens'
import { branch, repo, status } from './fragments/vcs'
import { stringWidth } from './width'

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

// Pure: values + options + width → the line's text. A fragment that throws is
// left out, never the line; when the row is too narrow, whole fragments are
// dropped from the end (DESIGN, "When the line is written").
export function render(f: FragmentInput, order: typeof ORDER = ORDER): string {
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
  return parts.join(separator)
}
