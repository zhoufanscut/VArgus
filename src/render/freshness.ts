import type { Theme } from '../core/types.ts'
import { en, type Labels } from '../i18n/en.ts'
import { stringWidth } from './width.ts'

// Writers normally refresh once per second. A deadline tolerates several missed ticks.
export const REFRESH_GRACE_MS = 5000
const STALE_ICON = '⌛'
const SEPARATOR = ' | '

export type StaleStyle = { t?: Theme; l?: Labels; isWsl?: boolean }

function staleLabel({ t, l = en, isWsl = false }: StaleStyle): string {
  const text = isWsl ? `${l.staleMark}:${l.stale}` : l.stale
  const painted = t ? t.paint('label', text) : text
  return isWsl ? painted : STALE_ICON + painted
}

// Keep whole readings when the extra fragment would overflow the terminal.
export function staleLine(line: string, columns?: number, style: StaleStyle = {}): string {
  if (!line) return ''
  const label = staleLabel(style)
  const sep = style.t ? style.t.paint('sep', SEPARATOR) : SEPARATOR
  const suffix = sep + label
  if (columns === undefined || stringWidth(line + suffix) <= columns) return line + suffix
  const indices: number[] = []
  if (sep !== SEPARATOR) {
    for (let at = line.indexOf(sep); at !== -1; at = line.indexOf(sep, at + sep.length)) indices.push(at)
  } else {
    for (const match of line.matchAll(/(?:\x1b\[[\d;]+m)? \| /g)) indices.push(match.index)
  }
  for (const at of indices.reverse()) {
    const shorter = line.slice(0, at)
    if (stringWidth(shorter + suffix) <= columns) return shorter + suffix
  }
  return label
}
