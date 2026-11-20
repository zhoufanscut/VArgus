import { stringWidth } from './width.ts'

// Writers normally refresh once per second. A deadline tolerates several missed ticks.
export const REFRESH_GRACE_MS = 5000
const STALE_LABEL = '⚠ stale'
const STALE_SUFFIX = ' | ' + STALE_LABEL

// Keep whole readings when the extra fragment would overflow the terminal.
export function staleLine(line: string, columns?: number): string {
  if (!line) return ''
  if (columns === undefined || stringWidth(line + STALE_SUFFIX) <= columns) return line + STALE_SUFFIX
  const separators = [...line.matchAll(/(?:\x1b\[[\d;]+m)? \| /g)]
  for (const separator of separators.reverse()) {
    const shorter = line.slice(0, separator.index)
    if (stringWidth(shorter + STALE_SUFFIX) <= columns) return shorter + STALE_SUFFIX
  }
  return STALE_LABEL
}
