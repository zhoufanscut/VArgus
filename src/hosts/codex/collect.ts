import { initialSession } from '../../core/session.ts'
import { initialLimits, type RateLimit } from '../../core/limits.ts'
import { initialVcs } from '../../core/vcs.ts'
import type { Values } from '../../core/types.ts'
import type { Item, Limits, Message, Thread, TokenUsage } from './protocol.ts'

const TOOL_ITEMS = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'imageGeneration', 'imageView'])
type State = { values: Values; seen: Set<string>; agentItems: Set<string>; usage: number }

// Tracks cumulative readings, rather than adding cumulative totals repeatedly.
// The saved-log reader supplies completed items; skill loads are counted there.
export class CodexCollector {
  private threads = new Map<string, State>()
  private limits = new Map<string, Limits>()
  active: string | undefined

  private cwd: string
  private home: string | undefined
  private now: typeof Date.now
  constructor(cwd: string, home: string | undefined, now = Date.now) {
    this.cwd = cwd; this.home = home; this.now = now
  }

  private state(id: string): State {
    let state = this.threads.get(id)
    if (!state) {
      state = { values: {
        core: { cwd: this.cwd, home: this.home, columns: undefined, isWsl: false, host: 'codex' },
        session: initialSession(), limits: initialLimits(), vcs: initialVcs(),
      }, seen: new Set(), agentItems: new Set(), usage: 0 }
      state.values.session.startedAt = this.now()
      this.threads.set(id, state)
    }
    return state
  }

  selectThread(thread: Thread): void {
    this.active = thread.id
    const v = this.state(thread.id).values
    v.core.cwd = thread.cwd
    v.session.startedAt = thread.createdAt * 1000
  }

  fromServer(message: Message): void {
    const p = message.params ?? {}
    const id = typeof p.threadId === 'string' ? p.threadId : undefined
    if (message.method === 'account/rateLimits/updated' && p.rateLimits) this.mergeLimits(p.rateLimits as Limits)
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
      const spawn = item.type === 'subAgentActivity' && item.kind === 'started'
      if (spawn && !state.agentItems.has(item.id)) {
        state.agentItems.add(item.id)
        state.values.session.counts.agents++
      }
    }
  }

  private mergeLimits(next: Limits): void {
    const id = next.limitId ?? 'codex'
    const old = this.limits.get(id) ?? {}
    this.limits.set(id, { ...old, ...Object.fromEntries(Object.entries(next).filter(([, v]) => v != null)) })
  }

  snapshot(selected = this.active): Values | undefined {
    if (!selected) return undefined
    const state = this.state(selected)
    const v = state.values
    v.session.counts.tokens = state.usage
    const limit = [...this.limits.values()].find(l => v.session.model !== undefined && l.normalModelSlug === v.session.model)
      ?? this.limits.get('codex')
    v.limits.engine = limit ? [this.window(limit.primary, 'five_hour'), this.window(limit.secondary, 'seven_day')]
      .filter((w): w is RateLimit => w !== undefined) : []
    return v
  }

  private window(w: Limits['primary'], kind: string): RateLimit | undefined {
    if (!w) return undefined
    const mins = w.windowDurationMins
    const label = mins == null ? (kind === 'five_hour' ? 'primary' : 'secondary')
      : mins % 1440 === 0 ? `${mins / 1440}d` : mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`
    return { kind, label, percentUsed: w.usedPercent, resetsAt: w.resetsAt == null ? undefined : new Date(w.resetsAt * 1000).toISOString() }
  }
}
