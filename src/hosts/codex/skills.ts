import { basename, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Codex 0.167.0 persists selected instruction blocks and best-effort parsed
// shell reads, not a complete skill-use event stream. Match the recorded host
// catalog; references, unknown shell commands and cached reuse add no loads.
export class SkillLoads {
  private known = new Set<string>()
  private seen = new Set<string>()
  private turn: string | undefined
  count = 0

  start(turn: string): void { this.turn = turn }

  private path(path: string, cwd?: string): string | undefined {
    if (path.startsWith('file://')) return fileURLToPath(path)
    if (path.includes('://')) return
    if (isAbsolute(path)) return resolve(path)
    if (cwd) return resolve(cwd.startsWith('file://') ? fileURLToPath(cwd) : cwd, path)
  }

  private load(path: string, turn = this.turn): void {
    if (!turn) return
    const key = JSON.stringify([turn, path])
    if (!this.seen.has(key)) { this.seen.add(key); this.count++ }
  }

  message(item: any, countLoads = true): void {
    const metadata = item.internal_chat_message_metadata_passthrough
    for (const [index, content] of (item.content ?? []).entries()) {
      const kind = metadata?.content_item_kinds?.[index], text = content.text
      if (typeof text !== 'string') continue
      if (item.role === 'developer' && ['host_skills.instructions', 'skills.catalog'].includes(kind)) {
        const roots = new Map<string, string>()
        for (const match of text.matchAll(/^- `(r\d+)` = `([^`]+)`$/gm)) roots.set(match[1]!, match[2]!)
        const known = new Set<string>()
        for (const match of text.matchAll(/^[-] .+ \(file: (.+)\)$/gm)) {
          let path = match[1]!
          const alias = /^(r\d+)\/(.+)$/.exec(path)
          if (alias && roots.has(alias[1]!)) path = roots.get(alias[1]!)! + '/' + alias[2]!
          const absolute = this.path(path)
          if (absolute) known.add(absolute)
        }
        this.known = known
      } else if (countLoads && item.role === 'user' && kind === 'skills.selected_skill_instructions') {
        const match = /^<skill>\s*<name>[^\n]*<\/name>\s*<path>([^\n]+)<\/path>/.exec(text)
        const path = match && this.path(match[1]!)
        if (path) { this.known.add(path); this.load(path, metadata?.turn_id ?? this.turn) }
      }
    }
  }

  command(item: any, turn = this.turn): void {
    if (item.exit_code !== 0 || item.status !== 'completed') return
    for (const command of item.parsed_cmd ?? []) {
      if (command.type !== 'read' || typeof command.path !== 'string') continue
      const path = this.path(command.path, item.cwd)
      if (path && basename(path) === 'SKILL.md' && this.known.has(path)) this.load(path, turn)
    }
  }
}
