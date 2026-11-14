import { initialLimits, MAX_STALE_MS } from '../../core/limits.ts'
import { initialSession, zero, type Counts } from '../../core/session.ts'
import type { Values } from '../../core/types.ts'
import { initialVcs } from '../../core/vcs.ts'
import type { AccountLimits, HistoryReducer, NativeContext } from './contracts.ts'

// pi.appendEntry(OMO_CONFIG_ENTRY, { enabled, options }) persists user choices
// outside model context. Partial records update only the supplied fields.
export const OMO_CONFIG_ENTRY = 'vargus-settings'
export const OMO_EDIT_ENTRY = 'vargus-assistant-edit'

export type OmoSettings = {
  enabled: boolean
  options: Record<string, unknown>
}

export type OmoHistory = {
  counts: Counts
  entries: Set<string>
  calls: Set<string>
  agents: Set<string>
  workflows: Set<string>
  usage: Map<string, number>
  edits: Set<string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function agent(state: OmoHistory, value: unknown): void {
  const item = record(value)
  if (typeof item?.task_id === 'string' && item.task_id) state.agents.add(item.task_id)
}

export const omoSettingsReducer: HistoryReducer<OmoSettings> = {
  initial: () => ({ enabled: true, options: {} }),
  add(state, entry) {
    if (entry.type !== 'custom' || entry.customType !== OMO_CONFIG_ENTRY) return state
    const data = record(entry.data)
    if (typeof data?.enabled === 'boolean') state.enabled = data.enabled
    const options = record(data?.options)
    if (options) state.options = { ...options }
    return state
  },
}

// A stable reducer lets the host fold only appended entries after the first read.
// It covers every branch of this session, including pre-compaction history.
export const omoHistoryReducer: HistoryReducer<OmoHistory> = {
  initial: () => ({
    counts: zero(), entries: new Set(), calls: new Set(),
    agents: new Set(), workflows: new Set(), usage: new Map(), edits: new Set(),
  }),
  add(state, entry) {
    if (state.entries.has(entry.id)) return state
    state.entries.add(entry.id)
    if (entry.type === 'custom' && entry.customType === OMO_EDIT_ENTRY) {
      const data = record(entry.data)
      if (typeof data?.entryId === 'string' && !state.edits.has(data.entryId)) {
        state.edits.add(data.entryId)
        state.counts.tokens -= state.usage.get(data.entryId) ?? 0
      }
      return state
    }
    if (entry.type !== 'message') return state
    const message = record(entry.message)
    if (!message) return state
    if (message.role === 'assistant') {
      const usage = record(message.usage)
      // input is already separate from cacheRead/cacheWrite. Tool-result usage
      // belongs to nested work and is deliberately excluded.
      const tokens = (nonnegative(usage?.input) ? usage.input : 0)
        + (nonnegative(usage?.output) ? usage.output : 0)
      state.usage.set(entry.id, tokens)
      if (!state.edits.has(entry.id)) state.counts.tokens += tokens
      if (Array.isArray(message.content)) {
        for (const [index, value] of message.content.entries()) {
          const call = record(value)
          if (call?.type !== 'toolCall') continue
          const key = typeof call.runtimeItemKey === 'string'
            ? call.runtimeItemKey : `${entry.id}:${index}`
          if (state.calls.has(key)) continue
          state.calls.add(key)
          state.counts.tools++
        }
      }
    } else if (message.role === 'toolResult') {
      const details = record(message.details)
      // Count accepted task identities, never requested batch sizes or tool names.
      if (message.toolName === 'task' && details?.mode === 'spawn') {
        if (Array.isArray(details.items)) {
          for (const item of details.items) agent(state, item)
        } else {
          agent(state, details)
        }
      }
    } else if (message.role === 'custom' && message.customType === 'omo-senpi.dag-run') {
      // The host emits these notices for paused/terminal DAG runs. A running
      // workflow with no persisted notice is unknown, rather than inferred.
      const details = record(message.details)
      if (typeof details?.runId === 'string' && details.runId) state.workflows.add(details.runId)
    }
    state.counts.agents = state.agents.size
    state.counts.workflows = state.workflows.size
    // No canonical skill-load receipt is exposed by the established history
    // contract. Reading a file named SKILL.md does not establish a skill load.
    return state
  },
}

export function collectOmo(
  ctx: NativeContext,
  accounts: readonly AccountLimits[],
  home: string | undefined,
  now: number,
): Values {
  const history = ctx.sessionManager.reduceHistory(omoHistoryReducer)
  const session = initialSession()
  session.counts = { ...history.counts }
  session.model = ctx.model?.id
  session.effort = ctx.thinkingLevel
  const startedAt = Date.parse(ctx.sessionManager.getHeader()?.timestamp ?? '')
  if (Number.isFinite(startedAt)) session.startedAt = startedAt
  const context = ctx.getContextUsage()
  if (context) {
    if (nonnegative(context.tokens)) session.contextTokens = context.tokens
    if (nonnegative(context.percent)) session.contextPercent = context.percent
    if (nonnegative(context.contextWindow) && context.contextWindow > 0) session.contextWindow = context.contextWindow
  }
  const limits = initialLimits()
  for (const account of accounts) {
    if (account.provider !== ctx.model?.provider) continue
    const reportedAt = Date.parse(account.reportedAt)
    if (!Number.isFinite(reportedAt) || now - reportedAt > MAX_STALE_MS) continue
    for (const window of account.windows) {
      if (!nonnegative(window.usedPercent) || window.usedPercent > 100) continue
      const kind = window.windowMinutes === 300 || window.label === '5h' ? 'five_hour'
        : window.windowMinutes === 10080 || window.label === '7d' ? 'seven_day' : window.id
      limits.engine.push({
        kind,
        percentUsed: window.usedPercent,
        label: window.label,
        ...(window.resetsAt && Number.isFinite(Date.parse(window.resetsAt)) ? { resetsAt: window.resetsAt } : {}),
        ...(account.error ? { stale: true } : {}),
      })
    }
  }
  return {
    core: { host: 'omo', cwd: ctx.cwd, home, columns: undefined, isWsl: false },
    session, limits, vcs: initialVcs(),
  }
}
