import type { Theme } from '../core/types.ts'
import { en, type Labels } from '../i18n/en.ts'
import { stringWidth } from './width.ts'

// Writers normally refresh once per second. A deadline tolerates several missed ticks.
export const REFRESH_GRACE_MS = 5000
const STALE_ICON = '⌛'
const SEPARATOR = ' | '

export type StaleStyle = { t?: Theme; l?: Labels; isWsl?: boolean }

function staleLabel({ t, l = en, isWsl = false }: StaleStyle): string {
  const text = isWsl ? `${l.staleMark}:${l.stale}` : `${STALE_ICON}${l.stale}`
  return t ? t.paint('label', text) : text
}

function staleSep(style: StaleStyle): string {
  return style.t ? style.t.paint('sep', SEPARATOR) : SEPARATOR
}

// Fit whole non-stale fragments before appending the stale marker so literal ` | `
// inside external names is never split under NO_COLOR.
export function staleParts(parts: readonly string[], columns?: number, style: StaleStyle = {}): string {
  const items = parts.filter(Boolean)
  if (items.length === 0) return ''
  const label = staleLabel(style)
  const sep = staleSep(style)
  const suffix = sep + label
  for (let count = items.length; count >= 1; count--) {
    const candidate = items.slice(0, count).join(sep) + suffix
    if (columns === undefined || stringWidth(candidate) <= columns) return candidate
  }
  return label
}

// Keep whole readings when the extra fragment would overflow the terminal.
// Idempotent when given a row that already ends with the stale marker.
export function staleLine(line: string, columns?: number, style: StaleStyle = {}): string {
  if (!line) return ''
  const label = staleLabel(style)
  if (line === label) return label
  const sep = staleSep(style)
  const suffix = sep + label
  const base = line.endsWith(suffix) ? line.slice(0, -suffix.length) : line
  if (!base) return label
  if (columns === undefined || stringWidth(base + suffix) <= columns) return base + suffix
  const indices: number[] = []
  if (sep !== SEPARATOR) {
    for (let at = base.indexOf(sep); at !== -1; at = base.indexOf(sep, at + sep.length)) indices.push(at)
  } else {
    for (const match of base.matchAll(/(?:\x1b\[[\d;]+m)? \| /g)) indices.push(match.index)
  }
  for (const at of indices.reverse()) {
    const shorter = base.slice(0, at)
    if (stringWidth(shorter + suffix) <= columns) return shorter + suffix
  }
  return label
}
