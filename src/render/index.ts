import type { Fragment, FragmentInput, Theme } from '../core/types.ts'
import { en, type Labels } from '../i18n/en.ts'
import type { Options } from '../options.ts'
import { calls } from './fragments/calls.ts'
import { context } from './fragments/context.ts'
import { folder } from './fragments/folder.ts'
import { limits } from './fragments/limits.ts'
import { model } from './fragments/model.ts'
import { session } from './fragments/session.ts'
import { tokens } from './fragments/tokens.ts'
import { branch, repo, status } from './fragments/vcs.ts'
import { cleanText } from './text.ts'
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

function clipPlain(text: string, columns: number): string {
  if (columns <= 0) return ''
  if (stringWidth(text) <= columns) return text
  const budget = columns <= 3 ? columns : columns - 3
  let out = ''
  let width = 0
  for (const ch of text) {
    const w = stringWidth(ch)
    if (width + w > budget) break
    out += ch
    width += w
  }
  return columns <= 3 ? out : `${out.trimEnd()}...`
}

function configErrorMessage(error: unknown): string {
  const source = error instanceof Error && error.cause instanceof Error ? error.cause : error
  const raw = source instanceof Error ? source.message : String(source)
  return cleanText(raw.replace(/\s+/g, ' ')).trim()
}

/** Format a broken-config error tip for the status line in the alert colour, fitted to columns. */
export function configErrorLine(
  error: unknown,
  opts: { t: Theme; l?: Labels; columns?: number; file?: string },
): string {
  const { t, l = en, columns, file = 'vargus.jsonc' } = opts
  const detail = configErrorMessage(error)
  const prefix = `${l.configError} ${cleanText(file)}`
  const full = detail ? `${prefix}: ${detail}` : prefix
  let fitted = full
  if (columns !== undefined && stringWidth(full) > columns) {
    const badgeWidth = stringWidth(l.configError)
    fitted = columns >= badgeWidth && columns < badgeWidth + 4 ? l.configError : clipPlain(full, columns)
  }
  return fitted ? t.paint('alert', fitted) : ''
}
