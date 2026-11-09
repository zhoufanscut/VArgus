import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { codexLine } from './cli/line'
import { standalone, rowWorker } from './cli/codex'
import { hook } from './cli/hooks'
import { TmuxOutput } from './outputs/tmux/client'
import { CodexCollector } from './hosts/codex/collect'
import { startBridge } from './hosts/codex/bridge'
import { claudeLaunch } from './hosts/claude/launch-node'
import { resolveOptions } from './options'
import { makeTheme } from './theme'

const HELP = `Usage:
  vargus on|off|status|reload [--pane %ID] [--socket PATH] [--theme NAME] [--config FILE]
  vargus hook session-start|prompt --config FILE [--pane %ID] [--socket PATH]
  vargus codex --tmux [--theme NAME] [--config FILE] -- [codex arguments]
  vargus claude --tmux [--theme NAME] [--config FILE] -- [claude arguments]
  vargus tmux-reset

The tmux row is opt-in. Standalone on/off hide/restore Codex's saved footer
through tmux /statusline commands. Off removes the row; inactive views restore
on their next empty-composer visit. The helper exits after restoration or TUI exit.
FILE is a JSON object of VArgus options; no saved host settings change.
After rebuilding, reload replaces the standalone helper and retains its options
and on/off mode. Supplied options override retained values. Codex keeps running.
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


export async function main(argv: string[]): Promise<number> {
  if (argv[0] === '--help' || !argv.length) { console.log(HELP); return 0 }
  if (['on', 'off', 'status', 'reload'].includes(argv[0]!)) return standalone(argv)
  if (argv[0] === '__hook-on') return standalone(['on', ...argv.slice(1)], true)
  if (argv[0] === 'hook') return hook(argv.slice(1))
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
      const renderLine = codexLine(collector, o, t)
      line = async width => {
        const screen = await tmux.snapshot()
        // tmux reports the foreground Node wrapper while its Codex child owns
        // the terminal. Keep the ordinary Codex screen guard for other commands.
        if (screen.command === basename(process.execPath)) screen.command = 'codex'
        const selected = collector.displayedThread(screen)
        return selected ? renderLine(width, selected) : ''
      }
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
