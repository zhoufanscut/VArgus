import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { restoreFooter, clearFooter, codexComposer, footerCommandError, footerIdentity, FooterSettings } from '../../hosts/codex/footer.ts'
import { resolveCodexOptions } from '../../hosts/codex/options.ts'
import { RolloutReader } from '../../hosts/codex/rollout.ts'
import { Views, canHoldReadings, selectedView, type View, type ViewScreen } from '../../hosts/codex/views.ts'
import { TmuxOutput } from '../../outputs/tmux/client.ts'
import { PaneInput } from '../../outputs/tmux/input.ts'
import { applicationTarget } from '../../outputs/tmux/target.ts'
import { cleanText } from '../../render/text.ts'
import { makeTheme } from '../../theme/index.ts'
import { codexLine } from './line.ts'
import {
  backups, footerPath, json, recordPath, replyPath, requestPath, running, save,
  workerVersion, type FooterBackup, type Running, type Spec,
} from './state.ts'

type Request = { id: string; action: 'on' | 'off' }

export async function rowWorker(spec: Spec): Promise<number> {
  const { target, thread } = spec
  const file = recordPath(target), views = new Views(spec.home, thread, spec.transcript), input = new PaneInput(target)
  const output = new TmuxOutput(target.socket, target.pane)
  const options = resolveCodexOptions(spec.options), theme = makeTheme(options.theme, !!process.env.NO_COLOR)
  const readers = new Map<string, { reader: RolloutReader; line: ReturnType<typeof codexLine> }>()
  const suppressed = new Set<string>(), footerSettings = new FooterSettings()
  let mode = spec.mode, selected: string | undefined, error: string | undefined
  let stopping = false, attached = false, refreshAt = 0, renderAt = 0
  let lastConfirmed: string | undefined, readingError: string | undefined, published = ''
  let lastReadings: { thread: string; label: string; line: ReturnType<typeof codexLine> } | undefined
  let paused: Running['paused']
  let identity: 'first' | 'whole' | 'none' = 'none'
  let candidates: View[] = []
  const select = (screen: ViewScreen) => selectedView(screen, candidates, thread, identity)
  const stop = () => { stopping = true }
  process.on('SIGTERM', stop); process.on('SIGHUP', stop)
  const state = async (): Promise<Running> => ({ pid: process.pid, thread, transcript: spec.transcript, target, token: spec.token, version: workerVersion,
    reload: { version: 1, home: spec.home, options },
    mode, selected, paused, pending: (await backups(target)).length, error })
  const step = async () => {
    if (Date.now() >= refreshAt) {
      await views.refresh()
      if (mode === 'on') await footerSettings.preload(views.family().map(view => view.cwd))
      refreshAt = Date.now() + 1000
    }
    const saved = mode === 'restore' ? new Map((await backups(target)).map(backup => [backup.thread, backup.selection])) : undefined
    // A new root replaces the reader, but earlier footer backups still belong
    // to this TUI. Restore those views too; on-mode readings stay in one family.
    candidates = saved ? views.restoreCandidates(saved.keys()) : views.family()
    const layouts = saved ? [...saved.values()] : candidates.map(view => {
      try { return footerSettings.get(view.cwd) } catch { return undefined }
    })
    const identities = layouts.map(footerIdentity)
    identity = identities.length && identities.every(value => value !== 'none')
      ? identities.every(value => value === 'first') ? 'first' : 'whole' : 'none'
    const screen = await input.snapshot(), view = select(screen)
    const changed = selected !== view?.thread
    selected = view?.thread
    if (changed) readingError = undefined
    error = undefined
    if (view) {
      try {
        const backupFile = footerPath(target, view.thread)
        let backup = await json<FooterBackup>(backupFile)
        if ((mode === 'restore' && backup || mode === 'on' && !suppressed.has(view.thread)) && footerCommandError(screen.lines)) {
          throw new Error('Footer command completion is inconclusive: a native statusline error remains visible. Resolve it and move it out of view before retrying.')
        }
        if (mode === 'on' && !suppressed.has(view.thread) && codexComposer(screen, '')) {
          if (!backup) {
            const selection = footerSettings.get(view.cwd)
            restoreFooter(selection)
            backup = { target, thread: view.thread, selection }
            await save(backupFile, backup)
          }
          await change(clearFooter, view.thread)
          suppressed.add(view.thread)
        } else if (mode === 'restore' && backup && codexComposer(screen, '')) {
          await change(restoreFooter(backup.selection), view.thread)
          await rm(backupFile, { force: true })
          suppressed.delete(view.thread)
        } else if (mode === 'restore' && backup) {
          error = 'Footer restoration paused: leave the composer empty.'
        }
      } catch (e) { error = (e as Error).message }
    }
    if (!view) error = 'View identity is unknown; widen the pane or close the popup and leave the composer empty.'
    const hold = !!(lastReadings && !view && canHoldReadings(screen))
    if (mode !== 'on') paused = undefined
    if (mode === 'on' && (changed || Date.now() >= renderAt || hold !== !!paused)) {
      renderAt = Date.now() + 1000
      let line = ''
      paused = undefined
      if (view) {
        readingError = undefined
        try {
          let value = readers.get(view.thread)
          if (!value) {
            const reader = new RolloutReader(view.file, view.thread, view.cwd, homedir())
            value = { reader, line: codexLine(reader.collector, options, theme) }; readers.set(view.thread, value)
          }
          await value.reader.poll()
          line = await value.line(await output.width())
          if (line) lastReadings = { thread: view.thread, label: cleanText(view.path ?? 'main'), line: value.line }
        } catch (e) { readingError = (e as Error).message }
      } else if (hold) {
        const frozen = lastReadings!.line.paused(await output.width())
        if (frozen) {
          line = frozen
          paused = { thread: lastReadings!.thread, label: lastReadings!.label }
        }
      }
      // Release the row when there are no readings and the composer is empty.
      // Transient shell/popup frames must not discard a draft's saved readings.
      if (line) {
        if (!attached) { await output.attach(); attached = true }
        await output.update(line)
      } else if (attached && codexComposer(screen, '')) {
        await output.detach(); attached = false; lastReadings = undefined
      } else if (attached) await output.update('')
      // Thread switches rebuild the terminal surface. Redraw once at a confirmed
      // identity transition, rather than repainting the full client every poll.
      if (view && lastConfirmed !== view.thread) {
        await output.redraw()
        lastConfirmed = view.thread
      }
    }
    if (paused) error = `Readings paused from ${paused.label} (${paused.thread}); the current view is unknown.`
    error ??= readingError
    const value = await state(), serialized = JSON.stringify(value)
    if (serialized !== published) { await save(file, value); published = serialized }
  }
  const change = async (command: string, expected: string) => {
    const live = await applicationTarget('codex', target.socket, target.pane)
    if (live.pid !== target.pid) throw new Error('Footer automation stopped: the Codex process in this pane changed.')
    // Inserting a slash command can hide the contextual agent label. Its exact
    // draft and cursor must still match before Enter; empty-prompt checks bind
    // the operation to the selected view before insertion and after completion.
    const after = await input.submit(command, (screen, text) => codexComposer(screen, text) && (text !== '' || select(screen)?.thread === expected))
    if (footerCommandError(after.lines)) throw new Error('Footer command completion is inconclusive: a native statusline error remains visible. Saved restoration state is retained. Resolve the error and move it out of view before retrying.')
  }
  try {
    if (mode === 'on') { await output.attach(); attached = true }
    else await output.cleanupAbandoned()
    process.send?.({ stage: 'attached' })
    await step()
    process.send?.(await state())
    while (!stopping && running(target.pid)) {
      const request = await json<Request>(requestPath(spec))
      if (request) {
        await rm(requestPath(spec), { force: true })
        try {
          mode = request.action === 'on' ? 'on' : 'restore'
          readingError = undefined
          if (mode === 'on') {
            footerSettings.reset(); refreshAt = 0
            suppressed.clear(); renderAt = 0
            if (!attached) { await output.attach(); attached = true }
          } else if (attached) { await output.detach(); attached = false }
          await step()
          await save(replyPath(request.id), await state())
        } catch (e) { await save(replyPath(request.id), { ...await state(), failed: (e as Error).message }) }
      } else await step()
      if (mode === 'restore' && !(await backups(target)).length) break
      await delay(250)
    }
    return 0
  } finally {
    try { if (attached) await output.detach() } finally {
      await rm(file, { force: true }); await rm(requestPath(spec), { force: true })
      if (!running(target.pid)) for (const b of await backups(target)) await rm(footerPath(target, b.thread), { force: true })
    }
    process.off('SIGTERM', stop); process.off('SIGHUP', stop)
  }
}
