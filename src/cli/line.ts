import { CodexCollector } from '../hosts/codex/collect'
import { readGit } from '../hosts/codex/vcs'
import { resolveOptions } from '../options'
import { render } from '../render'
import { makeTheme } from '../theme'
import { en } from '../i18n/en'
import type { FragmentInput } from '../core/types'

export function codexLine(collector: CodexCollector, o: ReturnType<typeof resolveOptions>, t: ReturnType<typeof makeTheme>) {
  let confirmed: FragmentInput | undefined
  let line: (width: number, thread?: string) => Promise<string>
      let gitAt = 0
      let gitCwd = ''
      let gitReading: Promise<void> | undefined
      line = async (width, thread) => {
        const v = collector.snapshot(thread)
        if (!v) return ''
        v.core.columns = width
        if (!gitReading && (v.core.cwd !== gitCwd || Date.now() >= gitAt)) {
          const cwd = v.core.cwd
          gitCwd = cwd
          const start = Date.now()
          gitReading = readGit(cwd).then(value => {
            if (v.core.cwd === cwd) v.vcs = value
          }).finally(() => {
            gitAt = Date.now() + Math.max(5000, (Date.now() - start) * 10)
            gitReading = undefined
          })
        }
        const frame = { v, o, l: en, t, now: Date.now() }
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
