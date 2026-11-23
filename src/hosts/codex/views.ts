import { codexComposer } from './footer.ts'
import { isCompressedRollout, isRolloutFile, readFirstRolloutLine, rolloutStem } from './rollout.ts'
// Codex 0.167.0's contextual footer exposes the selected agent path even when
// configurable items are cleared. This is a versioned UI observation, not an API.
import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

export type View = { thread: string; file: string; parent?: string; path?: string; cwd: string }
export type ViewScreen = { lines: string[]; x: number; y: number; visible: boolean; command: string }
export const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, '')

export class Views {
  readonly known = new Map<string, View>()
  private seen = new Set<string>()
  private failedCompressed = new Map<string, { ino: number; size: number; mtimeMs: number }>()
  private ambiguous = new Set<string>()
  private home: string
  readonly root: string
  private rootFile: string | undefined
  constructor(home: string, root: string, rootFile?: string) {
    this.home = home; this.root = root; this.rootFile = rootFile
  }
  async refresh(includeCompressed = true): Promise<void> {
    const directory = join(this.home, 'sessions')
    const entries = await readdir(directory, { recursive: true })
    const present = new Set(entries)
    for (const name of this.seen) if (!present.has(name)) this.seen.delete(name)
    for (const name of this.failedCompressed.keys()) if (!present.has(name)) this.failedCompressed.delete(name)
    let rootRealStem: string | undefined
    if (this.rootFile) {
      const altRoot = isCompressedRollout(this.rootFile) ? rolloutStem(this.rootFile) : this.rootFile + '.zst'
      try { rootRealStem = rolloutStem(await realpath(this.rootFile)) }
      catch {
        try { rootRealStem = rolloutStem(await realpath(altRoot)) }
        catch { rootRealStem = rolloutStem(resolve(this.rootFile)) }
      }
    }
    const realDir = await realpath(directory).catch(() => resolve(directory))
    const rootBase = rootRealStem ? basename(rootRealStem) : undefined
    for (const name of entries) {
      if (!isRolloutFile(name) || this.seen.has(name)) continue
      const compressed = isCompressedRollout(name)
      const file = join(directory, name)
      if (compressed) {
        if (!includeCompressed) {
          const isRoot = rootRealStem !== undefined && (
            rolloutStem(join(realDir, name)) === rootRealStem
            || (basename(rolloutStem(name)) === rootBase && rolloutStem(await realpath(file).catch(() => resolve(file))) === rootRealStem)
          )
          if (!isRoot) continue
        }
        // Prefer the plain file while both `<stem>.jsonl` and `<stem>.jsonl.zst` coexist;
        // leave the compressed sibling unseen so it is picked up once the plain file disappears.
        if (present.has(rolloutStem(name))) continue
      }
      let compressedStat: { ino: number; size: number; mtimeMs: number } | undefined
      if (compressed) {
        try {
          const info = await stat(file)
          compressedStat = { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs }
        } catch {
          continue
        }
        const failed = this.failedCompressed.get(name)
        if (failed && failed.ino === compressedStat.ino && failed.size === compressedStat.size && failed.mtimeMs === compressedStat.mtimeMs) continue
      }
      try {
        const line = await readFirstRolloutLine(file)
        if (!line) {
          if (compressed && compressedStat) this.failedCompressed.set(name, compressedStat)
          continue
        }
        const meta = JSON.parse(line)
        if (meta && typeof meta === 'object' && meta.type === 'session_meta'
          && meta.payload && typeof meta.payload === 'object' && typeof meta.payload.id === 'string') {
          const p = meta.payload, spawn = p.source?.subagent?.thread_spawn
          if (p.id === this.root && rootRealStem !== undefined && rolloutStem(await realpath(file)) !== rootRealStem) {
            this.seen.add(name); continue
          }
          const prior = this.known.get(p.id)
          if (this.ambiguous.has(p.id) || (prior && rolloutStem(prior.file) !== rolloutStem(file) && p.id !== this.root)) {
            this.ambiguous.add(p.id); this.known.delete(p.id); this.seen.add(name); continue
          }
          this.known.set(p.id, { thread: p.id, file, cwd: p.cwd,
            parent: spawn?.parent_thread_id, path: spawn?.agent_path })
          this.seen.add(name)
          // Clear any previously seen compressed sibling so a later removal of the plain file re-adopts `.jsonl.zst`.
          if (!compressed) this.seen.delete(name + '.zst')
          this.failedCompressed.delete(name)
        } else {
          this.seen.add(name)
          this.failedCompressed.delete(name)
        }
      } catch (error) {
        if (compressed) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && compressedStat) {
            this.failedCompressed.set(name, compressedStat)
          }
          continue
        }
        // A new log can be observed before its first JSON record is complete.
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  private reachable(threadId: string): Set<string> {
    const visited = new Set([threadId])
    for (;;) {
      const size = visited.size
      for (const v of this.known.values()) if (v.parent && visited.has(v.parent)) visited.add(v.thread)
      if (size === visited.size) break
    }
    return visited
  }
  descendants(threadId: string): View[] {
    const visited = this.reachable(threadId)
    visited.delete(threadId)
    return [...this.known.values()].filter(v => visited.has(v.thread))
  }
  family(): View[] {
    const visited = this.reachable(this.root)
    return [...this.known.values()].filter(v => visited.has(v.thread))
  }
  restoreCandidates(threads: Iterable<string>): View[] {
    const pending = new Set(threads), family = new Set(this.family().map(view => view.thread))
    // Agent paths are family-local and can be reused by another root. Such
    // backups may be selected by full ID, but never by a foreign path label.
    return [...this.known.values()].filter(view => pending.has(view.thread))
      .map(view => family.has(view.thread) ? view : { ...view, path: undefined })
  }
  selected(screen: ViewScreen, identity: 'first' | 'whole' | 'none' = 'whole'): View | undefined {
    return selectedView(screen, this.family(), this.root, identity)
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
  return threadField(footerFields(screen), firstItem)
}
function threadField(fields: string[] | undefined, firstItem: boolean): string | undefined {
  if (!fields) return
  if (firstItem) return fields[0] && isId(fields[0]) ? fields[0] : undefined
  if (fields.some(field => field.includes('…'))) return
  const ids = fields.filter(isId)
  return ids.length === 1 ? ids[0] : undefined
}

// The live editable arrow is bold; submitted prompts are dimmed and popup
// selections can be reversed. Ignore colour parameters when reading modifiers.
function livePrompt(line: string): boolean {
  const prefix = line.match(/^((?:\x1b\[[0-9;]*m)+)[›!](?:\x1b\[[0-9;]*m)* /)?.[1]
  if (!prefix) return false
  const codes = prefix.replace(/(?:38|48);(?:5;\d+|2;\d+;\d+;\d+)/g, '').match(/\d+/g) ?? []
  const modifiers = new Set<number>()
  for (const code of codes.map(Number)) {
    if (code === 0) modifiers.clear()
    else if (code === 22) { modifiers.delete(1); modifiers.delete(2) }
    else if (code === 27) modifiers.delete(7)
    else modifiers.add(code)
  }
  return modifiers.has(1) && !modifiers.has(2) && !modifiers.has(7)
}

// Display-only recognition of 0.167.0's editable draft. The native context/shell hint
// anchors the footer below the textarea; cursor-relative slices can read draft
// continuation lines as agent labels or IDs. Footer delivery keeps its separate
// strict empty-composer guard, as do the exported startup ID readers above.
function withoutWarning(line: string): string {
  return line.replace(/\s+(?:·\s+)?⚠ \d+(?: warnings? · .+ to view| · .+)?$/, '')
}

function emptySideComposer(screen: ViewScreen): boolean {
  const line = screen.lines[screen.y] ?? ''
  return screen.x === 2 && livePrompt(line) && plain(line) === '› Ask a follow-up question'
    && /\x1b\[(?:[0-9]+;)*2mAsk a follow-up question/.test(line)
}

function draftFrame(screen: ViewScreen): { start: number; footer: string[]; side: boolean } | undefined {
  if (screen.x < 2) return
  let end = screen.lines.length - 1
  while (end > screen.y && !plain(screen.lines[end]!).trim()) end--
  // Codex can share this hint row with a full, compact or count-only warning notice.
  const hint = withoutWarning(plain(screen.lines[end] ?? '').trim())
  const shell = /\bShell mode$/.test(hint)
  const side = /(?:^| · | {2,})Side from (?:main|parent) thread\b.* · [^·]+ to (?:close|archive)$/.test(hint)
  if (end <= screen.y || (!side && !shell && !/\b\d+% context left$/.test(hint))) return
  let footer = end
  while (footer > screen.y + 1 && plain(screen.lines[footer - 1]!).trim()) footer--
  if (footer <= screen.y + 1 || plain(screen.lines[footer - 1]!).trim()) return
  let start = screen.y
  while (start >= 0 && !livePrompt(screen.lines[start] ?? '')) {
    const line = plain(screen.lines[start] ?? '')
    if (line.trim() && !line.startsWith('  ')) return
    start--
  }
  if (start < 0) return
  // Parent-owned children retain a bold arrow but have a dim placeholder, which
  // can be clipped before the existing empty-composer guard recognizes it.
  if (/\x1b\[(?:[0-9]+;)*2m(?:Ask Codex|Viewing sub-agent)/.test(screen.lines[start]!)) return
  if (!side && plain(screen.lines[start]!).startsWith('! ') !== shell) return
  for (let i = start + 1; i < footer - 1; i++) {
    const line = plain(screen.lines[i]!)
    if (line.trim() && !line.startsWith('  ')) return
  }
  return { start, footer: screen.lines.slice(footer, end + 1).map(plain), side }
}

// An unidentified draft or a side chat can show the last confirmed snapshot.
export function readingHold(screen: ViewScreen): 'draft' | 'side' | undefined {
  if (!screen.visible || screen.command !== 'codex' || codexComposer(screen, '')) return
  if (emptySideComposer(screen)) return 'side'
  const draft = draftFrame(screen)
  if (!draft) return
  if (draft.side) return 'side'
  const footer = draft.footer.join('\n')
  if (!/[`…]/.test(footer) && !/^\s*Main \[default\]/m.test(footer)
    && !draft.footer.some(line => line.split(' · ').some(field => isId(field.trim())))) return 'draft'
}

// Resolve the displayed saved-log family through the versioned Codex UI.
export function selectedView<T extends { thread: string; path?: string }>(screen: ViewScreen,
  family: T[], root: string, identity: 'first' | 'whole' | 'none' = 'whole'): T | undefined {
    if (!screen.visible || screen.command !== 'codex' || emptySideComposer(screen)) return
    const empty = codexComposer(screen, '')
    const draft = empty ? undefined : draftFrame(screen)
    if (draft?.side) return
    const composer = plain(screen.lines[draft?.start ?? screen.y] ?? '')
    if (!composer.startsWith('› ') && !(draft && composer.startsWith('! '))) return
    const rows = draft?.footer ?? screen.lines.slice(screen.y + 1, screen.y + 4).map(plain).filter(l => l.trim())
    const footer = rows.map(row => withoutWarning(row.trim())).join('\n')
    if (identity !== 'none') {
      const fields = draft ? rows[0]?.split(' · ').map(item => item.trim()) : footerFields(screen)
      const id = threadField(fields, identity === 'first')
      if (fields?.some(field => isId(field) || field.includes('…'))) {
        return id ? family.find(view => view.thread === id) : undefined
      }
    }
    // The label can follow configurable items or be right-aligned beside the
    // native shortcuts after those items clear. Titles can contain backticks.
    const label = [...footer.matchAll(
      /(?:^| · | for (?:agents|shortcuts) +)(Main \[default\]|`([^`\n]+)`)(?= · [^·\n]* for agents\b|[ \t]*(?:(?:· )?\d+% context left)?$)/gm,
    )].at(-1)
    if (label?.[1] === 'Main [default]') return family.find(view => view.thread === root)
    if (label?.[2] && (footer.includes(' for agents') || composer.startsWith('› Viewing sub-agent') || draft)) {
      const matched = family.filter(v => v.path === label[2])
      return matched.length === 1 ? matched[0] : undefined
    }
    // Empty parent-owned children use a dim placeholder but allow editable
    // drafts. Only the empty primary fallback can use the activation root.
    // Standalone /new and /resume still require a fresh !vargus on binding.
    if (empty && composer === '› Ask Codex to do anything') return family.find(view => view.thread === root)
}
