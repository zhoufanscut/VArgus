// Read-only adapter for official Codex JSONL history (0.167.0).
// Hooks document this format as unstable; keep fixtures and live checks current.
import { open, readdir, realpath } from 'node:fs/promises'
import { join, relative, isAbsolute, sep } from 'node:path'
import { codexRead } from './read.ts'
import { CodexCollector } from './collect.ts'
import { SkillLoads } from './skills.ts'
import type { Usage } from './protocol.ts'

type RecordLine = { type: string; timestamp?: string; ordinal?: number; payload: any }
const usage = (u: any): Usage => ({ inputTokens: u.input_tokens, cachedInputTokens: u.cached_input_tokens,
  outputTokens: u.output_tokens, totalTokens: u.total_tokens })
const window = (w: any) => w == null ? null : ({ usedPercent: w.used_percent,
  windowDurationMins: w.window_minutes, resetsAt: w.resets_at })

export async function savedTranscript(home: string, thread: string, file: string): Promise<string> {
  const directory = await realpath(join(home, 'sessions')), path = await realpath(file)
  const inside = relative(directory, path)
  if (isAbsolute(inside) || inside === '..' || inside.startsWith('..' + sep)) throw new Error("Codex transcript is outside this home's saved sessions.")
  const handle = await open(path)
  try {
    let text = '', offset = 0
    for (;;) {
      const buffer = Buffer.alloc(65536), { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      text += buffer.subarray(0, bytesRead).toString('utf8'); offset += bytesRead
      if (text.includes('\n') || !bytesRead) break
    }
    const meta = JSON.parse(text.split('\n')[0]!)
    if (meta.type !== 'session_meta' || meta.payload?.id !== thread) throw new Error('The saved transcript belongs to another Codex thread.')
    return path
  } finally { await handle.close() }
}

export async function findRollout(home: string, thread: string, reported?: string): Promise<string> {
  if (reported) return savedTranscript(home, thread, reported)
  const directory = join(home, 'sessions'), files = await readdir(directory, { recursive: true })
  const escaped = thread.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp('-' + escaped + '(?:_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})?\\.jsonl$')
  const found = files.filter(file => pattern.test(file))
  // Codex's store chooses the current path, including opaque/session-suffixed
  // names. A single filename is a compatibility fallback if that read fails.
  let result: any
  try { result = await codexRead('thread/read', { threadId: thread, includeTurns: false }, process.cwd(), home) }
  catch (error) {
    if (found.length !== 1) throw error
    return savedTranscript(home, thread, join(directory, found[0]!))
  }
  if (result?.thread?.id !== thread || result.thread.ephemeral || typeof result.thread.path !== 'string') {
    throw new Error(`Cannot resolve a current saved Codex transcript for thread ${thread}. Ephemeral chats are not supported.`)
  }
  return savedTranscript(home, thread, result.thread.path)
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
  private file: string
  private thread: string
  constructor(file: string, thread: string, cwd: string, home: string) {
    this.file = file; this.thread = thread
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
      this.collector.start(p.cwd, Date.parse(p.timestamp ?? record.timestamp!) / 1000)
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
      if (p.info) this.collector.updateUsage({ total: usage(p.info.total_token_usage),
        last: usage(p.info.last_token_usage), modelContextWindow: p.info.model_context_window })
      if (p.rate_limits) this.collector.updateLimits({ limitId: p.rate_limits.limit_id,
        normalModelSlug: p.rate_limits.normal_model_slug, primary: window(p.rate_limits.primary), secondary: window(p.rate_limits.secondary) })
    } else if (record.type === 'compacted' || (record.type === 'event_msg' && p.type === 'context_compacted')) {
      this.collector.compact()
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
      if (this.countersAttributed && spawn) this.collector.completeItem({ id: item.id, type: 'subAgentActivity', kind: 'started' })
      const types: Record<string, string> = { CommandExecution: 'commandExecution', FileChange: 'fileChange',
        McpToolCall: 'mcpToolCall', DynamicToolCall: 'dynamicToolCall', WebSearch: 'webSearch',
        ImageGeneration: 'imageGeneration', ImageView: 'imageView', ContextCompaction: 'contextCompaction' }
      if (types[item.type]) this.collector.completeItem({ id: item.id, type: types[item.type]! })
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
