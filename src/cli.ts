import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, mkdir, writeFile, readdir } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, createHash } from 'node:crypto'
import { once } from 'node:events'
import { TmuxOutput } from './outputs/tmux/client'
import { CodexCollector } from './hosts/codex/collect'
import { startBridge } from './hosts/codex/bridge'
import { readGit } from './hosts/codex/vcs'
import { claudeLaunch } from './hosts/claude/launch-node'
import { resolveOptions } from './options'
import { render } from './render'
import { makeTheme } from './theme'
import { en } from './i18n/en'
import { findRollout, RolloutReader } from './hosts/codex/rollout'
import { applicationTarget, type Target } from './outputs/tmux/target'
import { PaneInput } from './outputs/tmux/input'
import { savedFooter, restoreFooter, clearFooter, codexComposer, footerCommandError, type FooterSelection } from './hosts/codex/footer'

const HELP = `Usage:
  vargus on|off|status [--pane %ID] [--socket PATH] [--theme NAME] [--config FILE]
  vargus codex --tmux [--theme NAME] [--config FILE] -- [codex arguments]
  vargus claude --tmux [--theme NAME] [--config FILE] -- [claude arguments]
  vargus tmux-reset

The tmux row is opt-in. Standalone on/off hide/restore Codex's saved footer
through tmux /statusline commands. Leave the composer empty until they finish.
FILE is a JSON object of VArgus options; no saved host settings change.
Exit the wrapped CLI to restore the original tmux bar. After a crash, tmux-reset
cleans up an abandoned row when no wrapped session is still running.
`

// Only server-side configuration switches are copied to app-server. Model and
// working-directory overrides also travel in the TUI's normal thread requests.
export function codexServerArgs(args: string[]): { args: string[]; cwd: string } {
  const out: string[] = []
  let cwd = process.cwd()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--remote' || arg.startsWith('--remote=') || arg.startsWith('--remote-auth-token-env')) throw new Error('VArgus owns the local Codex transport; --remote is not supported.')
    if ((arg.startsWith('-p') && !arg.startsWith('--')) || arg === '--profile' || arg.startsWith('--profile=')) throw new Error('Codex --profile is not supported by this launcher yet; use -c overrides.')
    if (['-c', '--config', '--enable', '--disable'].includes(arg)) {
      const value = args[++i]
      if (value === undefined) throw new Error(`Missing value for ${arg}.`)
      out.push(arg, value)
    } else if (/^--(config|enable|disable)=/.test(arg)) out.push(arg)
    else if (arg.startsWith('-c') && arg.length > 2) out.push('-c', arg.slice(2))
    else if (arg === '-C' || arg === '--cd') cwd = resolve(args[++i] ?? cwd)
    else if (arg.startsWith('-C') && arg.length > 2) cwd = resolve(arg.slice(2))
    else if (arg.startsWith('--cd=')) cwd = resolve(arg.slice(5))
  }
  return { args: out, cwd }
}

function codexLine(collector: CodexCollector, o: ReturnType<typeof resolveOptions>, t: ReturnType<typeof makeTheme>) {
  let line: (width: number) => Promise<string>
      let gitAt = 0
      let gitCwd = ''
      let gitReading: Promise<void> | undefined
      line = async width => {
        const v = collector.snapshot()
        if (!v) return ''
        v.core.columns = width
        if (!gitReading && (v.core.cwd !== gitCwd || Date.now() >= gitAt)) {
          const cwd = v.core.cwd
          gitCwd = cwd
          const start = Date.now()
          gitReading = readGit(cwd).then(value => {
            if (v.core.cwd === cwd) v.vcs = value
          }).finally(() => {
            gitAt = Date.now() + Math.max(5000, (Date.now() - start) * 10)
            gitReading = undefined
          })
        }
        return render({ v, o, l: en, t, now: Date.now() })
      }
  return line
}

