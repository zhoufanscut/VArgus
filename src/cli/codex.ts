import { spawn } from 'node:child_process'
import { readFile, rm, mkdir, writeFile, readdir, rename } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { TmuxOutput } from '../outputs/tmux/client.ts'
import { findRollout, RolloutReader } from '../hosts/codex/rollout.ts'
import { Views, hiddenDraft, selectedView, type View, type ViewScreen } from '../hosts/codex/views.ts'
import { applicationTarget, type Target } from '../outputs/tmux/target.ts'
import { PaneInput } from '../outputs/tmux/input.ts'
import { savedFooter, restoreFooter, clearFooter, codexComposer, footerCommandError, footerIdentity, FooterSettings, type FooterSelection } from '../hosts/codex/footer.ts'
import { resolveOptions } from '../options.ts'
import { makeTheme } from '../theme/index.ts'
import { codexLine } from './line.ts'
import { withControlLock } from './lock.ts'
import { startupControl, startupTarget, hasStartupState, startupSuppressed } from './startup.ts'
import { cleanText } from '../render/text.ts'
import { applicationArguments } from '../outputs/tmux/process.ts'

type Running = { pid: number; thread: string; transcript?: string; target: Target; token: string; version?: number;
  mode?: 'on' | 'restore'; selected?: string; pending?: number; error?: string;
  paused?: { thread: string; label: string };
  reload?: { version: 1; home: string; options: Record<string, unknown> } }
type FooterBackup = { thread: string; target: Target; selection: FooterSelection }
type Spec = { target: Target; thread: string; transcript: string; home: string;
  options: Record<string, unknown>; token: string; mode: 'on' | 'restore' }
type Recovery = { version: 1; spec: Spec }
type Request = { id: string; action: 'on' | 'off' }
const workerVersion = 7
const controlRoot = () => join(tmpdir(), `vargus-control-${process.getuid?.() ?? 'user'}`)
const running = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const recordPath = (target: Target) => join(controlRoot(), createHash('sha256').update(target.socket + '\0' + target.pane).digest('hex') + '.json')
const footerRoot = () => join(controlRoot(), 'footers')
const footerPath = (target: Target, thread: string) => join(footerRoot(), createHash('sha256').update(JSON.stringify([target.socket, target.pane, target.pid, thread])).digest('hex') + '.json')
const requestPath = (r: { token: string }) => join(controlRoot(), r.token + '.request')
const recoveryPath = (target: Target) => recordPath(target) + '.reload'
const replyPath = (id: string) => join(controlRoot(), id + '.reply')
const sameTarget = (a: Target, b: Target) => a.socket === b.socket && a.pane === b.pane && a.pid === b.pid
async function json<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
}
async function save(file: string, value: unknown): Promise<void> {
  const temporary = file + '.' + process.pid + '.tmp'
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
  await rename(temporary, file)
}
async function readRunning(file: string): Promise<Running | undefined> {
  const r = await json<Running>(file)
  if (!r || !running(r.pid)) return
  // Retain the original token check when migrating a pre-follow worker.
  try {
    const args = await applicationArguments(r.pid)
    return args.includes('__row') && args.includes(`"token":"${r.token}"`) ? r : undefined
  } catch (error) { if ((error as any).code !== 1) throw error }
}
async function backups(target: Target): Promise<FooterBackup[]> {
  const result: FooterBackup[] = []
  for (const name of await readdir(footerRoot())) {
    if (!name.endsWith('.json')) continue
    const b = await json<FooterBackup>(join(footerRoot(), name))
    if (b && sameTarget(b.target, target)) result.push(b)
  }
  return result
}
async function stopWorker(current: Running): Promise<void> {
  const live = await readRunning(recordPath(current.target))
  if (!live) return
  if (live.pid !== current.pid || live.token !== current.token) throw new Error('VArgus helper changed before it could be stopped; retry.')
  process.kill(current.pid, 'SIGTERM')
  const until = Date.now() + 6000
  while (await readRunning(recordPath(current.target)) && Date.now() < until) await delay(50)
  if (await readRunning(recordPath(current.target))) throw new Error('VArgus did not finish stopping; retry shortly.')
}
async function request(current: Running, action: 'on' | 'off'): Promise<Running | undefined> {
  const id = randomBytes(16).toString('hex'), path = requestPath(current)
  const lock = path + '.lock'
  return withControlLock(lock, async () => {
    const until = Date.now() + 12000
    try {
      // Publish a complete request; the worker is the sole writer of runtime state.
      const temporary = path + '.' + id
      await writeFile(temporary, JSON.stringify({ id, action }), { mode: 0o600 })
      await rename(temporary, path)
      const completed = async () => {
        const reply = await json<Running & { failed?: string }>(replyPath(id))
        if (reply?.failed) throw new Error(reply.failed)
        return reply
      }
      while (Date.now() < until) {
        const reply = await completed()
        if (reply) return reply
        if (!await readRunning(recordPath(current.target))) {
          // A restore helper can acknowledge and exit between the two reads.
          const final = await completed()
          if (final) return final
          if (action === 'on') return
          throw new Error('VArgus helper exited before confirming the control; retry.')
        }
        await delay(50)
      }
      throw new Error('VArgus control timed out; inspect !vargus status before retrying.')
    } finally { await rm(replyPath(id), { force: true }) }
  })
}
function description(r: Running): string {
  if (r.mode === 'restore') return `VArgus is off; ${r.pending ?? 0} footer(s) pending restoration on next visit.${r.error ? ' ' + r.error : ''}`
  return `VArgus is on in ${r.target.pane} (thread ${r.selected ?? 'unknown'}).${r.error ? ' ' + r.error : ''}`
}

