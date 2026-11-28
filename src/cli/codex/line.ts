import { addCounts, type Counts } from '../../core/session.ts'
import { initialVcs } from '../../core/vcs.ts'
import { CodexCollector } from '../../hosts/codex/collect.ts'
import { codexDisplay } from '../../hosts/codex/display.ts'
import type { CodexOptions } from '../../hosts/codex/options.ts'
import { pollVcs } from '../../hosts/codex/vcs.ts'
import { staleParts } from '../../render/freshness.ts'
import { joinParts, renderParts } from '../../render/index.ts'
import { makeTheme } from '../../theme/index.ts'
import { en } from '../../i18n/en.ts'
import type { FragmentInput } from '../../core/types.ts'

export function codexLine(collector: CodexCollector, initialOptions: CodexOptions, initialTheme: ReturnType<typeof makeTheme>, isWsl = false) {
  let o = initialOptions
  let t = initialTheme
  let refreshVcs = o.repo || o.branch || o.status ? pollVcs() : undefined
  let confirmed: FragmentInput | undefined
  const renderFrame = async (width: number, extraCounts?: Counts): Promise<string[]> => {
    const v = collector.snapshot()
    if (!v) return []
    v.core.columns = width
    v.core.isWsl = isWsl
    refreshVcs?.(v)
    const renderedValues = extraCounts
      ? { ...v, session: { ...v.session, counts: addCounts(v.session.counts, extraCounts) } }
      : v
    const frame = { v: renderedValues, display: codexDisplay(renderedValues.session), o, l: en, t, now: Date.now() }
    const parts = renderParts(frame)
    if (parts.length) confirmed = { ...frame, ...structuredClone({ v: renderedValues, display: frame.display }), o: { ...o } }
    return parts
  }
  const pausedParts = (width: number): string[] => {
    if (!confirmed) return []
    return renderParts({ ...confirmed, v: { ...confirmed.v, core: { ...confirmed.v.core, columns: width } } })
  }
  const reconfigure = (nextOptions: CodexOptions, nextTheme: ReturnType<typeof makeTheme>): void => {
    o = nextOptions
    t = nextTheme
    const wantVcs = o.repo || o.branch || o.status
    if (wantVcs && !refreshVcs) {
      refreshVcs = pollVcs()
    } else if (!wantVcs && refreshVcs) {
      refreshVcs = undefined
      const snap = collector.snapshot()
      if (snap) snap.vcs = initialVcs()
    }
    if (confirmed) confirmed = { ...confirmed, o: { ...o }, t }
  }
  const line = async (width: number, extraCounts?: Counts): Promise<string> => joinParts(await renderFrame(width, extraCounts), t)
  return Object.assign(line, {
    parts: renderFrame,
    pausedParts,
    reconfigure,
    paused(width: number, stale = false): string {
      const parts = pausedParts(width)
      if (!parts.length) return ''
      return stale
        ? staleParts(parts, width, { t: confirmed!.t, l: confirmed!.l, isWsl: confirmed!.v.core.isWsl })
        : joinParts(parts, confirmed!.t)
    },
  })
}
