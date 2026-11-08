import { CodexCollector } from '../hosts/codex/collect'
import { readGit } from '../hosts/codex/vcs'
import { resolveOptions } from '../options'
import { render } from '../render'
import { makeTheme } from '../theme'
import { en } from '../i18n/en'

export function codexLine(collector: CodexCollector, o: ReturnType<typeof resolveOptions>, t: ReturnType<typeof makeTheme>) {
  let line: (width: number) => Promise<string>
      let gitAt = 0
      let gitCwd = ''
      let gitReading: Promise<void> | undefined
      line = async width => {
        const v = collector.snapshot()
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
        return render({ v, o, l: en, t, now: Date.now() })
      }
  return line
}
