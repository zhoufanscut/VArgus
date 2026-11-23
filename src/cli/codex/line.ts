import { CodexCollector } from '../../hosts/codex/collect.ts'
import { codexDisplay } from '../../hosts/codex/display.ts'
import type { CodexOptions } from '../../hosts/codex/options.ts'
import { pollVcs } from '../../hosts/codex/vcs.ts'
import { staleLine } from '../../render/freshness.ts'
import { render } from '../../render/index.ts'
import { makeTheme } from '../../theme/index.ts'
import { en } from '../../i18n/en.ts'
import type { FragmentInput } from '../../core/types.ts'

export function codexLine(collector: CodexCollector, o: CodexOptions, t: ReturnType<typeof makeTheme>, isWsl = false) {
  const refreshVcs = o.repo || o.branch || o.status ? pollVcs() : undefined
  let confirmed: FragmentInput | undefined
  const line = async (width: number): Promise<string> => {
    const v = collector.snapshot()
    if (!v) return ''
    v.core.columns = width
    v.core.isWsl = isWsl
    refreshVcs?.(v)
    const frame = { v, display: codexDisplay(v.session), o, l: en, t, now: Date.now() }
    const result = render(frame)
    if (result) confirmed = { ...frame, ...structuredClone({ v, display: frame.display }), o: { ...o } }
    return result
  }
  return Object.assign(line, {
    paused(width: number): string {
      if (!confirmed) return ''
      const rendered = render({ ...confirmed, v: { ...confirmed.v, core: { ...confirmed.v.core, columns: width } } })
      return staleLine(rendered, width, { t: confirmed.t, l: confirmed.l, isWsl: confirmed.v.core.isWsl })
    },
  })
}
