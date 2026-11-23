// Read-only adapter for official Codex JSONL history (0.167.0).
// Hooks document this format as unstable; keep fixtures and live checks current.
import { open, readdir, realpath } from 'node:fs/promises'
import { join, relative, isAbsolute, sep } from 'node:path'
import { Readable } from 'node:stream'
import { createZstdDecompress } from 'node:zlib'
import { codexRead } from './read.ts'
import { CodexCollector } from './collect.ts'
import type { ModelDefault } from './model-defaults.ts'
import { SkillLoads } from './skills.ts'
import type { Usage } from './protocol.ts'

export const isCompressedRollout = (path: string): boolean => path.endsWith('.jsonl.zst')
export const isRolloutFile = (path: string): boolean => path.endsWith('.jsonl') || isCompressedRollout(path)
export const rolloutStem = (path: string): string => isCompressedRollout(path) ? path.slice(0, -4) : path

type ZstdFrameSpan = { kind: 'data' | 'skip'; start: number; end: number }

// Node 24's `node:zlib` zstd stream returns cleanly without error on premature EOF
// mid-frame or trailing non-zstd bytes, and stops after the first frame (dropping
// concatenated frames and failing on leading skippable frames). Parse RFC 8878
// frame/block/checksum spans directly on the open descriptor and stream each data
// frame span individually.
async function readZstdFrameSpan(
  handle: Awaited<ReturnType<typeof open>>,
  start: number,
  fileSize: number,
): Promise<ZstdFrameSpan | null> {
  let pos = start
  const hdr = Buffer.allocUnsafe(8)
  const readExact = async (len: number): Promise<boolean> => {
    if (pos + len > fileSize) return false
    const { bytesRead } = await handle.read(hdr, 0, len, pos)
    if (bytesRead !== len) return false
    pos += len
    return true
  }
  if (!(await readExact(4))) return null
  const magic = hdr.readUInt32LE(0)
  if (magic === 0xFD2FB528) {
    if (!(await readExact(1))) return null
    const fhd = hdr[0]!
    // RFC 8878 §3.1.1.1.1: bit 3 (0x08) is Reserved_bit (MUST fail); bit 4 (0x10) is Unused_bit.
    if ((fhd & 0x08) !== 0) return null
    const fcsFlag = (fhd >> 6) & 3
    const singleSegment = (fhd >> 5) & 1
    const checksumFlag = (fhd >> 2) & 1
    const dictFlag = fhd & 3
    const extraHeader = (singleSegment ? 0 : 1)
      + ([0, 1, 2, 4][dictFlag] ?? 0)
      + (fcsFlag === 0 ? (singleSegment ? 1 : 0) : ([0, 2, 4, 8][fcsFlag] ?? 0))
    if (pos + extraHeader > fileSize) return null
    pos += extraHeader
    let sawLast = false
    while (!sawLast) {
      if (!(await readExact(3))) return null
      const bh = hdr[0]! | (hdr[1]! << 8) | (hdr[2]! << 16)
      const last = (bh & 1) === 1
      const type = (bh >> 1) & 3
      const size = bh >>> 3
      if (type === 3) return null
      const payloadLen = type === 1 ? 1 : size
      if (pos + payloadLen > fileSize) return null
      pos += payloadLen
      sawLast = last
    }
    if (checksumFlag) {
      if (pos + 4 > fileSize) return null
      pos += 4
    }
    return { kind: 'data', start, end: pos }
  }
  if (((magic & 0xFFFFFFF0) >>> 0) === 0x184D2A50) {
    if (!(await readExact(4))) return null
    const skipSize = hdr.readUInt32LE(0)
    if (pos + skipSize > fileSize) return null
    pos += skipSize
    return { kind: 'skip', start, end: pos }
  }
  return null
}

async function validateZstdFrames(
  handle: Awaited<ReturnType<typeof open>>,
  fileSize: number,
): Promise<Array<{ start: number; end: number }> | null> {
  if (fileSize === 0) return []
  let pos = 0
  const dataFrames: Array<{ start: number; end: number }> = []
  while (pos < fileSize) {
    const frame = await readZstdFrameSpan(handle, pos, fileSize)
    if (!frame) return null
    if (frame.kind === 'data') dataFrames.push({ start: frame.start, end: frame.end })
    pos = frame.end
  }
  return dataFrames.length > 0 && pos === fileSize ? dataFrames : null
}

