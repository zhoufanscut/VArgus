// Read-only adapter for official Codex JSONL history (0.167.0).
// Hooks document this format as unstable; keep fixtures and live checks current.
import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { CodexCollector } from './collect'
import type { Usage } from './protocol'

type RecordLine = { type: string; timestamp?: string; payload: any }
const usage = (u: any): Usage => ({ inputTokens: u.input_tokens, cachedInputTokens: u.cached_input_tokens,
  outputTokens: u.output_tokens, totalTokens: u.total_tokens })
const window = (w: any) => w == null ? null : ({ usedPercent: w.used_percent,
  windowDurationMins: w.window_minutes, resetsAt: w.resets_at })

export async function findRollout(home: string, thread: string): Promise<string> {
  const directory = join(home, 'sessions')
  const files = await readdir(directory, { recursive: true })
  const found = files.filter(f => f.endsWith(`-${thread}.jsonl`))
  if (found.length !== 1) throw new Error(`Cannot find one saved Codex transcript for thread ${thread}. Ephemeral chats are not supported.`)
  return join(directory, found[0]!)
}

export class RolloutReader {
  readonly collector: CodexCollector
  private offset = 0
  private pending = ''
  private selected = false
  private decoder = new TextDecoder()
  constructor(private file: string, private thread: string, cwd: string, home: string) {
    this.collector = new CodexCollector(cwd, home)
  }

  observe(record: RecordLine): void {
    const p = record.payload
    if (record.type === 'session_meta') {
      if (p.id !== this.thread) throw new Error('The transcript belongs to another Codex thread.')
      this.collector.selectThread({ id: p.id, cwd: p.cwd,
        createdAt: Date.parse(p.timestamp ?? record.timestamp!) / 1000 })
      this.selected = true
    }
    if (!this.selected) return
    const v = this.collector.snapshot()!
    if (record.type === 'turn_context' || (record.type === 'event_msg' && p.type === 'thread_settings_applied')) {
      if (p.thread_id && p.thread_id !== this.thread) return
      const settings = record.type === 'turn_context' ? p : p.thread_settings
      v.core.cwd = settings.cwd
      v.session.model = settings.model
      v.session.effort = settings.effort ?? settings.reasoning_effort ?? undefined
    } else if (record.type === 'event_msg' && p.type === 'token_count') {
      if (p.info) this.collector.fromServer({ method: 'thread/tokenUsage/updated', params: {
        threadId: this.thread, tokenUsage: { total: usage(p.info.total_token_usage),
          last: usage(p.info.last_token_usage), modelContextWindow: p.info.model_context_window },
      } })
      if (p.rate_limits) this.collector.fromServer({ method: 'account/rateLimits/updated', params: {
        rateLimits: { limitId: p.rate_limits.limit_id, primary: window(p.rate_limits.primary),
          secondary: window(p.rate_limits.secondary) },
      } })
    } else if (record.type === 'compacted' || (record.type === 'event_msg' && p.type === 'context_compacted')) {
      v.session.contextPercent = undefined
      v.session.contextTokens = undefined
    } else if (record.type === 'event_msg' && p.type === 'item_completed') {
      if (p.thread_id && p.thread_id !== this.thread) return
      const item = p.item
      if (item.source === 'user_shell') return
      const types: Record<string, string> = { CommandExecution: 'commandExecution', FileChange: 'fileChange',
        McpToolCall: 'mcpToolCall', DynamicToolCall: 'dynamicToolCall', WebSearch: 'webSearch',
        ImageGeneration: 'imageGeneration', ImageView: 'imageView', ContextCompaction: 'contextCompaction' }
      if (types[item.type]) this.collector.fromServer({ method: 'item/started', params: {
        threadId: this.thread, item: { id: item.id, type: types[item.type] },
      } })
    }
  }

  async poll(): Promise<void> {
    const file = await open(this.file, 'r')
    try {
      if ((await file.stat()).size < this.offset) throw new Error('The Codex transcript was replaced; turn VArgus off and on again.')
      const buffer = Buffer.alloc(64 * 1024)
      for (;;) {
        const { bytesRead } = await file.read(buffer, 0, buffer.length, this.offset)
        if (!bytesRead) break
        this.offset += bytesRead
        this.pending += this.decoder.decode(buffer.subarray(0, bytesRead), { stream: true })
        let end: number
        while ((end = this.pending.indexOf('\n')) >= 0) {
          const line = this.pending.slice(0, end)
          this.pending = this.pending.slice(end + 1)
          if (line) this.observe(JSON.parse(line))
        }
      }
    } finally { await file.close() }
  }
}