type Running = { pid: number; thread: string; target: Target; token: string }
type FooterBackup = { thread: string; target: Target; selection: FooterSelection }
const exec = promisify(execFile)
const controlRoot = () => join(tmpdir(), `vargus-control-${process.getuid?.() ?? 'user'}`)
const running = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const recordPath = (target: Target) => join(controlRoot(), createHash('sha256').update(target.socket + '\0' + target.pane).digest('hex') + '.json')
async function readRunning(file: string): Promise<Running | undefined> {
  try {
    const r = JSON.parse(await readFile(file, 'utf8')) as Running
    if (!running(r.pid)) return undefined
    // Do not signal an unrelated process after a PID has been reused.
    const args = (await exec('ps', ['-ww', '-p', String(r.pid), '-o', 'args='])).stdout
    return args.includes('__row') && args.includes(`"token":"${r.token}"`) ? r : undefined
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as any).code === 1) return undefined; throw error }
}


const footerRoot = () => join(controlRoot(), 'footers')
const footerPath = (target: Target, thread: string) => join(footerRoot(), createHash('sha256').update(JSON.stringify([target.socket, target.pane, target.pid, thread])).digest('hex') + '.json')
async function readFooter(file: string): Promise<FooterBackup | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')) as FooterBackup }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
async function changeFooter(target: Target, command: string): Promise<void> {
  const live = await applicationTarget('codex', target.socket, target.pane)
  if (live.pid !== target.pid) throw new Error('Footer automation stopped: the Codex process in this pane changed.')
  const input = new PaneInput(target)
  const after = await input.submit(command, codexComposer)
  if (footerCommandError(after.lines)) throw new Error('Footer command completion is inconclusive: a native statusline error remains visible. The saved backup is retained; row cleanup was skipped. Resolve the error and move it out of view before retrying.')
}

async function standalone(args: string[]): Promise<number> {
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
  // An existing explicit thread binding also makes off/status work after focus changes.
  const bindings = new Map<string, { target: Target; thread: string }>()
  if (thread && !pane && !socket) {
    for (const name of await readdir(controlRoot())) {
      if (!name.endsWith('.json')) continue
      const value = await readRunning(join(controlRoot(), name))
      if (value?.thread === thread) bindings.set(recordPath(value.target), value)
    }
    // A crashed helper must not lose the saved footer or make off unable to retry.
    for (const name of await readdir(footerRoot())) {
      const value = await readFooter(join(footerRoot(), name))
      if (value?.thread === thread && running(value.target.pid)) bindings.set(recordPath(value.target), value)
    }
  }
  if (bindings.size > 1) throw new Error('This thread has multiple rows; select one with --pane and --socket.')
  const existing = [...bindings.values()][0]
  if (action !== 'on' && !existing && !pane && !socket) {
    console.log('VArgus is off for this Codex thread.'); return 0
  }
  const target = existing?.target ?? await applicationTarget('codex', socket, pane)
  const file = recordPath(target)
  const current = await readRunning(file)
  const backupFile = thread ? footerPath(target, thread) : undefined
  let backup = backupFile ? await readFooter(backupFile) : undefined
  if (action === 'status') { console.log(current ? `VArgus is on in ${target.pane} (thread ${current.thread}).` : backup ? 'VArgus row is off; footer restoration is pending. Run !vargus off with an empty composer.' : 'VArgus is off.'); return 0 }
  if (action === 'off') {
    if (backup) {
      await changeFooter(target, restoreFooter(backup.selection))
      await rm(backupFile!, { force: true })
    } else if (!thread && current) throw new Error('Inside the Codex conversation, run !vargus off so its saved footer can be restored.')
  }
  if (action === 'on' && current?.thread === thread) {
    if (!backup) {
      backup = { target, thread: thread!, selection: await savedFooter(process.cwd()) }
      restoreFooter(backup.selection)
      await writeFile(backupFile!, JSON.stringify(backup), { mode: 0o600 })
    }
    await changeFooter(target, clearFooter)
    console.log(`VArgus is already on in ${target.pane}.`); return 0
  }
  if (current) {
    process.kill(current.pid, 'SIGTERM')
    const until = Date.now() + 6000
    while (await readRunning(file) && Date.now() < until) await new Promise(r => setTimeout(r, 50))
    if (await readRunning(file)) throw new Error('VArgus did not finish stopping; retry shortly.')
  }
  if (action === 'off') {
    if (!current) await new TmuxOutput(target.socket, target.pane).cleanupAbandoned()
    console.log('VArgus is off.'); return 0
  }
  const home = process.env.CODEX_HOME ?? join(homedir(), '.codex')
  const transcript = await findRollout(home, thread!)
  const newBackup = !backup
  if (!backup) {
    backup = { target, thread: thread!, selection: await savedFooter(process.cwd()) }
    // Validate the saved command before starting or hiding anything.
    restoreFooter(backup.selection)
    await writeFile(backupFile!, JSON.stringify(backup), { mode: 0o600 })
  }
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '__row', JSON.stringify({ target, thread, transcript, options, token: randomBytes(16).toString('hex') })], {
    detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, VARGUS_CLI_MAIN: '1' },
  })
  let errors = ''
  child.stderr!.on('data', chunk => { errors += String(chunk) })
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`VArgus startup timed out. ${errors}`)), 8000)
      child.once('error', reject)
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`VArgus could not start (${code}). ${errors}`)) })
      child.once('message', () => { clearTimeout(timer); resolve() })
    })
  } catch (error) { child.kill('SIGTERM'); if (newBackup) await rm(backupFile!, { force: true }); throw error }
  child.stderr!.destroy()
  child.disconnect(); child.unref()
  // Only a successfully attached row may hide the native footer. Keep the backup
  // on delivery failure so off can retry independently of the helper's lifetime.
  await changeFooter(target, clearFooter)
  console.log(`VArgus is on in ${target.pane}.`)
  return 0
}