async function* readHandleSpan(
  handle: Awaited<ReturnType<typeof open>>,
  start: number,
  end: number,
): AsyncGenerator<Buffer> {
  let pos = start
  while (pos < end) {
    const toRead = Math.min(64 * 1024, end - pos)
    const buf = Buffer.allocUnsafe(toRead)
    const { bytesRead } = await handle.read(buf, 0, toRead, pos)
    if (bytesRead <= 0) throw new Error('The compressed Codex transcript could not be decompressed.')
    pos += bytesRead
    yield bytesRead === toRead ? buf : buf.subarray(0, bytesRead)
  }
}

export async function readFirstRolloutLine(path: string): Promise<string | undefined> {
  const handle = await open(path, 'r')
  try {
    if (!isCompressedRollout(path)) {
      const decoder = new TextDecoder()
      let text = '', offset = 0
      const buffer = Buffer.allocUnsafe(65536)
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
        if (!bytesRead) break
        offset += bytesRead
        text += decoder.decode(buffer.subarray(0, bytesRead), { stream: true })
        const nl = text.indexOf('\n')
        if (nl >= 0) return text.slice(0, nl).replace(/\r$/, '')
      }
      text += decoder.decode()
      const trimmed = text.replace(/\r$/, '')
      return trimmed || undefined
    }
    const { size } = await handle.stat()
    if (size === 0) return undefined
    const decoder = new TextDecoder()
    let text = '', pos = 0, sawDataFrame = false
    while (pos < size) {
      const frame = await readZstdFrameSpan(handle, pos, size)
      if (!frame) throw new Error('The compressed Codex transcript could not be decompressed.')
      pos = frame.end
      if (frame.kind === 'skip') continue
      sawDataFrame = true
      const source = Readable.from(readHandleSpan(handle, frame.start, frame.end))
      const zstd = createZstdDecompress()
      source.on('error', error => zstd.destroy(error))
      source.pipe(zstd)
      try {
        for await (const chunk of zstd) {
          text += decoder.decode(chunk as Buffer, { stream: true })
          const nl = text.indexOf('\n')
          if (nl >= 0) return text.slice(0, nl).replace(/\r$/, '')
        }
      } finally {
        source.on('error', () => {})
        zstd.on('error', () => {})
        source.unpipe(zstd)
        source.destroy()
        zstd.destroy()
      }
    }
    if (!sawDataFrame) throw new Error('The compressed Codex transcript could not be decompressed.')
    text += decoder.decode()
    const trimmed = text.replace(/\r$/, '')
    return trimmed || undefined
  } finally { await handle.close() }
}