export async function standalone(args: string[], automatic = false): Promise<number> {
  const [action, ...flags] = args
  let socket: string | undefined, pane: string | undefined
  let options: Record<string, unknown> = {}
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!, value = flags[++i]
    if (value === undefined) throw new Error(`Missing value for ${flag}.`)
    if (flag === '--pane') pane = value
    else if (flag === '--socket') socket = value
    else if (flag === '--theme') options.theme = value
    else if (flag === '--config') options = { ...options, ...JSON.parse(await readFile(value, 'utf8')) }
    else throw new Error(`Unknown VArgus option: ${flag}.`)
  }
  if (automatic && !resolveOptions(options).codexAutoStart) return 0
  const thread = process.env.CODEX_THREAD_ID
  const home = process.env.CODEX_HOME ?? join(homedir(), '.codex')
  if (action === 'on' && !thread) throw new Error('Inside Codex, run !vargus on. CODEX_THREAD_ID identifies the conversation.')
  await mkdir(footerRoot(), { recursive: true, mode: 0o700 })
  const bindings = new Map<string, { target: Target; thread: string }>()
  if (thread && !pane && !socket) {
    for (const name of await readdir(controlRoot())) {
      if (name.endsWith('.json.reload')) {
        const value = (await json<Recovery>(join(controlRoot(), name)))?.spec
        if (value?.thread === thread && running(value.target.pid)) bindings.set(recordPath(value.target), value)
      }
      if (!name.endsWith('.json')) continue
      const value = await readRunning(join(controlRoot(), name))
      if (value?.thread === thread) bindings.set(recordPath(value.target), value)
    }
    for (const name of await readdir(footerRoot())) {
      if (!name.endsWith('.json')) continue
      const value = await json<FooterBackup>(join(footerRoot(), name))
      if (value?.thread === thread && running(value.target.pid)) bindings.set(recordPath(value.target), value)
    }
  }
  if (bindings.size > 1) throw new Error('This thread has multiple rows; select one with --pane and --socket.')
  const existing = [...bindings.values()][0]
  if (action !== 'on' && !existing && !pane && !socket) {
    // Off can arrive before the first automatic attachment. Once opted in,
    // remember that intent even though no worker/backup exists to find yet.
    if (action === 'off' && thread && await hasStartupState(home)) {
      const target = await startupTarget(thread) ?? await applicationTarget('codex')
      await startupControl(home, target, thread, 'off', false, async () => 0)
    }
    console.log('VArgus is off for this Codex thread.'); return 0
  }
  const target = existing?.target ?? await applicationTarget('codex', socket, pane)
  const automaticSelection = automatic ? await savedFooter(process.cwd()) : undefined
  const automaticIdentity = footerIdentity(automaticSelection)
  if (automatic && automaticIdentity === 'none') return 0
  const perform = async () => {
  let current = await readRunning(recordPath(target))
  const migrating = action === 'on' && current && current.version !== workerVersion &&
    current.thread === thread && current.reload?.version === 1
  if (action === 'reload' || migrating) {
    const live = await applicationTarget('codex', target.socket, target.pane)
    if (!sameTarget(live, target) || current && !sameTarget(current.target, target)) throw new Error('Reload stopped: the Codex process in this pane changed.')
    const recovery = await json<Recovery>(recoveryPath(target))
    if (!current && !recovery) { console.log('No verified standalone helper; nothing to reload.'); return 0 }
    if (current && (current.reload?.version !== 1 || !current.transcript || !current.mode)) {
      throw new Error('This older helper has no reload options metadata. It is still running. Run !vargus off, then !vargus on with your original --config/--theme options once to enable reload.')
    }
    const retained: Spec = current ? { target, thread: current.thread, transcript: current.transcript!, home: current.reload!.home,
      options: current.reload!.options, mode: current.mode!, token: current.token } : recovery!.spec
    if (!current && recovery?.version !== 1) throw new Error('Reload stopped: unsupported recovery metadata. Run !vargus off, then on with your options.')
    if (!sameTarget(retained.target, target) || retained.home !== home) throw new Error('Reload stopped: saved helper binding or CODEX_HOME differs.')
    // Resolve and replay before stopping a healthy helper. Readings are rebuilt by
    // the replacement, and the saved footer backups remain independently owned.
    const transcript = await findRollout(home, retained.thread)
    await new RolloutReader(transcript, retained.thread, process.cwd(), homedir()).poll()
    // Off admission records intent before delivery; cancellation can leave the
    // old helper on. Preserve that intent in both replacement and retry state.
    const mode = migrating ? 'on' : await startupSuppressed(home, target, retained.thread) ? 'restore' : retained.mode
    const spec: Spec = { ...retained, mode, transcript, options: resolveOptions({ ...retained.options, ...options }), token: randomBytes(16).toString('hex') }
    await save(recoveryPath(target), { version: 1, spec } satisfies Recovery)
    if (current) await stopWorker(current)
    try {
      const reply = await startWorker(spec)
      await rm(recoveryPath(target), { force: true })
      console.log(`VArgus helper ${migrating ? 'upgraded' : 'reloaded'}. ${description(reply)}`)
    } catch (error) {
      await new TmuxOutput(target.socket, target.pane).cleanupAbandoned()
      throw new Error(`Reload could not start the replacement: ${(error as Error).message} Footer backups and reload options are retained. Retry !vargus reload; !vargus off restores the footer.`)
    }
    return 0
  }
  if (current && !sameTarget(current.target, target)) { await stopWorker(current); current = undefined }
  if (action === 'status') {
    console.log(current ? description(current) : (await backups(target)).length ? 'VArgus is off; footer restoration is pending. Run !vargus off.' : 'VArgus is off.')
    return 0
  }
  const requestedTranscript = action === 'on' ? await findRollout(home, thread!, process.env.VARGUS_CODEX_TRANSCRIPT) : undefined
  await rm(recoveryPath(target), { force: true })
  if (current && ((action === 'off' && (!thread || current.thread === thread) && [2, 3, 4, 5, 6, workerVersion].includes(current.version!)) || (current.version === workerVersion && current.thread === thread && current.transcript === requestedTranscript))) {
    const reply = await request(current, action as 'on' | 'off')
    if (reply) {
      console.log(action === 'on' ? `VArgus is already on in ${target.pane}.${reply.error ? ' ' + reply.error : ''}` : description(reply))
      return 0
    }
    // Restoration can finish after on has read the worker but before it reads
    // the request. Continue normal startup under the same pane admission lock.
    options = { ...current.reload?.options, ...options }
    await rm(requestPath(current), { force: true })
    current = undefined
  }
  const saved = await backups(target)
  const retainedOptions = action === 'off' ? current?.reload?.options : undefined
  const root = thread ?? current?.thread ?? saved[0]?.thread
  if (!root) { await new TmuxOutput(target.socket, target.pane).cleanupAbandoned(); console.log('VArgus is off.'); return 0 }
  // Off must release abandoned row ownership even when history cannot be read.
  // Keep backups for a later retry; unknown views must not receive footer keys.
  if (action === 'off') {
    if (current) { await stopWorker(current); current = undefined }
    await new TmuxOutput(target.socket, target.pane).cleanupAbandoned()
  }
  let transcript: string
  try { transcript = requestedTranscript ?? await findRollout(home, root) }
  catch (error) {
    if (action !== 'off') throw error
    console.log(`VArgus is off; ${saved.length} footer(s) pending restoration. Cannot read the saved transcript: ${(error as Error).message} Restore through /statusline or restart Codex; retry off when the transcript is available.`)
    return 0
  }
  const file = footerPath(target, root)
  const newBackup = action === 'on' && !await json(file)
  if (newBackup) {
    const selection = automatic ? automaticSelection! : await savedFooter(process.cwd())
    restoreFooter(selection)
    await save(file, { target, thread: root, selection })
  }
  if (current) await stopWorker(current)
  const spec: Spec = { target, thread: root, transcript, home, options: resolveOptions({ ...retainedOptions, ...options }), token: randomBytes(16).toString('hex'), mode: action === 'on' ? 'on' : 'restore' }
  try {
    const reply = await startWorker(spec)
    console.log(action === 'on' ? `VArgus is on in ${target.pane}.${reply.error ? ' ' + reply.error : ''}` : description(reply))
  } catch (error) {
    if (newBackup && !(error as Error & { attached?: boolean }).attached) await rm(file, { force: true })
    throw error
  }
  return 0
  }
  return startupControl(home, target, thread, action!, automatic,
    () => action === 'status' ? perform() : withControlLock(recordPath(target) + '.control', perform),
    automaticIdentity === 'first')
}

