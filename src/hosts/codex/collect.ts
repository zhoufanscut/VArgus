import { initialSession } from '../../core/session.ts'
import { initialLimits, type RateLimit } from '../../core/limits.ts'
import { initialVcs } from '../../core/vcs.ts'
import type { Values } from '../../core/types.ts'
import type { Item, Limits, TokenUsage } from './protocol.ts'

const TOOL_ITEMS = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'imageGeneration', 'imageView'])

// Tracks cumulative readings, rather than adding cumulative totals repeatedly.
// The saved-log reader supplies completed items; skill loads are counted there.
export class CodexCollector {
  private values: Values
  private selected = false
  private seen = new Set<string>()
  private agentItems = new Set<string>()
  private usage = 0
  private limits = new Map<string, Limits>()

  constructor(cwd: string, home: string | undefined) {
    this.values = {
      core: { cwd, home, columns: undefined, isWsl: false, host: 'codex' },
      session: initialSession(), limits: initialLimits(), vcs: initialVcs(),
    }
  }

  start(cwd: string, createdAt: number): void {
    this.selected = true
    this.values.core.cwd = cwd
    this.values.session.startedAt = createdAt * 1000
  }

  updateUsage(usage: TokenUsage): void {
    this.usage = Math.max(0, usage.total.inputTokens - usage.total.cachedInputTokens) + usage.total.outputTokens
    const v = this.values.session
    v.contextTokens = usage.last.totalTokens
    v.contextWindow = usage.modelContextWindow ?? undefined
    // Match Codex's own context gauge, including its baseline allowance.
    if (v.contextWindow !== undefined) {
      const effective = v.contextWindow - 12000
      const remaining = effective <= 0 ? 0 : Math.round(Math.max(0, Math.min(1,
        (effective - Math.max(0, v.contextTokens - 12000)) / effective)) * 100)
      v.contextPercent = 100 - remaining
    } else v.contextPercent = undefined
  }

  completeItem(item: Item): void {
    if (item.type === 'contextCompaction') this.compact()
    if (TOOL_ITEMS.has(item.type) && !this.seen.has(item.id)) {
      this.seen.add(item.id)
      this.values.session.counts.tools++
    }
    const spawn = item.type === 'subAgentActivity' && item.kind === 'started'
    if (spawn && !this.agentItems.has(item.id)) {
      this.agentItems.add(item.id)
      this.values.session.counts.agents++
    }
  }

  compact(): void {
    this.values.session.contextPercent = undefined
    this.values.session.contextTokens = undefined
  }

  updateLimits(next: Limits): void {
    const id = next.limitId ?? 'codex'
    const old = this.limits.get(id) ?? {}
    this.limits.set(id, { ...old, ...Object.fromEntries(Object.entries(next).filter(([, v]) => v != null)) })
  }

  snapshot(): Values | undefined {
    if (!this.selected) return undefined
    const v = this.values
    v.session.counts.tokens = this.usage
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
