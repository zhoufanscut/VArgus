import { codexComposer } from './footer'
// Codex 0.167.0's contextual footer exposes the selected agent path even when
// configurable items are cleared. This is a versioned UI observation, not an API.
import { createReadStream } from 'node:fs'
import { readdir, realpath } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'

export type View = { thread: string; file: string; parent?: string; path?: string; cwd: string }
export type ViewScreen = { lines: string[]; x: number; y: number; visible: boolean; command: string }
export const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, '')

export class Views {
  readonly known = new Map<string, View>()
  private seen = new Set<string>()
  private ambiguous = new Set<string>()
  constructor(private home: string, readonly root: string, private rootFile?: string) {}
  async refresh(): Promise<void> {
    const directory = join(this.home, 'sessions')
    for (const name of await readdir(directory, { recursive: true })) {
      if (!name.endsWith('.jsonl') || this.seen.has(name)) continue
      const stream = createReadStream(join(directory, name))
      const lines = createInterface({ input: stream, crlfDelay: Infinity })
      try {
        for await (const line of lines) {
          const meta = JSON.parse(line)
          if (meta.type === 'session_meta') {
            const p = meta.payload, spawn = p.source?.subagent?.thread_spawn
            const file = join(directory, name)
            if (p.id === this.root && this.rootFile && await realpath(file) !== await realpath(this.rootFile)) { this.seen.add(name); break }
            const prior = this.known.get(p.id)
            if (this.ambiguous.has(p.id) || (prior && prior.file !== file && p.id !== this.root)) {
              this.ambiguous.add(p.id); this.known.delete(p.id); this.seen.add(name); break
            }
            this.known.set(p.id, { thread: p.id, file: join(directory, name), cwd: p.cwd,
              parent: spawn?.parent_thread_id, path: spawn?.agent_path })
            this.seen.add(name)
          }
          break
        }
      } catch (error) {
        // A new log can be observed before its first JSON record is complete.
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      } finally { lines.close(); stream.destroy() }
    }
  }
  family(): View[] {
    const result = new Set([this.root])
    for (;;) {
      const size = result.size
      for (const v of this.known.values()) if (v.parent && result.has(v.parent)) result.add(v.thread)
      if (size === result.size) break
    }
    return [...this.known.values()].filter(v => result.has(v.thread))
  }
  selected(screen: ViewScreen, identity: 'first' | 'whole' | 'none' = 'whole'): View | undefined {
    if (!screen.visible || screen.command !== 'codex') return
    const composer = plain(screen.lines[screen.y] ?? '')
    if (!composer.startsWith('› ')) return
    const footer = screen.lines.slice(screen.y + 1, screen.y + 4).map(plain).filter(l => l.trim()).join('\n').trim()
    const family = this.family()
    if (identity !== 'none') {
      const id = footerThread(screen, identity === 'first')
      if (footerCandidates(screen).length || footerFields(screen)?.some(field => field.includes('…'))) {
        return id ? family.find(view => view.thread === id) : undefined
      }
    }
    const paths = [...footer.matchAll(/`([^`]+)`/g)].map(m => m[1])
    if (paths.length) {
      const matched = family.filter(v => v.path && paths.includes(v.path))
      return matched.length === 1 ? matched[0] : undefined
    }
    if (/^Main \[default\](?: ·|$)/.test(footer)) return this.known.get(this.root)
    // Parent-owned child views use the read-only placeholder. The writable
    // primary may lack a Main label (including before tracked children load).
    // /new and /resume still require a fresh !vargus on binding.
    if (composer === '› Ask Codex to do anything') return this.known.get(this.root)
  }
}

// Native fields have no type tags. A clipped row can leave a UUID-valued branch
// visible after the real tail ID disappears. Only a known first-item layout may
// use its prefix; other layouts need a complete row with one UUID field.
function footerFields(screen: ViewScreen): string[] | undefined {
  if (!codexComposer(screen, '')) return
  const footer = screen.lines.slice(screen.y + 1, screen.y + 4).map(plain).filter(line => line.trim())
  return footer[0]?.split(' · ').map(item => item.trim())
}
const isId = (item: string) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(item)

// A hint can justify reading the configuration, never activating or changing a view.
export function footerCandidates(screen: ViewScreen): string[] {
  return footerFields(screen)?.filter(isId) ?? []
}
export function footerThread(screen: ViewScreen, firstItem = false): string | undefined {
  const fields = footerFields(screen)
  if (!fields) return
  if (firstItem) return fields[0] && isId(fields[0]) ? fields[0] : undefined
  if (fields.some(field => field.includes('…'))) return
  const ids = fields.filter(isId)
  return ids.length === 1 ? ids[0] : undefined
}