async function startWorker(spec: Spec): Promise<Running> {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../cli.ts', import.meta.url)), '__row', JSON.stringify(spec)], {
    detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, VARGUS_CLI_MAIN: '1' },
  })
  let errors = '', attached = false
  child.stderr!.on('data', chunk => { errors += String(chunk) })
  try {
    const reply = await new Promise<Running>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`VArgus startup timed out. ${errors}`)), 12000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`VArgus could not start (${code}). ${errors}`)) })
      child.on('message', value => { attached = true; if ((value as any).stage === 'attached') return; clearTimeout(timer); resolve(value as Running) })
    })
    return reply
  } catch (error) {
    // Wait for detach/runtime cleanup before a retry can acquire the pane lock.
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
      try { await exited } finally { clearTimeout(timer) }
    }
    ;(error as Error & { attached?: boolean }).attached = attached
    throw error
  } finally { child.stderr!.destroy(); if (child.connected) child.disconnect(); child.unref() }
}

export async function rowWorker(spec: Spec): Promise<number> {
  const { target, thread } = spec
  const file = recordPath(target), views = new Views(spec.home, thread, spec.transcript), input = new PaneInput(target)
  const output = new TmuxOutput(target.socket, target.pane)
  const options = resolveOptions(spec.options), theme = makeTheme(options.theme, !!process.env.NO_COLOR)
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
    const hold = !!(lastReadings && !view && hiddenDraft(screen))
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
