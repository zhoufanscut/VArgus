import { codexRead } from './read.ts'

export type FooterSelection = string[] | null

// Codex names the picker item thread-id and retains session-id as an alias.
export function footerIdentity(selection: FooterSelection | undefined): 'none' | 'first' | 'whole' {
  const index = selection?.findIndex(item => item === 'thread-id' || item === 'session-id') ?? -1
  return index < 0 ? 'none' : index === 0 ? 'first' : 'whole'
}

// Codex c2bd770ca7, chatwidget.rs DEFAULT_STATUS_LINE_ITEMS; live-tested on 0.167.0.
const DEFAULT_ITEMS = ['model-with-reasoning', 'current-dir', 'thread-name']
export const clearFooter = '/statusline --clear'
export function restoreFooter(items: FooterSelection): string {
  const selection = items ?? DEFAULT_ITEMS
  if (!selection.every(item => /^[a-z][a-z0-9-]*$/.test(item))) throw new Error('Saved Codex footer contains unsupported item names; restore it through /statusline.')
  return selection.length ? '/statusline ' + selection.join(' ') : clearFooter
}

// Read effective saved layers through Codex's own parser. No config write, thread
// creation, model request, or dependence on a second TOML parser.
export async function savedFooter(cwd: string): Promise<FooterSelection> {
  const result = await codexRead('config/read', { includeLayers: false, cwd }, cwd)
  const items = result?.config?.tui?.status_line ?? null
  if (items !== null && (!Array.isArray(items) || !items.every((item: unknown) => typeof item === 'string'))) throw new Error('Codex returned an unsupported footer configuration.')
  return items
}

// Warm each workspace before inspecting the pane. A first child visit must not
// wait for config/read while its initially visible agent label can be clipped.
export class FooterSettings {
  private values = new Map<string, FooterSelection>()
  private errors = new Map<string, Error>()
  private load: typeof savedFooter
  constructor(load = savedFooter) { this.load = load }
  reset(): void { this.values.clear(); this.errors.clear() }
  async preload(cwds: Iterable<string>): Promise<void> {
    for (const cwd of new Set(cwds)) {
      if (this.values.has(cwd)) continue
      try {
        const selection = await this.load(cwd)
        restoreFooter(selection)
        this.values.set(cwd, selection)
        this.errors.delete(cwd)
      } catch (error) { this.errors.set(cwd, error as Error) }
    }
  }
  get(cwd: string): FooterSelection {
    if (!this.values.has(cwd)) throw this.errors.get(cwd) ?? new Error('Codex footer settings have not been preloaded for this workspace.')
    return this.values.get(cwd)!
  }
}

const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, '')
// Deliberately version-specific and fail-closed. Cursor position plus dimmed
// placeholder distinguishes an empty composer from a draft containing its words.
export function codexComposer(screen: { lines: string[]; x: number; y: number; visible: boolean; command: string }, text: string): boolean {
  if (!screen.visible || screen.command !== 'codex' || screen.x !== 2 + text.length) return false
  const line = screen.lines[screen.y] ?? ''
  const content = plain(line)
  if (text) return content.slice(2) === text && content.length === text.length + 2
  return ['Ask Codex to do anything', 'Viewing sub-agent — direct input is disabled'].includes(content.slice(2))
    && /\x1b\[(?:[0-9]+;)*2m(?:Ask Codex to do anything|Viewing sub-agent — direct input is disabled)/.test(line)
    && !screen.lines.slice(Math.max(0, screen.y - 3), screen.y).some(line => /Image #\d|\[Pasted Content/.test(plain(line)))
}

export function footerCommandError(lines: string[]): boolean {
  return lines.some(line => /Unknown status-line item|Cannot combine --clear|Unrecognized.*statusline/.test(plain(line)))
}
