import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { rm, mkdir, writeFile, readdir, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { savedFooter, restoreFooter, footerIdentity } from '../../hosts/codex/footer.ts'
import { resolveCodexOptions, workerOptions } from '../../hosts/codex/options.ts'
import { readCheckoutOptions, readOptionsFile } from '../../node/options.ts'
import { findRollout, RolloutReader } from '../../hosts/codex/rollout.ts'
import { TmuxOutput } from '../../outputs/tmux/client.ts'
import { applicationArguments } from '../../outputs/tmux/process.ts'
import { applicationTarget, type Target } from '../../outputs/tmux/target.ts'
import { withControlLock } from '../lock.ts'
import { startupControl, startupTarget, hasStartupState, startupSuppressed } from './startup.ts'
import {
  backups, controlRoot, footerPath, footerRoot, json, recordPath, replyPath, requestPath, running,
  sameTarget, save, workerVersion, type FooterBackup, type Running, type Spec,
} from './state.ts'

type Recovery = { version: 1; spec: Spec }
const recoveryPath = (target: Target) => recordPath(target) + '.reload'

async function readRunning(file: string): Promise<Running | undefined> {
  const r = await json<Running>(file)
  if (!r || !running(r.pid)) return
  // Retain the original token check when migrating a pre-follow worker.
  try {
    const args = await applicationArguments(r.pid)
    return args.includes('__row') && args.includes(`"token":"${r.token}"`) ? r : undefined
  } catch (error) { if ((error as any).code !== 1) throw error }
}

export async function stopWorker(current: Running, termTimeoutMs = 6000, killTimeoutMs = 2000): Promise<void> {
  const file = recordPath(current.target)
  const check = async (): Promise<boolean> => {
    const live = await readRunning(file)
    if (!live) return false
    if (live.pid !== current.pid || live.token !== current.token) {
      throw new Error('VArgus helper changed before it could be stopped; retry.')
    }
    return true
  }
  const signal = async (sig: 'SIGTERM' | 'SIGKILL', timeoutMs: number): Promise<boolean> => {
    try { process.kill(current.pid, sig) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      return false
    }
    const until = Date.now() + timeoutMs
    while (await check()) {
      if (Date.now() >= until) return true
      await delay(50)
    }
    return false
  }
  if (!await check()) return
  if (await signal('SIGTERM', termTimeoutMs) && await check() && await signal('SIGKILL', killTimeoutMs)) {
    throw new Error('VArgus did not finish stopping; retry shortly.')
  }
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
    else if (flag === '--config') options = { ...options, ...readOptionsFile(value) }
    else throw new Error(`Unknown VArgus option: ${flag}.`)
  }
  const checkout = action === 'on' || action === 'reload' ? readCheckoutOptions() : {}
  if (automatic && !resolveCodexOptions({ ...checkout, ...options }).codexAutoStart) return 0
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
      options: current.reload!.options, overrideKeys: current.reload!.overrideKeys, mode: current.mode!, token: current.token } : recovery!.spec
    if (!current && recovery?.version !== 1) throw new Error('Reload stopped: unsupported recovery metadata. Run !vargus off, then on with your options.')
    if (!sameTarget(retained.target, target) || retained.home !== home) throw new Error('Reload stopped: saved helper binding or CODEX_HOME differs.')
    // Resolve and replay before stopping a healthy helper. Readings are rebuilt by
    // the replacement, and the saved footer backups remain independently owned.
    const transcript = await findRollout(home, retained.thread)
    await new RolloutReader(transcript, retained.thread, process.cwd(), homedir()).poll()
    // Off admission records intent before delivery; cancellation can leave the
    // old helper on. Preserve that intent in both replacement and retry state.
    const mode = migrating ? 'on' : await startupSuppressed(home, target, retained.thread) ? 'restore' : retained.mode
    const spec: Spec = { ...retained, mode, transcript, ...workerOptions(checkout, options, retained), token: randomBytes(16).toString('hex') }
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
  let retainedOptions = action === 'off' ? current?.reload : undefined
  if (current && ((action === 'off' && (!thread || current.thread === thread) && [2, 3, 4, 5, 6, workerVersion].includes(current.version!)) || (current.version === workerVersion && current.thread === thread && current.transcript === requestedTranscript))) {
    const reply = await request(current, action as 'on' | 'off')
    if (reply) {
      console.log(action === 'on' ? `VArgus is already on in ${target.pane}.${reply.error ? ' ' + reply.error : ''}` : description(reply))
      return 0
    }
    // Restoration can finish after on has read the worker but before it reads
    // the request. Continue normal startup under the same pane admission lock.
    retainedOptions = current.reload
    await rm(requestPath(current), { force: true })
    current = undefined
  }
  const saved = await backups(target)
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
  const base = action === 'off' && retainedOptions ? retainedOptions.options : checkout
  const spec: Spec = { target, thread: root, transcript, home, ...workerOptions(base, options, retainedOptions), token: randomBytes(16).toString('hex'), mode: action === 'on' ? 'on' : 'restore' }
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
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../cli.ts', import.meta.url)), '__row', JSON.stringify(spec)], {
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
