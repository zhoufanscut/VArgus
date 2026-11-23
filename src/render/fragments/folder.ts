import type { Fragment } from '../../core/types.ts'
import { cleanText, shortenHome } from '../text.ts'
import { stringWidth } from '../width.ts'

function folderLabel(cwd: string, home: string | undefined, threshold: number): string {
  const label = cleanText(shortenHome(cwd, home))
  if (stringWidth(label) <= threshold) return label

  const windows = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(cwd)
  const path = windows ? cwd.replace(/^[A-Za-z]:/, '') : cwd
  const parts = path.split(windows ? /[\\/]+/ : /\/+/).filter(Boolean)
  if (parts.length <= 2) return label
  const folded = '.../' + cleanText(parts.slice(-2).join('/'))
  return stringWidth(folded) < stringWidth(label) ? folded : label
}

export const folder: Fragment = ({ v, t, o }) =>
  v.core.cwd ? t.bold(t.paint('text', folderLabel(v.core.cwd, v.core.home, o.folderFoldThreshold))) : null
