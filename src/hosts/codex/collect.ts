import { selectedView, type ViewScreen } from './views'
import { initialSession } from '../../core/session'
import { initialLimits, type RateLimit } from '../../core/limits'
import { initialVcs } from '../../core/vcs'
import type { Values } from '../../core/types'
import type { Item, Limits, Message, Thread, TokenUsage } from './protocol'

const TOOL_ITEMS = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'webSearch', 'imageGeneration', 'imageView'])
type State = { values: Values; seen: Set<string>; agentItems: Set<string>; usage: number; parent?: string; path?: string; hidden: boolean }

// Tracks cumulative readings, rather than adding cumulative totals repeatedly.
// Counts cover the visible item stream of this launch; skills have no item here.
export class CodexCollector {
  private threads = new Map<string, State>()
  private requests = new Map<string | number, Message>()
  private limits = new Map<string, Limits>()
  active: string | undefined

  constructor(private cwd: string, private home: string | undefined, private now = Date.now) {}

  private state(id: string): State {
    let state = this.threads.get(id)
    if (!state) {
      state = { values: {
        core: { cwd: this.cwd, home: this.home, columns: undefined, isWsl: false, host: 'codex' },
        session: initialSession(), limits: initialLimits(), vcs: initialVcs(),
      }, seen: new Set(), agentItems: new Set(), usage: 0, hidden: false }
      state.values.session.startedAt = this.now()
      this.threads.set(id, state)
    }
    return state
  }

  private thread(thread: Thread, result?: Record<string, unknown>): State {
    const state = this.state(thread.id)
    state.parent = thread.parentThreadId ?? undefined
    const subagent = typeof thread.source === 'object' ? thread.source?.subAgent : undefined
    state.path = typeof subagent === 'object' ? subagent.thread_spawn?.agent_path ?? undefined : undefined
    // Match Codex's own hidden-helper rule. Ephemeral user chats remain valid.
    state.hidden = thread.ephemeral === true && ['system', 'thread_title'].includes(thread.threadSource ?? '')
    const v = state.values
    v.core.cwd = (result?.cwd as string | undefined) ?? thread.cwd ?? v.core.cwd
    v.session.model = (result?.model as string | undefined) ?? thread.model ?? v.session.model
    v.session.effort = (result?.reasoningEffort as string | undefined) ?? thread.reasoningEffort ?? undefined
    v.session.startedAt = thread.createdAt * 1000
    return state
  }

  // A local history reader selects its explicit thread; no RPC request is sent.
  selectThread(thread: Thread): void {
    if (!this.thread(thread).hidden) this.active = thread.id
  }

  fromClient(message: Message): void {
    if (message.id !== undefined && message.method) this.requests.set(message.id, message)
  }

