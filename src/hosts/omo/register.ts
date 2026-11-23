import { homedir, release } from 'node:os'
import {
  collectOmo,
  collectOmoSpawns,
  omoSettingsReducer,
  OMO_CONFIG_ENTRY,
  OMO_EDIT_ENTRY,
  reconcileOmoSpawns,
  type OmoSpawnReceipt,
  type OmoSpawnReceiptMap,
  type OmoSubagentSkillMap,
} from './collect.ts'
import { omoDisplay } from './display.ts'
import type { AccountLimits, NativeContext, SessionEntry } from './contracts.ts'
import { OmoSubagents } from './subagents.ts'
import { OmoVcs } from './vcs.ts'
import { OmoKimi, type ProviderAuth } from './kimi.ts'
import { outputTokensPerSecond } from '../../core/session.ts'
import { readCheckoutOptions, readOptionsFile } from '../../node/options.ts'
import { mountOmo, type OmoUi } from '../../outputs/omo.ts'
import { parseOptions, resolveOptions } from '../../options.ts'
import { resolveLabels } from '../../i18n/index.ts'
import { makeTheme } from '../../theme/index.ts'
import { REFRESH_GRACE_MS, staleLine } from '../../render/freshness.ts'
import { render } from '../../render/index.ts'

const STREAM_START_EVENTS = new Set([
  'thinking_start', 'thinking_delta', 'text_start', 'text_delta', 'toolcall_start', 'toolcall_delta',
])
const STREAM_END_EVENTS = new Set([
  'thinking_delta', 'thinking_end', 'text_delta', 'text_end', 'toolcall_delta', 'toolcall_end',
])

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

type Context = NativeContext & {
  readonly modelRegistry: { getProviderAuth(provider: string): Promise<ProviderAuth | undefined> }
  readonly sessionManager: NativeContext['sessionManager'] & { getEntry(id: string): SessionEntry | undefined }
  readonly ui: OmoUi & { notify(message: string, type?: 'info' | 'warning' | 'error'): void }
}
type Handler = (event: unknown, ctx: Context) => void

// Structural subset of the native API: runtime SDK provisioning belongs to OmO,
// not to a VArgus user's node_modules (DESIGN, "OmO Native").
export type OmoApi = {
  on(event: 'session_start', handler: Handler): () => void
  on(event: 'session_shutdown', handler: Handler): () => void
  on(event: 'session_tree', handler: Handler): () => void
  on(event: 'session_before_tree', handler: Handler): () => void
  on(event: 'session_compact', handler: Handler): () => void
  on(event: 'message_start', handler: Handler): () => void
  on(event: 'message_update', handler: Handler): () => void
  on(event: 'message_end', handler: Handler): () => void
  on(event: 'tool_execution_end', handler: Handler): () => void
  on(event: 'model_select', handler: Handler): () => void
  on(event: 'thinking_level_select', handler: Handler): () => void
  getSubscriptionLimits(): readonly AccountLimits[]
  onSubscriptionLimits(listener: (limits: AccountLimits) => void): () => void
  appendEntry(customType: string, data: unknown): void
  registerCommand(name: string, command: {
    description: string
    handler(args: string, ctx: Context): Promise<void>
  }): void
}

export function configuredVargus(file: string): (pi: OmoApi) => void {
  return pi => vargus(pi, { ...readCheckoutOptions(), ...readOptionsFile(file) })
}

function modelKey(model: Record<string, unknown> | undefined): string | undefined {
  if (!model || typeof model.id !== 'string') return undefined
  return `${typeof model.provider === 'string' ? model.provider : ''}\0${model.id}`
}

function unionSize(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let count = a.size
  for (const id of b) if (!a.has(id)) count++
  return count
}

function unionSkillCount(a: OmoSubagentSkillMap, b: OmoSubagentSkillMap): number {
  let count = 0
  for (const names of a.values()) count += names.size
  for (const [taskId, names] of b) {
    const seen = a.get(taskId)
    if (!seen) { count += names.size; continue }
    for (const name of names) if (!seen.has(name)) count++
  }
  return count
}

