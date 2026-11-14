import { homedir, release } from 'node:os'
import { collectOmo, omoSettingsReducer, OMO_EDIT_ENTRY } from './collect.ts'
import type { AccountLimits, NativeContext, SessionEntry } from './contracts.ts'
import { OmoVcs } from './vcs.ts'
import { OmoKimi, type ProviderAuth } from './kimi.ts'
import { mountOmo, type OmoUi } from '../../outputs/omo.ts'
import { resolveOptions } from '../../options.ts'
import { resolveLabels } from '../../i18n/index.ts'
import { makeTheme } from '../../theme/index.ts'
import { render } from '../../render/index.ts'

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

export default function vargus(pi: OmoApi): void {
  let active: { ctx: Context; stop(): void; update(forceGit?: boolean): void } | undefined
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
    const options = resolveOptions(settings.options)
    const vcs = new OmoVcs()
    const kimi = new OmoKimi(() => instance.ctx.modelRegistry.getProviderAuth('kimi-coding'))
    const theme = makeTheme(options.theme, process.env.NO_COLOR !== undefined)
    const labels = resolveLabels('en')
    const isWsl = Boolean(process.env.WSL_DISTRO_NAME || process.env.WSLENV || /microsoft/i.test(release()))
    let disposed = false
    let values = collectOmo(ctx, options.rateLimits ? pi.getSubscriptionLimits() : [], homedir(), Date.now())
    const output = mountOmo(ctx.ui, width => render({
      v: { ...values, core: { ...values.core, columns: width, isWsl } },
      o: options, l: labels, t: theme, now: Date.now(),
    }))
    const instance = {
      ctx,
      update(forceGit = false) {
        if (disposed) return
        const current = instance.ctx
        values = collectOmo(current, options.rateLimits ? pi.getSubscriptionLimits() : [], homedir(), Date.now())
        if (options.rateLimits) {
          void kimi.refresh(current.model?.provider).then(() => {
            if (disposed || instance.ctx.model?.provider !== 'kimi-coding') return
            values.limits = kimi.values
            output.refresh()
          })
          if (current.model?.provider === 'kimi-coding') values.limits = kimi.values
        }
        values.vcs = vcs.values
        output.refresh()
        if (options.repo || options.branch || options.status) {
          void vcs.refresh(current.cwd, options.detachedHead, Date.now(), forceGit).then(reading => {
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
        kimi.dispose()
        output.dispose()
      },
    }
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
        pi.appendEntry(OMO_EDIT_ENTRY, { entryId: edited.id })
      }
    }
    update(event, ctx)
  })
  pi.on('session_compact', update)
  pi.on('message_end', update)
  pi.on('model_select', update)
  pi.on('thinking_level_select', update)
  pi.on('tool_execution_end', (_event, ctx) => {
    if (!active) return
    active.ctx = ctx
    active.update(true)
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
        pi.appendEntry('vargus-settings', { ...previous, enabled: text === 'on' })
        if (text === 'off') stop()
        else start(ctx)
        return
      }
      if (text.startsWith('config ')) {
        let given: unknown
        try { given = JSON.parse(text.slice(7)) }
        catch (error) {
          if (!(error instanceof SyntaxError)) throw error
          ctx.ui.notify('VArgus config must be a JSON object.', 'error')
          return
        }
        if (given === null || typeof given !== 'object' || Array.isArray(given)) {
          ctx.ui.notify('VArgus config must be a JSON object.', 'error')
          return
        }
        const options = resolveOptions({ ...previous.options, ...given })
        pi.appendEntry('vargus-settings', { enabled: previous.enabled, options })
        start(ctx)
        return
      }
      ctx.ui.notify('Usage: /vargus on|off|status|config {"theme":"graphite"}', 'info')
    },
  })
}