async function rowWorker(spec: { target: Target; thread: string; transcript: string; options: Record<string, unknown>; token: string }): Promise<number> {
  const { target, thread } = spec
  const file = recordPath(target)
  const reader = new RolloutReader(spec.transcript, thread, process.cwd(), homedir())
  const options = resolveOptions({ ...spec.options, tmuxOutput: true })
  const line = codexLine(reader.collector, options, makeTheme(options.theme, !!process.env.NO_COLOR))
  const output = new TmuxOutput(target.socket, target.pane)
  let stop!: () => void, stopping = false
  const stopped = new Promise<void>(resolve => { stop = () => { stopping = true; resolve() } })
  process.on('SIGTERM', stop); process.on('SIGHUP', stop)
  let owned = false
  try {
    await reader.poll()
    await output.attach()
    await writeFile(file, JSON.stringify({ pid: process.pid, thread, target, token: spec.token }), { mode: 0o600 })
    owned = true
    await output.update(await line(await output.width()))
    process.send?.({ ready: true })
    while (!stopping && running(target.pid)) {
      await Promise.race([stopped, new Promise(r => setTimeout(r, 1000))])
      if (stopping || !running(target.pid)) break
      await reader.poll()
      await output.update(await line(await output.width()))
    }
    return 0
  } finally {
    try { await output.detach() } finally { if (owned) await rm(file, { force: true }) }
    process.off('SIGTERM', stop); process.off('SIGHUP', stop)
  }
}

