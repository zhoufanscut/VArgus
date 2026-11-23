import { isRecentUsage, resetTime, type QuotaWindow } from '../../core/limits.ts'
import { cacheHitFromSplitInput, initialCounts, initialSession, type Counts } from '../../core/session.ts'
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

type AssistantUsage = { tokens: number; cacheHitPercent: number | undefined }

export type OmoSubagentSkillMap = ReadonlyMap<string, ReadonlySet<string>>

export type OmoRunRange = {
  readonly runStartEpoch: number
  readonly runEpoch: number
}

export type OmoRefusedTaskMap = ReadonlyMap<string, readonly OmoRunRange[]>

export type OmoSpawnReceipt = {
  readonly confirmed: boolean
  readonly confirmedEpochs: ReadonlySet<number | undefined>
  readonly confirmedSkills: ReadonlySet<string>
  readonly provisionalRuns: ReadonlyMap<number | undefined, ReadonlySet<string>>
}

export type OmoSpawnReceiptMap = ReadonlyMap<string, OmoSpawnReceipt>

type MutableSpawnReceipt = {
  confirmed: boolean
  confirmedEpochs: Set<number | undefined>
  confirmedSkills: Set<string>
  provisionalRuns: Map<number | undefined, Set<string>>
}

export type OmoHistory = {
  counts: Counts
  entries: Set<string>
  calls: Set<string>
  agents: Set<string>
  subagentSkills: Map<string, Set<string>>
  spawnReceipts: Map<string, MutableSpawnReceipt>
  usage: Map<string, AssistantUsage>
  latestUsage?: AssistantUsage
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

export function parseOmoRunEpoch(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

// Failure kinds raised strictly before a child session runs in OmO 5.1.61
// (`packages/senpi-task/src/state/start-failure.ts` enum; emitted by
// `src/manager/start-failure.ts` and `src/manager/manager.ts`).
// Excludes post-launch error kinds (`child-unresponsive`, `suspended_unresumable`,
// `child-turn-failed`, `child-prompt-failed`), bare `status: "error"`, and
// `model_chain_exhausted` without an explicit model-admission `failure_reason`.
const PRE_LAUNCH_REFUSAL_KINDS = new Set([
  'model_unavailable',
  'tools_unavailable',
  'depth-exceeded',
  'session-create-failed',
  'host_unavailable',
  'session_unavailable',
  'isolation_unavailable',
])

// Explicit model-admission reasons from OmO 5.1.61 `MODEL_START_FAILURE_REASONS`
// (`packages/senpi-task/src/state/start-failure.ts`). When every model in a
// fallback chain is refused at admission (`#describeStartFailure`), OmO rewrites
// `failure_kind` to `model_chain_exhausted` while preserving `failure_reason`.
// Runtime/mid-turn chain exhaustion (`terminalFailureFields`) never sets `failure_reason`.
const MODEL_ADMISSION_REFUSAL_REASONS = new Set([
  'model_not_in_child_profile',
  'catalog_probe_timed_out',
  'catalog_probe_failed',
])

function hasLaunchFacts(item: Record<string, unknown>): boolean {
  if (typeof item.child_session_id === 'string' && item.child_session_id !== '') return true
  if (typeof item.effective_model === 'string' && item.effective_model !== '') return true
  if (isRecord(item.run_stats) || isRecord(item.effective_model) || isRecord(item.host_session)) return true
  if (typeof item.pid === 'number' && Number.isFinite(item.pid)) return true
  if (typeof item.prior_runs_cost_usd === 'number' && Number.isFinite(item.prior_runs_cost_usd) && item.prior_runs_cost_usd > 0) return true
  return false
}

export function isPreLaunchTaskRefusal(value: unknown): boolean {
  const item = record(value)
  if (!item || item.status !== 'error') return false
  const isPreLaunchKind = typeof item.failure_kind === 'string' && PRE_LAUNCH_REFUSAL_KINDS.has(item.failure_kind)
  const isExhaustedAdmission = item.failure_kind === 'model_chain_exhausted'
    && typeof item.failure_reason === 'string'
    && MODEL_ADMISSION_REFUSAL_REASONS.has(item.failure_reason)
  if (!isPreLaunchKind && !isExhaustedAdmission) return false
  // A task carrying launch/runtime facts already ran before failing (e.g. paused resume or mid-turn failure).
  return !hasLaunchFacts(item)
}

const PROVISIONAL_SPAWN_STATUSES = new Set(['pending', 'running', 'paused'])

function isProvisionalSpawnReceipt(item: Record<string, unknown>): boolean {
  if (hasLaunchFacts(item)) return false
  if (typeof item.status === 'string' && PROVISIONAL_SPAWN_STATUSES.has(item.status)) return true
  return item.status === 'error' && item.failure_kind === undefined
}

export function isRefusedProvisionalRun(epoch: number | undefined, refusal: OmoRunRange): boolean {
  if (refusal.runStartEpoch > refusal.runEpoch) return false
  if (epoch === undefined) return refusal.runStartEpoch === 0
  return epoch >= refusal.runStartEpoch && epoch <= refusal.runEpoch
}

export function reconcileOmoSpawns(
  spawns: OmoSpawnReceiptMap,
  refusedTasks: OmoRefusedTaskMap,
): { agents: Set<string>; skills: Map<string, Set<string>> } {
  const agents = new Set<string>()
  const skills = new Map<string, Set<string>>()
  for (const [taskId, receipt] of spawns) {
    const refusals = refusedTasks.get(taskId)
    let kept = receipt.confirmed
    let taskSkills: Set<string> | undefined
    const addAll = (names: ReadonlySet<string>) => {
      for (const name of names) {
        if (!taskSkills) {
          taskSkills = new Set()
          skills.set(taskId, taskSkills)
        }
        taskSkills.add(name)
      }
    }
    if (receipt.confirmed) addAll(receipt.confirmedSkills)
    for (const [epoch, runSkills] of receipt.provisionalRuns) {
      if (refusals?.some(run => isRefusedProvisionalRun(epoch, run))) continue
      kept = true
      addAll(runSkills)
    }
    if (kept) agents.add(taskId)
  }
  return { agents, skills }
}

function forEachResolvedSkill(item: Record<string, unknown>, visit: (name: string) => void): void {
  const skills = record(item.skills)
  if (!skills || !Array.isArray(skills.resolved)) return
  for (const entry of skills.resolved) {
    if (typeof entry !== 'string') continue
    const name = entry.trim()
    if (name) visit(name)
  }
}

function addSkillNames(target: Set<string>, item: Record<string, unknown>): void {
  forEachResolvedSkill(item, name => { target.add(name) })
}

function addResolvedSkills(target: Map<string, Set<string>>, taskId: string, item: Record<string, unknown>): void {
  let names = target.get(taskId)
  forEachResolvedSkill(item, name => {
    if (!names) {
      names = new Set()
      target.set(taskId, names)
    }
    names.add(name)
  })
}

function agent(state: OmoHistory, value: unknown): void {
  const item = record(value)
  if (typeof item?.task_id !== 'string' || !item.task_id) return
  if (isPreLaunchTaskRefusal(item)) return
  state.agents.add(item.task_id)
  addResolvedSkills(state.subagentSkills, item.task_id, item)
  let receipt = state.spawnReceipts.get(item.task_id)
  if (!receipt) {
    receipt = { confirmed: false, confirmedEpochs: new Set(), confirmedSkills: new Set(), provisionalRuns: new Map() }
    state.spawnReceipts.set(item.task_id, receipt)
  }
  const hasEpoch = Object.hasOwn(item, 'run_epoch') && item.run_epoch !== undefined
  const epoch = hasEpoch ? parseOmoRunEpoch(item.run_epoch) : undefined
  // A malformed run_epoch fails closed (retained as confirmed without polluting confirmedEpochs).
  if (hasEpoch && epoch === undefined) {
    receipt.confirmed = true
    addSkillNames(receipt.confirmedSkills, item)
    return
  }
  if (isProvisionalSpawnReceipt(item)) {
    if (receipt.confirmedEpochs.has(epoch)) {
      addSkillNames(receipt.confirmedSkills, item)
    } else {
      let runSkills = receipt.provisionalRuns.get(epoch)
      if (!runSkills) {
        runSkills = new Set()
        receipt.provisionalRuns.set(epoch, runSkills)
      }
      addSkillNames(runSkills, item)
    }
  } else {
    receipt.confirmed = true
    receipt.confirmedEpochs.add(epoch)
    addSkillNames(receipt.confirmedSkills, item)
    const promoted = receipt.provisionalRuns.get(epoch)
    if (promoted) {
      for (const name of promoted) receipt.confirmedSkills.add(name)
      receipt.provisionalRuns.delete(epoch)
    }
  }
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

export type OmoEntryInput = {
  readonly id?: unknown
  readonly type?: unknown
  readonly customType?: unknown
  readonly data?: unknown
  readonly message?: unknown
}

export function createOmoHistory(): OmoHistory {
  return {
    counts: initialCounts(), entries: new Set(), calls: new Set(),
    agents: new Set(), subagentSkills: new Map(), spawnReceipts: new Map(), usage: new Map(), edits: new Set(),
  }
}

export function foldOmoEntry(state: OmoHistory, entry: OmoEntryInput, fallbackId?: string): OmoHistory {
  const id = typeof entry.id === 'string' && entry.id !== '' ? entry.id : undefined
  if (id !== undefined) {
    if (state.entries.has(id)) return state
    state.entries.add(id)
  }
  if (entry.type === 'custom' && entry.customType === OMO_EDIT_ENTRY) {
    const data = record(entry.data)
    if (typeof data?.entryId === 'string' && data.entryId !== '' && !state.edits.has(data.entryId)) {
      state.edits.add(data.entryId)
      const copy = state.usage.get(data.entryId)
      if (copy) {
        state.counts.tokens -= copy.tokens
        state.usage.delete(data.entryId)
        // Edits are rare. Normal appends and rendering use the saved latest reading.
        if (state.latestUsage === copy) state.latestUsage = Array.from(state.usage.values()).at(-1)
      }
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
    if (id === undefined || !state.edits.has(id)) {
      const reading: AssistantUsage = {
        tokens,
        cacheHitPercent: cacheHitFromSplitInput(usage?.cacheRead, usage?.input, usage?.cacheWrite),
      }
      state.latestUsage = reading
      if (id !== undefined) state.usage.set(id, reading)
      state.counts.tokens += tokens
    }
    if (Array.isArray(message.content)) {
      const entryKey = id ?? fallbackId ?? ''
      for (const [index, value] of message.content.entries()) {
        const call = record(value)
        if (call?.type !== 'toolCall') continue
        const key = typeof call.runtimeItemKey === 'string' && call.runtimeItemKey !== ''
          ? call.runtimeItemKey : `${entryKey}:${index}`
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
  }
  state.counts.agents = state.agents.size
  // Main-session skill loads lack a canonical receipt (reading SKILL.md does not
  // establish one). Explicitly resolved child task skills (`skills.resolved` on
  // accepted spawn receipts) are stored in `subagentSkills` and `spawnReceipts`,
  // and folded only when `includeSubagents` is enabled.
  return state
}

// A stable reducer lets the host fold only appended entries after the first read.
// It covers every branch of this session, including pre-compaction history.
export const omoHistoryReducer: HistoryReducer<OmoHistory> = {
  initial: createOmoHistory,
  add: (state, entry) => foldOmoEntry(state, entry),
}

export function collectOmoAgents(ctx: NativeContext): ReadonlySet<string> {
  return ctx.sessionManager.reduceHistory(omoHistoryReducer).agents
}

export function collectOmoSubagentSkills(ctx: NativeContext): OmoSubagentSkillMap {
  return ctx.sessionManager.reduceHistory(omoHistoryReducer).subagentSkills
}

export function collectOmoSpawns(ctx: NativeContext): OmoSpawnReceiptMap {
  return ctx.sessionManager.reduceHistory(omoHistoryReducer).spawnReceipts
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
  session.cacheHitPercent = history.latestUsage?.cacheHitPercent
  session.model = ctx.model?.id
  session.effort = ctx.thinkingLevel
  session.defaultEffort = ctx.model?.defaultThinkingLevel
  const startedAt = Date.parse(ctx.sessionManager.getHeader()?.timestamp ?? '')
  if (Number.isFinite(startedAt)) session.startedAt = startedAt
  const context = ctx.getContextUsage()
  if (context) {
    if (nonnegative(context.tokens)) session.contextTokens = context.tokens
    if (nonnegative(context.percent)) session.contextPercent = context.percent
    if (nonnegative(context.contextWindow) && context.contextWindow > 0) session.contextWindow = context.contextWindow
  }
  const fiveHour: QuotaWindow[] = [], sevenDay: QuotaWindow[] = [], others: QuotaWindow[] = []
  for (const account of accounts) {
    if (account.provider !== ctx.model?.provider || !isRecentUsage(Date.parse(account.reportedAt), now)) continue
    for (const window of account.windows) {
      if (window.id === 'spend_limit') continue
      if (!nonnegative(window.usedPercent) || window.usedPercent > 100) continue
      const reading: QuotaWindow = {
        label: window.label, percent: window.usedPercent, resetsAt: resetTime(window.resetsAt),
      }
      const kind = window.windowMinutes === 300 || window.label === '5h' ? 'five_hour'
        : window.windowMinutes === 10080 || window.label === '7d' ? 'seven_day' : window.id
      if (kind === 'five_hour') fiveHour.push(reading)
      else if (kind === 'seven_day') sevenDay.push(reading)
      else if (window.label) others.push(reading)
    }
  }
  const limits = [...fiveHour, ...sevenDay, ...others]
  return {
    core: { cwd: ctx.cwd, home, columns: undefined, isWsl: false },
    session, limits, vcs: initialVcs(),
  }
}
