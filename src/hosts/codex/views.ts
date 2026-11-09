import { codexComposer } from './footer.ts'
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
  private home: string
  readonly root: string
  private rootFile: string | undefined
  constructor(home: string, root: string, rootFile?: string) {
    this.home = home; this.root = root; this.rootFile = rootFile
  }
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
function draftFrame(screen: ViewScreen): { start: number; footer: string[] } | undefined {
  if (screen.x < 2) return
  let end = screen.lines.length - 1
  while (end > screen.y && !plain(screen.lines[end]!).trim()) end--
  const hint = plain(screen.lines[end] ?? '').trim(), shell = /\bShell mode$/.test(hint)
  if (end <= screen.y || (!shell && !/\b\d+% context left$/.test(hint))) return
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
  if (plain(screen.lines[start]!).startsWith('! ') !== shell) return
  for (let i = start + 1; i < footer - 1; i++) {
    const line = plain(screen.lines[i]!)
    if (line.trim() && !line.startsWith('  ')) return
  }
  return { start, footer: screen.lines.slice(footer, end + 1).map(plain) }
}

// An unlabelled editable draft can belong to any view. It permits showing a
// historical snapshot, never assigning current readings to the root.
export function hiddenDraft(screen: ViewScreen): boolean {
  if (!screen.visible || screen.command !== 'codex' || codexComposer(screen, '')) return false
  const draft = draftFrame(screen)
  if (!draft) return false
  const footer = draft.footer.join('\n')
  return !/[`…]/.test(footer) && !/^\s*Main \[default\]/m.test(footer)
    && !draft.footer.some(line => line.split(' · ').some(field => isId(field.trim())))
}

// Both saved-log and transport catalogs use the same versioned UI recognition.
export function selectedView<T extends { thread: string; path?: string }>(screen: ViewScreen,
  family: T[], root: string, identity: 'first' | 'whole' | 'none' = 'whole'): T | undefined {
    if (!screen.visible || screen.command !== 'codex') return
    const draft = codexComposer(screen, '') ? undefined : draftFrame(screen)
    const composer = plain(screen.lines[draft?.start ?? screen.y] ?? '')
    if (!composer.startsWith('› ') && !(draft && composer.startsWith('! '))) return
    const rows = draft?.footer ?? screen.lines.slice(screen.y + 1, screen.y + 4).map(plain).filter(l => l.trim())
    const footer = rows.join('\n').trim()
    if (identity !== 'none') {
      const fields = draft ? rows[0]?.split(' · ').map(item => item.trim()) : footerFields(screen)
      const id = threadField(fields, identity === 'first')
      if (fields?.some(field => isId(field) || field.includes('…'))) {
        return id ? family.find(view => view.thread === id) : undefined
      }
    }
    const paths = [...footer.matchAll(/`([^`]+)`/g)].map(m => m[1])
    if (paths.length) {
      const matched = family.filter(v => v.path && paths.includes(v.path))
      return matched.length === 1 ? matched[0] : undefined
    }
    if (/^Main \[default\](?: ·|$)/.test(footer)) return family.find(view => view.thread === root)
    // Empty parent-owned children use a dim placeholder but allow editable
    // drafts. Only the empty primary fallback can use the activation root.
    // Standalone /new and /resume still require a fresh !vargus on binding.
    if (codexComposer(screen, '') && composer === '› Ask Codex to do anything') return family.find(view => view.thread === root)
}