  fromServer(message: Message): void {
    // Request ids are independent in the two JSON-RPC directions.
    const request = message.id === undefined || message.method !== undefined ? undefined : this.requests.get(message.id)
    if (request) {
      this.requests.delete(message.id!)
      if (message.error) return
      const result = message.result ?? {}
      if (['thread/start', 'thread/resume', 'thread/fork'].includes(request.method!)) {
        if (result.thread) {
          const thread = result.thread as Thread
          const state = this.thread(thread, result)
          if (!state.hidden) this.active = thread.id
        }
      } else if (request.method === 'turn/start') {
        const p = request.params ?? {}
        if (typeof p.threadId === 'string') {
          const state = this.state(p.threadId)
          if (!state.hidden) this.active = p.threadId
          const v = state.values
          if (typeof p.cwd === 'string') v.core.cwd = p.cwd
          if (typeof p.model === 'string') v.session.model = p.model
          // A null override inherits the thread's effective setting.
          if (typeof p.effort === 'string') v.session.effort = p.effort
          const collaboration = p.collaborationMode as { settings?: { model?: string; reasoning_effort?: string } } | undefined
          if (collaboration?.settings?.model) v.session.model = collaboration.settings.model
          if (collaboration?.settings?.reasoning_effort) v.session.effort = collaboration.settings.reasoning_effort
        }
      } else if (request.method === 'account/rateLimits/read') {
        this.limits.clear()
        const all = result.rateLimitsByLimitId as Record<string, Limits> | undefined
        if (all) for (const [id, limit] of Object.entries(all)) this.mergeLimits({ ...limit, limitId: id })
        else if (result.rateLimits) this.mergeLimits(result.rateLimits as Limits)
      }
    }
    const p = message.params ?? {}
    const id = typeof p.threadId === 'string' ? p.threadId : undefined
    if (message.method === 'thread/started' && p.thread) this.thread(p.thread as Thread)
    else if (message.method === 'account/rateLimits/updated' && p.rateLimits) this.mergeLimits(p.rateLimits as Limits)
    else if (message.method === 'account/updated') this.limits.clear()
    else if (id && message.method === 'thread/tokenUsage/updated') {
      const usage = p.tokenUsage as TokenUsage
      const state = this.state(id)
      state.usage = Math.max(0, usage.total.inputTokens - usage.total.cachedInputTokens) + usage.total.outputTokens
      const v = state.values.session
      v.contextTokens = usage.last.totalTokens
      v.contextWindow = usage.modelContextWindow ?? undefined
      // Match Codex's own context gauge, including its baseline allowance.
      if (v.contextWindow !== undefined) {
        const effective = v.contextWindow - 12000
        const remaining = effective <= 0 ? 0 : Math.round(Math.max(0, Math.min(1,
          (effective - Math.max(0, v.contextTokens - 12000)) / effective)) * 100)
        v.contextPercent = 100 - remaining
      } else v.contextPercent = undefined
    } else if (id && message.method === 'item/started') {
      const item = p.item as Item
      const state = this.state(id)
      if (item.type === 'contextCompaction') {
        state.values.session.contextPercent = undefined
        state.values.session.contextTokens = undefined
      }
      if (TOOL_ITEMS.has(item.type) && !state.seen.has(item.id)) {
        state.seen.add(item.id)
        state.values.session.counts.tools++
      }
      const legacySpawn = item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent'
      const v2Spawn = item.type === 'subAgentActivity' && item.kind === 'started'
      if ((legacySpawn || v2Spawn) && !state.agentItems.has(item.id)) {
        state.agentItems.add(item.id)
        state.values.session.counts.agents++
      }
      if (v2Spawn && item.agentThreadId) this.state(item.agentThreadId).parent = id
    } else if (id && message.method === 'model/rerouted') {
      if (typeof p.toModel === 'string') this.state(id).values.session.model = p.toModel
    }
  }

  private mergeLimits(next: Limits): void {
    const id = next.limitId ?? 'codex'
    const old = this.limits.get(id) ?? {}
    this.limits.set(id, { ...old, ...Object.fromEntries(Object.entries(next).filter(([, v]) => v != null)) })
  }

  // RPC selection can lag cached frontend navigation. Resolve the visible view
  // from observed thread metadata without changing the server-selected thread.
  displayedThread(screen: ViewScreen): string | undefined {
    if (!this.active) return
    let root = this.active
    const seen = new Set<string>()
    while (!seen.has(root)) {
      seen.add(root)
      const parent = this.threads.get(root)?.parent
      if (!parent || !this.threads.has(parent) || this.threads.get(parent)!.hidden) break
      root = parent
    }
    const family = [...this.threads].filter(([id]) => this.belongsTo(id, root))
      .map(([thread, state]) => ({ thread, path: state.path }))
    // The launcher clears configurable items; UUID-looking footer text is not
    // a configured session-id. Contextual labels identify cached views instead.
    return selectedView(screen, family, root, 'none')?.thread
  }

  snapshot(selected = this.active): Values | undefined {
    if (!selected) return undefined
    const state = this.state(selected)
    const v = state.values
    // Child totals are included only for children present in this stream.
    v.session.counts.tokens = [...this.threads.entries()].reduce((n, [id, s]) =>
      n + (this.belongsTo(id, selected) ? s.usage : 0), 0)
    const limit = [...this.limits.values()].find(l => v.session.model !== undefined && l.normalModelSlug === v.session.model)
      ?? this.limits.get('codex')
    v.limits.engine = limit ? [this.window(limit.primary, 'five_hour'), this.window(limit.secondary, 'seven_day')]
      .filter((w): w is RateLimit => w !== undefined) : []
    return v
  }

  private belongsTo(id: string, selected: string): boolean {
    const seen = new Set<string>()
    while (!seen.has(id)) {
      seen.add(id)
      const state = this.threads.get(id)
      if (state?.hidden) return false
      if (id === selected) return true
      if (!state?.parent) return false
      id = state.parent
    }
    return false
  }

  private window(w: Limits['primary'], kind: string): RateLimit | undefined {
    if (!w) return undefined
    const mins = w.windowDurationMins
    const label = mins == null ? (kind === 'five_hour' ? 'primary' : 'secondary')
      : mins % 1440 === 0 ? `${mins / 1440}d` : mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`
    return { kind, label, percentUsed: w.usedPercent, resetsAt: w.resetsAt == null ? undefined : new Date(w.resetsAt * 1000).toISOString() }
  }
}
