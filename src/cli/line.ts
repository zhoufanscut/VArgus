import { CodexCollector } from '../hosts/codex/collect.ts'
import { codexDisplay } from '../hosts/codex/display.ts'
import type { CodexOptions } from '../hosts/codex/options.ts'
import { pollGit } from '../hosts/codex/vcs.ts'
import { render } from '../render/index.ts'
import { makeTheme } from '../theme/index.ts'
import { en } from '../i18n/en.ts'
import type { FragmentInput } from '../core/types.ts'

export function codexLine(collector: CodexCollector, o: CodexOptions, t: ReturnType<typeof makeTheme>) {
  const refreshGit = o.repo || o.branch || o.status ? pollGit(o.detachedHead) : undefined
  let confirmed: FragmentInput | undefined
  const line = async (width: number): Promise<string> => {
    const v = collector.snapshot()
    if (!v) return ''
    v.core.columns = width
    refreshGit?.(v)
    const frame = { v, display: codexDisplay(v.session, o), o, l: en, t, now: Date.now() }
    const result = render(frame)
    if (result) confirmed = { ...frame, v: structuredClone(v), o: { ...o } }
    return result
  }
  return Object.assign(line, {
    paused(width: number): string {
      if (!confirmed) return ''
      return render({ ...confirmed, v: { ...confirmed.v, core: { ...confirmed.v.core, columns: width } } })
    },
  })
}
