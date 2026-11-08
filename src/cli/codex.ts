import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, rm, mkdir, writeFile, readdir, rename } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { TmuxOutput } from '../outputs/tmux/client'
import { findRollout, RolloutReader } from '../hosts/codex/rollout'
import { Views } from '../hosts/codex/views'
import { applicationTarget, type Target } from '../outputs/tmux/target'
import { PaneInput } from '../outputs/tmux/input'
import { savedFooter, restoreFooter, clearFooter, codexComposer, footerCommandError, FooterSettings, type FooterSelection } from '../hosts/codex/footer'
import { resolveOptions } from '../options'
import { makeTheme } from '../theme'
import { codexLine } from './line'
import { withControlLock } from './lock'

type Running = { pid: number; thread: string; target: Target; token: string; version?: number;
  mode?: 'on' | 'restore'; selected?: string; pending?: number; error?: string }
type FooterBackup = { thread: string; target: Target; selection: FooterSelection }
type Spec = { target: Target; thread: string; transcript: string; home: string;
  options: Record<string, unknown>; token: string; mode: 'on' | 'restore' }
type Request = { id: string; action: 'on' | 'off' }
const exec = promisify(execFile)
const controlRoot = () => join(tmpdir(), `vargus-control-${process.getuid?.() ?? 'user'}`)
const running = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const recordPath = (target: Target) => join(controlRoot(), createHash('sha256').update(target.socket + '\0' + target.pane).digest('hex') + '.json')
const footerRoot = () => join(controlRoot(), 'footers')
const footerPath = (target: Target, thread: string) => join(footerRoot(), createHash('sha256').update(JSON.stringify([target.socket, target.pane, target.pid, thread])).digest('hex') + '.json')
const requestPath = (r: { token: string }) => join(controlRoot(), r.token + '.request')
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
    const args = (await exec('ps', ['-ww', '-p', String(r.pid), '-o', 'args='])).stdout
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
  process.kill(current.pid, 'SIGTERM')
  const until = Date.now() + 6000
  while (await readRunning(recordPath(current.target)) && Date.now() < until) await delay(50)
  if (await readRunning(recordPath(current.target))) throw new Error('VArgus did not finish stopping; retry shortly.')
}
async function request(current: Running, action: 'on' | 'off'): Promise<Running> {
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

export async function standalone(args: string[]): Promise<number> {
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
  const thread = process.env.CODEX_THREAD_ID
  if (action === 'on' && !thread) throw new Error('Inside Codex, run !vargus on. CODEX_THREAD_ID identifies the conversation.')
  await mkdir(footerRoot(), { recursive: true, mode: 0o700 })
  const bindings = new Map<string, { target: Target; thread: string }>()
  if (thread && !pane && !socket) {
    for (const name of await readdir(controlRoot())) {
      if (!name.endsWith('.json')) continue
      const value = await readRunning(join(controlRoot(), name))
      if (value?.thread === thread) bindings.set(recordPath(value.target), value)
    }
    for (const name of await readdir(footerRoot())) {
      const value = await json<FooterBackup>(join(footerRoot(), name))
      if (value?.thread === thread && running(value.target.pid)) bindings.set(recordPath(value.target), value)
    }
  }
  if (bindings.size > 1) throw new Error('This thread has multiple rows; select one with --pane and --socket.')
  const existing = [...bindings.values()][0]
  if (action !== 'on' && !existing && !pane && !socket) {
    console.log('VArgus is off for this Codex thread.'); return 0
  }
  const target = existing?.target ?? await applicationTarget('codex', socket, pane)
  let current = await readRunning(recordPath(target))
  if (current && !sameTarget(current.target, target)) { await stopWorker(current); current = undefined }
  if (action === 'status') {
    console.log(current ? description(current) : (await backups(target)).length ? 'VArgus is off; footer restoration is pending. Run !vargus off.' : 'VArgus is off.')
    return 0
  }
  if (current && ((action === 'off' && (current.version === 2 || current.version === 3)) || (current.version === 3 && current.thread === thread))) {
    const reply = await request(current, action as 'on' | 'off')
    console.log(action === 'on' ? `VArgus is already on in ${target.pane}.${reply.error ? ' ' + reply.error : ''}` : description(reply))
    return 0
  }
  const home = process.env.CODEX_HOME ?? join(homedir(), '.codex')
  const saved = await backups(target)
  const root = thread ?? current?.thread ?? saved[0]?.thread
  if (!root) { await new TmuxOutput(target.socket, target.pane).cleanupAbandoned(); console.log('VArgus is off.'); return 0 }
  // Validate history before replacing a live worker or changing any footer.
  const transcript = await findRollout(home, root)
  const file = footerPath(target, root)
  const newBackup = action === 'on' && !await json(file)
  if (newBackup) {
    const selection = await savedFooter(process.cwd())
    restoreFooter(selection)
    await save(file, { target, thread: root, selection })
  }
  if (current) await stopWorker(current)
  const spec: Spec = { target, thread: root, transcript, home, options, token: randomBytes(16).toString('hex'), mode: action === 'on' ? 'on' : 'restore' }
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '__row', JSON.stringify(spec)], {
    detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, VARGUS_CLI_MAIN: '1' },
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
    console.log(action === 'on' ? `VArgus is on in ${target.pane}.${reply.error ? ' ' + reply.error : ''}` : description(reply))
  } catch (error) {
    child.kill('SIGTERM')
    if (newBackup && !attached) await rm(file, { force: true })
    throw error
  } finally { child.stderr!.destroy(); if (child.connected) child.disconnect(); child.unref() }
  return 0
}

export async function rowWorker(spec: Spec): Promise<number> {
  const { target, thread } = spec
  const file = recordPath(target), views = new Views(spec.home, thread), input = new PaneInput(target)
  const output = new TmuxOutput(target.socket, target.pane)
  const options = resolveOptions({ ...spec.options, tmuxOutput: true }), theme = makeTheme(options.theme, !!process.env.NO_COLOR)
  const readers = new Map<string, { reader: RolloutReader; line: ReturnType<typeof codexLine> }>()
  const suppressed = new Set<string>(), footerSettings = new FooterSettings()
  let mode = spec.mode, selected: string | undefined, error: string | undefined
  let stopping = false, attached = false, refreshAt = 0, renderAt = 0
  let lastConfirmed: string | undefined, readingError: string | undefined, published = ''
  const stop = () => { stopping = true }
  process.on('SIGTERM', stop); process.on('SIGHUP', stop)
  const state = async (): Promise<Running> => ({ pid: process.pid, thread, target, token: spec.token, version: 3,
    mode, selected, pending: (await backups(target)).length, error })
  const step = async () => {
    if (Date.now() >= refreshAt) {
      await views.refresh()
      if (mode === 'on') await footerSettings.preload(views.family().map(view => view.cwd))
      refreshAt = Date.now() + 1000
    }
    const screen = await input.snapshot(), view = views.selected(screen)
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
    if (mode === 'on' && (changed || Date.now() >= renderAt)) {
      renderAt = Date.now() + 1000
      let line = ''
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
        } catch (e) { readingError = (e as Error).message }
      }
      await output.update(line)
      // Thread switches rebuild the terminal surface. Redraw once at a confirmed
      // identity transition, rather than repainting the full client every poll.
      if (view && lastConfirmed !== view.thread) {
        await output.redraw()
        lastConfirmed = view.thread
      }
    }
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
    const after = await input.submit(command, (screen, text) => codexComposer(screen, text) && (text !== '' || views.selected(screen)?.thread === expected))
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
