import { CodexCollector } from '../hosts/codex/collect.ts'
import { readGit } from '../hosts/codex/vcs.ts'
import { resolveOptions } from '../options.ts'
import { render } from '../render/index.ts'
import { makeTheme } from '../theme/index.ts'
import { en } from '../i18n/en.ts'
import type { FragmentInput } from '../core/types.ts'
import { initialVcs } from '../core/vcs.ts'

export function codexLine(collector: CodexCollector, o: ReturnType<typeof resolveOptions>, t: ReturnType<typeof makeTheme>) {
  const collectVcs = o.repo || o.branch || o.status
  let confirmed: FragmentInput | undefined
  let line: (width: number) => Promise<string>
      let gitAt = 0
      let gitCwd = ''
      let gitReading: Promise<void> | undefined
      line = async width => {
        const v = collector.snapshot()
        if (!v) return ''
        v.core.columns = width
        // A render or paused snapshot must not pair a new folder with old Git data.
        if (collectVcs && v.core.cwd !== gitCwd) v.vcs = initialVcs()
        if (collectVcs && !gitReading && (v.core.cwd !== gitCwd || Date.now() >= gitAt)) {
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