function snapshotSpawns(spawns: OmoSpawnReceiptMap): OmoSpawnReceiptMap {
  const copy = new Map<string, OmoSpawnReceipt>()
  for (const [taskId, receipt] of spawns) {
    const provisionalRuns = new Map<number | undefined, ReadonlySet<string>>()
    for (const [epoch, names] of receipt.provisionalRuns) {
      provisionalRuns.set(epoch, new Set(names))
    }
    copy.set(taskId, {
      confirmed: receipt.confirmed,
      confirmedEpochs: new Set(receipt.confirmedEpochs),
      confirmedSkills: new Set(receipt.confirmedSkills),
      provisionalRuns,
    })
  }
  return copy
}

export default function vargus(pi: OmoApi, fileOptions: Record<string, unknown> = readCheckoutOptions()): void {
  let active: {
    ctx: Context
    stop(): void
    update(opts?: { forceVcs?: boolean; forceSubagents?: boolean }): void
    messageStart(event: unknown): void
    messageUpdate(event: unknown): void
    messageEnd(event: unknown): void
    modelSelected(event: unknown, nextCtx: Context): void
    clearRate(): void
  } | undefined
  let treeTarget: string | undefined

  function stop(): void {
    active?.stop()
    active = undefined
  }

  function start(ctx: Context): void {
    stop()
    if (ctx.mode !== 'tui') return
    const settings = ctx.sessionManager.reduceHistory(omoSettingsReducer)
    if (!settings.enabled) return
    const options = resolveOptions({ ...fileOptions, ...settings.options })
    const vcs = new OmoVcs()
    const subagents = options.includeSubagents && (options.tokens || options.callCounts)
      ? new OmoSubagents() : undefined
    const kimi = new OmoKimi(() => instance.ctx.modelRegistry.getProviderAuth('kimi-coding'))
    const theme = makeTheme(options.theme, Boolean(process.env.NO_COLOR))
    const labels = resolveLabels('en')
    const isWsl = Boolean(process.env.WSL_DISTRO_NAME || process.env.WSLENV || /microsoft/i.test(release()))
    let disposed = false
    let stream: { firstAt?: number; lastAt?: number; events: number } | undefined
    let tokensPerSecond: number | undefined
    let lastModelKey = modelKey(ctx.model)
    let values = collectOmo(ctx, options.rateLimits ? pi.getSubscriptionLimits() : [], homedir(), Date.now())
    let mainSpawns: OmoSpawnReceiptMap = subagents ? snapshotSpawns(collectOmoSpawns(ctx)) : new Map()
    let checkedAt = Date.now()
    const instance = {
      ctx,
      messageStart(event: unknown) {
        if (disposed) return
        const msg = asRecord(asRecord(event)?.message)
        if (msg?.role === 'assistant') stream = { events: 0 }
      },
      messageUpdate(event: unknown) {
        if (disposed || !stream) return
        const body = asRecord(event)
        const msg = asRecord(body?.message)
        if (msg && msg.role !== 'assistant') return
        const kind = asRecord(body?.assistantMessageEvent)?.type
        if (typeof kind !== 'string') return
        const isStart = STREAM_START_EVENTS.has(kind)
        const isEnd = STREAM_END_EVENTS.has(kind)
        if (!isStart && !isEnd) return
        const at = performance.now()
        if (isStart && stream.firstAt === undefined) stream.firstAt = at
        if (isEnd) stream.lastAt = at
        stream.events += 1
      },
      messageEnd(event: unknown) {
        if (disposed) return
        const msg = asRecord(asRecord(event)?.message)
        if (msg?.role !== 'assistant') return
        const finished = stream
        stream = undefined
        if (msg.stopReason === 'error' || msg.stopReason === 'aborted' || msg.stopReason === 'deferred') return
        const out = asRecord(msg.usage)?.output
        if (typeof out !== 'number' || !Number.isFinite(out) || out <= 0) {
          tokensPerSecond = undefined
          return
        }
        if (finished && finished.events >= 2 && finished.firstAt !== undefined && finished.lastAt !== undefined) {
          const rate = outputTokensPerSecond(out, finished.lastAt - finished.firstAt)
          if (rate !== undefined) tokensPerSecond = rate
        }
      },
      modelSelected(event: unknown, nextCtx: Context) {
        const data = asRecord(event)
        const prev = asRecord(data?.previousModel)
        const next = asRecord(data?.model)
        const prevKey = modelKey(prev) ?? lastModelKey
        const nextKey = modelKey(next) ?? modelKey(nextCtx.model)
        if (prevKey !== undefined && nextKey !== prevKey) this.clearRate()
        lastModelKey = nextKey
      },
      clearRate() {
        stream = undefined
        tokensPerSecond = undefined
      },
      update(opts?: { forceVcs?: boolean; forceSubagents?: boolean }) {
        if (disposed) return
        const current = instance.ctx
        const forceVcs = opts?.forceVcs ?? false
        const forceSubagents = opts?.forceSubagents ?? false
        let sessionId = ''
        try {
          const nextValues = collectOmo(current, options.rateLimits ? pi.getSubscriptionLimits() : [], homedir(), Date.now())
          const nextSessionId = subagents ? current.sessionManager.getSessionId() : ''
          const nextSpawns = subagents ? snapshotSpawns(collectOmoSpawns(current)) : mainSpawns
          nextValues.session.tokensPerSecond = tokensPerSecond
          values = nextValues
          mainSpawns = nextSpawns
          sessionId = nextSessionId
          checkedAt = Date.now()
        } catch {
          output.refresh()
          return
        }
        if (options.rateLimits) {
          void kimi.refresh(current.model?.provider).then(() => {
            if (disposed || instance.ctx.model?.provider !== 'kimi-coding') return
            output.refresh()
          })
        }
        values.vcs = vcs.values
        if (subagents) {
          void subagents.refresh(current.cwd, sessionId, Date.now(), forceSubagents).then(() => {
            if (disposed) return
            output.refresh()
          })
        }
        output.refresh()
        if (options.repo || options.branch || options.status) {
          void vcs.refresh(current.cwd, Date.now(), forceVcs).then(reading => {
            if (disposed) return
            values.vcs = reading
            output.refresh()
          })
        }
      },
      stop() {
        disposed = true
        clearInterval(timer)
        unsubscribe()
        vcs.dispose()
        subagents?.dispose()
        kimi.dispose()
        output.dispose()
      },
    }
    const output = mountOmo(ctx.ui, width => {
      const stale = Date.now() - checkedAt >= REFRESH_GRACE_MS
      const now = stale ? checkedAt : Date.now()
      const limits = options.rateLimits && instance.ctx.model?.provider === 'kimi-coding'
        ? kimi.readings(now, labels) : values.limits
      const sub = subagents?.snapshot
      let effectiveSession = values.session
      if (sub) {
        const reconciled = reconcileOmoSpawns(mainSpawns, sub.refusedTasks)
        const agents = unionSize(reconciled.agents, sub.taskIds)
        const foldedSkills = unionSkillCount(reconciled.skills, sub.skills)
        if (sub.tokens > 0 || sub.tools > 0 || agents !== values.session.counts.agents || foldedSkills > 0) {
          effectiveSession = {
            ...values.session,
            counts: {
              tokens: values.session.counts.tokens + sub.tokens,
              tools: values.session.counts.tools + sub.tools,
              agents,
              skills: values.session.counts.skills + foldedSkills,
            },
          }
        }
      }
      const line = render({
        v: { ...values, session: effectiveSession, limits, core: { ...values.core, columns: width, isWsl } },
        display: omoDisplay(effectiveSession),
        o: options, l: labels, t: theme, now,
      })
      return stale ? staleLine(line, width, { t: theme, l: labels, isWsl }) : line
    })
    const unsubscribe = options.rateLimits ? pi.onSubscriptionLimits(() => instance.update()) : () => {}
    const timer = setInterval(() => instance.update(), 1000)
    timer.unref()
    active = instance
    instance.update()
  }

  pi.on('session_start', (_event, ctx) => start(ctx))
  pi.on('session_shutdown', () => { treeTarget = undefined; stop() })
  const update: Handler = (_event, ctx) => {
    if (!active) return
    active.ctx = ctx
    active.update()
  }
  pi.on('session_before_tree', (event, ctx) => {
    treeTarget = undefined
    if (ctx.mode !== 'tui' || event === null || typeof event !== 'object' || !('preparation' in event)) return
    const preparation = event.preparation
    if (preparation !== null && typeof preparation === 'object'
      && 'targetId' in preparation && typeof preparation.targetId === 'string') treeTarget = preparation.targetId
  })
  pi.on('session_tree', (event, ctx) => {
    const target = treeTarget === undefined ? undefined : ctx.sessionManager.getEntry(treeTarget)
    treeTarget = undefined
    let isAssistantEdit = false
    if (target && event !== null && typeof event === 'object'
      && 'newLeafId' in event && typeof event.newLeafId === 'string' && event.newLeafId !== target.id) {
      const edited = ctx.sessionManager.getEntry(event.newLeafId)
      const originalMessage = target.message
      const editedMessage = edited?.message
      // A normal navigation selects an existing entry or appends a branch
      // summary. An assistant edit appends an assistant copy of the target
      // without a model request, preserving its usage (DESIGN, "OmO Native").
      if (target.type === 'message' && edited?.type === 'message'
        && originalMessage !== null && typeof originalMessage === 'object'
        && 'role' in originalMessage && originalMessage.role === 'assistant'
        && editedMessage !== null && typeof editedMessage === 'object'
        && 'role' in editedMessage && editedMessage.role === 'assistant') {
        isAssistantEdit = true
        pi.appendEntry(OMO_EDIT_ENTRY, { entryId: edited.id })
      }
    }
    if (!isAssistantEdit) active?.clearRate()
    update(event, ctx)
  })
  pi.on('session_compact', (event, ctx) => {
    active?.clearRate()
    update(event, ctx)
  })
  pi.on('message_start', (event, ctx) => {
    if (!active) return
    active.ctx = ctx
    active.messageStart(event)
  })
  pi.on('message_update', (event, ctx) => {
    if (!active) return
    active.ctx = ctx
    active.messageUpdate(event)
  })
  pi.on('message_end', (event, ctx) => {
    if (!active) return
    active.ctx = ctx
    active.messageEnd(event)
    active.update({ forceSubagents: true })
  })
  pi.on('model_select', (event, ctx) => {
    active?.modelSelected(event, ctx)
    update(event, ctx)
  })
  pi.on('thinking_level_select', update)
  pi.on('tool_execution_end', (_event, ctx) => {
    if (!active) return
    active.ctx = ctx
    active.update({ forceVcs: true, forceSubagents: true })
  })
  pi.registerCommand('vargus', {
    description: 'VArgus: on, off, status, or config JSON (saved in this session)',
    async handler(args, ctx) {
      if (ctx.mode !== 'tui') return
      const text = args.trim()
      const previous = ctx.sessionManager.reduceHistory(omoSettingsReducer)
      if (text === 'status' || text === '') {
        ctx.ui.notify(`VArgus is ${active ? 'on' : 'off'}. Native footer statuses are hidden while on.`, 'info')
        return
      }
      if (text === 'off' || text === 'on') {
        pi.appendEntry(OMO_CONFIG_ENTRY, { ...previous, enabled: text === 'on' })
        if (text === 'off') stop()
        else start(ctx)
        return
      }
      if (text.startsWith('config ')) {
        let given: Record<string, unknown>
        try { given = parseOptions(text.slice(7)) }
        catch {
          ctx.ui.notify('VArgus config must be a JSON object.', 'error')
          return
        }
        const overrides = { ...previous.options, ...given }
        // Persist the session's keys so other options still follow the file on reload.
        const options = Object.fromEntries(
          Object.entries(resolveOptions(overrides)).filter(([key]) => Object.hasOwn(overrides, key)),
        )
        pi.appendEntry(OMO_CONFIG_ENTRY, { enabled: previous.enabled, options })
        start(ctx)
        return
      }
      ctx.ui.notify('Usage: /vargus on|off|status|config {"theme":"graphite"}', 'info')
    },
  })
}
