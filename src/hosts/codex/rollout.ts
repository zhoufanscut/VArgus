// Read-only adapter for official Codex JSONL history (0.167.0).
// Hooks document this format as unstable; keep fixtures and live checks current.
import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { CodexCollector } from './collect'
import { SkillLoads } from './skills'
import type { Usage } from './protocol'

type RecordLine = { type: string; timestamp?: string; ordinal?: number; payload: any }
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
  private skills = new SkillLoads()
  private countersAttributed = true
  private historyStart: number | undefined
  private historyError: string | undefined
  constructor(private file: string, private thread: string, cwd: string, home: string) {
    this.collector = new CodexCollector(cwd, home)
  }

  observe(record: RecordLine): void {
    if (this.historyError) throw new Error(this.historyError)
    const p = record.payload
    if (this.selected && this.historyStart !== undefined) {
      if (!Number.isSafeInteger(record.ordinal) || record.ordinal! < 0) {
        this.historyError = 'The paginated Codex transcript is missing a valid ordinal; turn VArgus off and on again.'
        throw new Error(this.historyError)
      }
      if (record.ordinal! < this.historyStart) {
        // Inherited catalogs remain useful for recognizing the child's later reads.
        // Inherited injections, settings, usage and completed items are not activity.
        if (record.type === 'response_item' && p.type === 'message') this.skills.message(p, false)
        return
      }
    }
    if (record.type === 'session_meta') {
      if (p.id !== this.thread) {
        // A retry can advance past copied parent metadata. The existing reader
        // may then expose inherited records; do not count their agents/skills.
        this.countersAttributed = false
        const counts = this.collector.snapshot()?.session.counts
        if (counts) { counts.agents = 0; counts.skills = 0 }
        throw new Error('The transcript belongs to another Codex thread.')
      }
      if (!this.selected && p.history_mode === 'paginated'
        && Number.isSafeInteger(p.subagent_history_start_ordinal) && p.subagent_history_start_ordinal > 0) {
        this.historyStart = p.subagent_history_start_ordinal
      }
      this.collector.selectThread({ id: p.id, cwd: p.cwd,
        createdAt: Date.parse(p.timestamp ?? record.timestamp!) / 1000 })
      this.selected = true
    }
    if (!this.selected) return
    const v = this.collector.snapshot()!
    if (record.type === 'event_msg' && p.type === 'task_started') {
      this.skills.start(p.turn_id)
    } else if (record.type === 'response_item' && p.type === 'message') {
      if (this.countersAttributed) {
        this.skills.message(p)
        v.session.counts.skills = this.skills.count
      }
    } else if (record.type === 'turn_context' || (record.type === 'event_msg' && p.type === 'thread_settings_applied')) {
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
      if (this.countersAttributed && item.type === 'CommandExecution') {
        this.skills.command(item, p.turn_id)
        v.session.counts.skills = this.skills.count
      }
      // Spawn activity is separate from tool accounting: existing tool totals
      // retain their completed-visible-item contract.
      const spawn = item.type === 'SubAgentActivity' && item.kind === 'started'
        || item.type === 'CollabAgentToolCall' && item.tool === 'spawn_agent' && item.status === 'completed'
      if (this.countersAttributed && spawn) this.collector.fromServer({ method: 'item/started', params: {
        threadId: this.thread, item: { id: item.id, type: 'subAgentActivity', kind: 'started' },
      } })
      const types: Record<string, string> = { CommandExecution: 'commandExecution', FileChange: 'fileChange',
        McpToolCall: 'mcpToolCall', DynamicToolCall: 'dynamicToolCall', WebSearch: 'webSearch',
        ImageGeneration: 'imageGeneration', ImageView: 'imageView', ContextCompaction: 'contextCompaction' }
      if (types[item.type]) this.collector.fromServer({ method: 'item/started', params: {
        threadId: this.thread, item: { id: item.id, type: types[item.type] },
      } })
    }
  }

  async poll(): Promise<void> {
    if (this.historyError) throw new Error(this.historyError)
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