type RecordLine = { type: string; timestamp?: string; ordinal?: number; payload: any }
const FOREIGN_THREAD_ERROR = 'The transcript belongs to another Codex thread.'
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
  const first = await readFirstRolloutLine(path)
  const meta = JSON.parse(first ?? '')
  if (meta.type !== 'session_meta' || meta.payload?.id !== thread) throw new Error('The saved transcript belongs to another Codex thread.')
  return path
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
    const pattern = new RegExp('-' + escaped + '(?:_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})?\\.jsonl(?:\\.zst)?$')
    const stems = new Map<string, string>()
    for (const file of files) {
      if (!pattern.test(file)) continue
      const stem = rolloutStem(file)
      if (!stems.has(stem) || !isCompressedRollout(file)) stems.set(stem, file)
    }
    const found = [...stems.values()]
    if (found.length !== 1) throw error
    return savedTranscript(home, thread, join(directory, found[0]!))
  }
  if (result?.thread?.id !== thread || result.thread.ephemeral || typeof result.thread.path !== 'string') {
    throw new Error(`Cannot resolve a current saved Codex transcript for thread ${thread}. Ephemeral chats are not supported.`)
  }
  try { return await savedTranscript(home, thread, result.thread.path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && result.thread.path.endsWith('.jsonl')) {
      return savedTranscript(home, thread, result.thread.path + '.zst')
    }
    throw error
  }
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
  private zstReplay: { ino: number; mtimeMs: number; size: number } | undefined
  readonly file: string
  private thread: string
  private modelProvider: string | undefined
  private modelDefault: ModelDefault | undefined
  constructor(file: string, thread: string, cwd: string, home: string, modelDefault?: ModelDefault) {
    this.file = file; this.thread = thread
    this.modelDefault = modelDefault
    this.collector = new CodexCollector(cwd, home)
  }

  get attributable(): boolean {
    return this.selected && this.countersAttributed && this.historyError === undefined
  }

  private failHistory(message: string): never {
    this.historyError = message
    this.pending = ''
    throw new Error(message)
  }

  private drainPending(): void {
    let end: number
    while ((end = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, end).trim()
      this.pending = this.pending.slice(end + 1)
      if (!line) continue
      let record: unknown
      try {
        record = JSON.parse(line)
      } catch {
        this.failHistory('The Codex transcript contains invalid JSON.')
      }
      this.observe(record as RecordLine)
    }
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
    if (this.historyError !== undefined) throw new Error(this.historyError)
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || typeof record.type !== 'string' || record.type === '') {
      this.failHistory('The Codex transcript contains an invalid record.')
    }
    try {
      this.observeRecord(record)
    } catch (error) {
      if (this.historyError === undefined && !(error instanceof Error && error.message === FOREIGN_THREAD_ERROR)) {
        this.failHistory('The Codex transcript contains an invalid record.')
      }
      throw error
    }
  }

  private observeRecord(record: RecordLine): void {
    const p = record.payload
    if (this.selected && this.historyStart !== undefined) {
      if (!Number.isSafeInteger(record.ordinal) || record.ordinal! < 0) {
        this.failHistory('The paginated Codex transcript is missing a valid ordinal; turn VArgus off and on again.')
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
        throw new Error(FOREIGN_THREAD_ERROR)
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

  private async pollCompressed(): Promise<void> {
    const file = await open(this.file, 'r')
    try {
      const info = await file.stat()
      if (this.zstReplay) {
        if (this.zstReplay.ino === info.ino && this.zstReplay.mtimeMs === info.mtimeMs && this.zstReplay.size === info.size) {
          this.drainPending()
          return
        }
        this.failHistory('The Codex transcript was replaced; turn VArgus off and on again.')
      }
      if (info.size === 0) return
      const frames = await validateZstdFrames(file, info.size)
      if (!frames) {
        this.failHistory('The compressed Codex transcript could not be decompressed.')
      }
      let decompressedBytes = 0
      let foreignError: Error | undefined
      const tryDrain = (flushTrailing = false): void => {
        if (foreignError) return
        try {
          this.drainPending()
          if (flushTrailing && this.pending.trim()) {
            this.pending += '\n'
            this.drainPending()
          }
        } catch (error) {
          if (error instanceof Error && error.message === FOREIGN_THREAD_ERROR) {
            foreignError = error
            return
          }
          throw error
        }
      }
      try {
        for (const frame of frames) {
          const source = Readable.from(readHandleSpan(file, frame.start, frame.end))
          const zstd = createZstdDecompress()
          source.on('error', error => zstd.destroy(error))
          source.pipe(zstd)
          try {
            for await (const chunk of zstd) {
              const buf = chunk as Buffer
              decompressedBytes += buf.length
              this.pending += this.decoder.decode(buf, { stream: true })
              tryDrain()
            }
          } finally {
            source.on('error', () => {})
            zstd.on('error', () => {})
            source.unpipe(zstd)
            source.destroy()
            zstd.destroy()
          }
        }
        this.pending += this.decoder.decode()
        tryDrain(true)
        if (foreignError && this.pending.trim() && !this.pending.endsWith('\n')) {
          this.pending += '\n'
        }
        if (decompressedBytes === 0) {
          this.failHistory('The compressed Codex transcript could not be decompressed.')
        }
        this.zstReplay = { ino: info.ino, mtimeMs: info.mtimeMs, size: info.size }
      } catch (error) {
        if (this.historyError !== undefined) throw error
        const code = String((error as NodeJS.ErrnoException | undefined)?.code ?? '')
        if (code.startsWith('ZSTD_') || decompressedBytes > 0) {
          this.failHistory('The compressed Codex transcript could not be decompressed.')
        }
        this.pending = ''
        this.decoder = new TextDecoder()
        throw error
      }
      if (foreignError) throw foreignError
    } finally { await file.close() }
  }

  async poll(resolveModelDefault = true): Promise<void> {
    if (this.historyError !== undefined) throw new Error(this.historyError)
    if (isCompressedRollout(this.file)) {
      await this.pollCompressed()
    } else {
      const file = await open(this.file, 'r')
      try {
        const { size } = await file.stat()
        if (size < this.offset) {
          this.failHistory('The Codex transcript was replaced; turn VArgus off and on again.')
        }
        this.drainPending()
        if (size > this.offset) {
          const buffer = Buffer.alloc(64 * 1024)
          for (;;) {
            const { bytesRead } = await file.read(buffer, 0, buffer.length, this.offset)
            if (!bytesRead) break
            this.offset += bytesRead
            this.pending += this.decoder.decode(buffer.subarray(0, bytesRead), { stream: true })
            this.drainPending()
          }
        }
      } finally { await file.close() }
    }
    if (resolveModelDefault) {
      const v = this.collector.snapshot()
      if (v) {
        const { session } = v
        session.defaultEffort = this.modelProvider === 'openai' && session.model
          ? await this.modelDefault?.(session.model, v.core.cwd) : undefined
      }
    }
  }
}