export async function main(argv: string[]): Promise<number> {
  if (argv[0] === '--help' || !argv.length) { console.log(HELP); return 0 }
  if (['on', 'off', 'status'].includes(argv[0]!)) return standalone(argv)
  if (argv[0] === '__row') return rowWorker(JSON.parse(argv[1]!))
  const [host, ...rest] = argv
  if (host === 'tmux-reset') { await TmuxOutput.environment().reset(); return 0 }
  if (host !== 'codex' && host !== 'claude') throw new Error(HELP)
  const split = rest.indexOf('--')
  const flags = split < 0 ? rest : rest.slice(0, split)
  const args = split < 0 ? [] : rest.slice(split + 1)
  if (flags.includes('--help')) { console.log(HELP); return 0 }
  let enabled = false
  let given: Record<string, unknown> = {}
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]
    if (flag === '--tmux') enabled = true
    else if (flag === '--config') given = { ...given, ...JSON.parse(await readFile(flags[++i]!, 'utf8')) }
    else if (flag === '--theme') given.theme = flags[++i]
    else throw new Error(`Unknown VArgus option: ${flag}. Put CLI arguments after --.`)
  }
  if (!enabled) throw new Error('The tmux output is off by default. Add --tmux to enable it.')
  const o = resolveOptions({ ...given, tmuxOutput: true })
  const t = makeTheme(o.theme, !!process.env.NO_COLOR)
  const tmux = TmuxOutput.environment()
  const directory = await mkdtemp(join(tmpdir(), 'vargus-run-'))
  const runId = randomBytes(16).toString('hex')
  let child: ReturnType<typeof spawn> | undefined
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined
  let claude: ReturnType<typeof claudeLaunch> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let updating: Promise<void> | undefined
  let stop!: (code: number) => void
  const interrupted = new Promise<number>(resolve => { stop = resolve })
  const terminate = () => stop(143)
  const hangup = () => stop(129)
  // The foreground CLI handles Ctrl-C. VArgus must survive to restore tmux.
  const interrupt = () => {}
  process.on('SIGTERM', terminate)
  process.on('SIGHUP', hangup)
  process.on('SIGINT', interrupt)
  try {
    let line: (width: number) => Promise<string>
    let command: string
    let childArgs: string[]
    if (host === 'codex') {
      const server = codexServerArgs(args)
      const collector = new CodexCollector(server.cwd, homedir())
      command = 'codex'
      bridge = await startBridge({
        socket: join(directory, 'codex.sock'), command, args: server.args,
        env: process.env, cwd: server.cwd,
        client: message => collector.fromClient(message),
        server: message => collector.fromServer(message),
      })
      childArgs = ['--remote', bridge.endpoint, '-c', 'tui.status_line=[]', ...args]
      line = codexLine(collector, o, t)
    } else {
      command = 'claude'
      const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
      claude = claudeLaunch(root, args, runId, given)
      childArgs = claude.args
      line = () => claude!.line()
    }
    await tmux.attach()
    const update = async () => { await tmux.update(await line(await tmux.width())) }
    await update()
    timer = setInterval(() => {
      if (!updating) updating = update().catch(error => {
        console.error('VArgus row:', (error as Error).message)
      }).finally(() => { updating = undefined })
    }, 1000)
    child = spawn(command, childArgs, { stdio: 'inherit', env: { ...process.env, VARGUS_TMUX_RUN_ID: runId } })
    const exit = new Promise<number>((resolve, reject) => {
      child!.once('error', reject)
      child!.once('exit', (code, signal) => resolve(code ?? (signal ? 128 : 0)))
    })
    return await Promise.race([exit, interrupted, ...(bridge ? [bridge.failure] : [])])
  } finally {
    if (timer) clearInterval(timer)
    // Every resource gets its cleanup even if another cleanup fails. Keep the
    // host's exit status or original error, and report cleanup failures separately.
    const cleanup = async (name: string, action: () => Promise<unknown>) => {
      try { await action() } catch (error) {
        console.error(`VArgus cleanup (${name}):`, (error as Error).message)
      }
    }
    await cleanup('row refresh', async () => updating)
    await cleanup('CLI', async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exit = once(child, 'exit')
        child.kill('SIGTERM')
        const kill = setTimeout(() => child!.kill('SIGKILL'), 2000)
        try { await exit } finally { clearTimeout(kill) }
      }
    })
    await cleanup('Codex bridge', async () => bridge?.close())
    await cleanup('Claude alias', async () => claude?.close())
    await cleanup('tmux restore', () => tmux.detach())
    await cleanup('temporary files', () => rm(directory, { recursive: true, force: true }))
    process.off('SIGTERM', terminate)
    process.off('SIGHUP', hangup)
    process.off('SIGINT', interrupt)
  }
}

if (process.env.VARGUS_CLI_MAIN === '1') {
  main(process.argv.slice(2)).then(code => { process.exitCode = code }).catch(error => {
    console.error('VArgus:', (error as Error).message)
    process.exitCode = 1
  })
}
