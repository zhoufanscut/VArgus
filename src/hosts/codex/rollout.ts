// Read-only adapter for official Codex JSONL history (0.167.0).
// Hooks document this format as unstable; keep fixtures and live checks current.
import { open, readdir, realpath } from 'node:fs/promises'
import { join, relative, isAbsolute, sep } from 'node:path'
import { codexRead } from './read.ts'
import { CodexCollector } from './collect.ts'
import type { ModelDefault } from './model-defaults.ts'
import { SkillLoads } from './skills.ts'
import type { Usage } from './protocol.ts'

type RecordLine = { type: string; timestamp?: string; ordinal?: number; payload: any }
const MODEL_ITEMS = new Set(['Reasoning', 'AgentMessage', 'Plan'])
const CLIENT_TOOL_CALLS = new Set(['function_call', 'custom_tool_call', 'local_shell_call'])
const CLIENT_TOOL_OUTPUTS = new Set(['function_call_output', 'custom_tool_call_output', 'local_shell_call_output'])
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
  // Codex's store chooses the current path, including opaque/session-suffixed
  // names. A single filename is a compatibility fallback if that read fails.
  let result: any
  try { result = await codexRead('thread/read', { threadId: thread, includeTurns: false }, process.cwd(), home) }
  catch (error) {
    const directory = join(home, 'sessions'), files = await readdir(directory, { recursive: true })
    const escaped = thread.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp('-' + escaped + '(?:_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})?\\.jsonl$')
    const found = files.filter(file => pattern.test(file))
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
  private modelOutputPending = false
  private sawUsageRecordForStep = false
  private genStartMs: number | undefined
  private genEndMs: number | undefined
  private pendingFallbackDurationMs: number | undefined
  private decoder = new TextDecoder()
  private skills = new SkillLoads()
  private countersAttributed = true
  private historyStart: number | undefined
  private historyError: string | undefined
  private file: string
  private thread: string
  private modelProvider: string | undefined
  private modelDefault: ModelDefault | undefined
  constructor(file: string, thread: string, cwd: string, home: string, modelDefault?: ModelDefault) {
    this.file = file; this.thread = thread
    this.modelDefault = modelDefault
    this.collector = new CodexCollector(cwd, home)
  }

  private resetGenWindow(): void {
    this.genStartMs = undefined
    this.genEndMs = undefined
  }

  private clearGenTiming(): void {
    this.resetGenWindow()
    this.pendingFallbackDurationMs = undefined
  }

  private genDurationMs(): number | undefined {
    if (this.genStartMs === undefined || this.genEndMs === undefined) return undefined
    return this.genEndMs - this.genStartMs
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
      this.modelProvider = p.model_provider
      this.selected = true
    }
    if (!this.selected) return
    const v = this.collector.snapshot()!
    if (record.type === 'response_item') {
      // Assistant text uses type:"message", role:"assistant"; type:"agent_message"
      // is an incoming inter-agent input message, not model output.
      if (p.role === 'assistant' || p.type === 'reasoning' || p.type?.endsWith('_call')) {
        this.modelOutputPending = true
        this.sawUsageRecordForStep = false
        this.pendingFallbackDurationMs = undefined
      }
      // If a reasoning/text item already stamped the step's stream start, a
      // trailing client tool call extends the decode span to its completion.
      if (CLIENT_TOOL_CALLS.has(p.type) && this.genStartMs !== undefined && typeof record.timestamp === 'string') {
        const ts = Date.parse(record.timestamp)
        if (Number.isFinite(ts) && (this.genEndMs === undefined || ts > this.genEndMs)) this.genEndMs = ts
      } else if (CLIENT_TOOL_OUTPUTS.has(p.type)) {
        // Preserve the completed step's span until its token_count arrives
        // (Codex writes function_call_output before token_count), while still
        // closing the live window so the next step never merges across tool time.
        if (!this.sawUsageRecordForStep) {
          const duration = this.genDurationMs()
          if (duration !== undefined) this.pendingFallbackDurationMs = duration
        }
        this.resetGenWindow()
      }
    }
    // Codex can finish a response without usage and re-emit the old token_count.
    // A quota-only refresh (info: null) has no usage snapshot and leaves any
    // in-flight response window and existing readings intact.
    let pendingRateWithoutRecord = false
    if (this.modelOutputPending && record.type === 'event_msg'
      && ((p.type === 'token_count' && p.info != null) || p.type === 'task_complete')) {
      v.session.cacheHitPercent = undefined
      pendingRateWithoutRecord = !this.sawUsageRecordForStep
      this.modelOutputPending = false
      this.sawUsageRecordForStep = false
    }
    if (record.type === 'token_usage_record') {
      if (p.thread_id && p.thread_id !== this.thread) return
      const out = p.usage?.output_tokens
      if (typeof out === 'number' && Number.isFinite(out) && out > 0) {
        this.sawUsageRecordForStep = true
        const duration = this.genDurationMs()
        if (duration !== undefined) this.collector.recordResponseRate(out, duration)
      }
      this.clearGenTiming()
    } else if (record.type === 'event_msg' && p.type === 'task_started') {
      this.modelOutputPending = false
      this.sawUsageRecordForStep = false
      this.clearGenTiming()
      this.skills.start(p.turn_id)
    } else if (record.type === 'event_msg' && p.type === 'task_complete') {
      if (pendingRateWithoutRecord) v.session.tokensPerSecond = undefined
      this.clearGenTiming()
    } else if (record.type === 'response_item' && p.type === 'message') {
      if (this.countersAttributed) {
        this.skills.message(p)
        v.session.counts.skills = this.skills.count
      }
    } else if (record.type === 'turn_context' || (record.type === 'event_msg' && p.type === 'thread_settings_applied')) {
      if (p.thread_id && p.thread_id !== this.thread) return
      const settings = record.type === 'turn_context' ? p : p.thread_settings
      if (v.session.model !== undefined && settings.model !== v.session.model) {
        v.session.tokensPerSecond = undefined
      }
      if (record.type === 'event_msg') {
        const nextFast = settings.service_tier === 'priority' || settings.service_tier === 'fast'
        if (v.session.fast !== undefined ? nextFast !== v.session.fast : nextFast) {
          v.session.tokensPerSecond = undefined
        }
        v.session.fast = nextFast
        if (typeof settings.model_provider_id === 'string') this.modelProvider = settings.model_provider_id
      } else if (settings.model !== v.session.model) {
        // turn_context has no tier: keep it for the same model, clear on a switch.
        v.session.fast = undefined
      }
      v.core.cwd = settings.cwd
      v.session.model = settings.model
      v.session.effort = settings.effort ?? settings.reasoning_effort ?? undefined
    } else if (record.type === 'event_msg' && p.type === 'token_count') {
      const fallbackDuration = pendingRateWithoutRecord ? (this.genDurationMs() ?? this.pendingFallbackDurationMs) : undefined
      let freshOutput = false
      if (p.info) {
        freshOutput = this.collector.updateUsage({
          total: usage(p.info.total_token_usage),
          last: usage(p.info.last_token_usage),
          modelContextWindow: p.info.model_context_window,
        }, fallbackDuration).freshOutput
        this.pendingFallbackDurationMs = undefined
      }
      if (pendingRateWithoutRecord) {
        if (!freshOutput) v.session.tokensPerSecond = undefined
        this.clearGenTiming()
      }
      if (p.rate_limits) this.collector.updateLimits({ limitId: p.rate_limits.limit_id,
        normalModelSlug: p.rate_limits.normal_model_slug, primary: window(p.rate_limits.primary), secondary: window(p.rate_limits.secondary) })
    } else if (record.type === 'compacted' || (record.type === 'event_msg' && p.type === 'context_compacted')) {
      this.collector.compact()
      this.clearGenTiming()
    } else if (record.type === 'event_msg' && p.type === 'item_completed') {
      if (p.thread_id && p.thread_id !== this.thread) return
      const item = p.item
      if (MODEL_ITEMS.has(item.type)) {
        this.pendingFallbackDurationMs = undefined
        const start = p.started_at_ms
        const end = p.completed_at_ms
        if (typeof start === 'number' && Number.isFinite(start)
          && typeof end === 'number' && Number.isFinite(end) && end >= start) {
          this.genStartMs = this.genStartMs === undefined ? start : Math.min(this.genStartMs, start)
          this.genEndMs = this.genEndMs === undefined ? end : Math.max(this.genEndMs, end)
        }
      } else if (item.type === 'UserMessage' || item.type === 'ContextCompaction') {
        this.clearGenTiming()
      }
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
    const v = this.collector.snapshot()
    if (v) {
      const { session } = v
      session.defaultEffort = this.modelProvider === 'openai' && session.model
        ? await this.modelDefault?.(session.model, v.core.cwd) : undefined
    }
  }
}
