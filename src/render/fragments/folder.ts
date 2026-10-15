import type { Fragment } from '../../core/types'
import { cleanText, shortenHome } from '../text'

// 1. folder: the working folder, `~` for home (VantageHUD's pathLabel).
export const folder: Fragment = ({ v, t }) =>
  v.core.cwd ? t.bold(t.paint('text', cleanText(shortenHome(v.core.cwd, v.core.home)))) : null
