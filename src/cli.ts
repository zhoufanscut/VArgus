import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { standalone, rowWorker } from './cli/codex.ts'
import { hook } from './cli/hooks.ts'
import { TmuxOutput } from './outputs/tmux/client.ts'
import { claudeLaunch } from './hosts/claude/launch-node.ts'

const HELP = `Usage:
  vargus on|off|status|reload [--pane %ID] [--socket PATH] [--theme NAME] [--config FILE]
  vargus hook session-start|prompt [--config FILE] [--pane %ID] [--socket PATH]
  vargus claude --tmux [--theme NAME] [--config FILE] -- [claude arguments]
  vargus tmux-reset

The tmux row is opt-in. Standalone on/off hide/restore Codex's saved footer
through tmux /statusline commands. Off removes the row; inactive views restore
on their next empty-composer visit. The helper exits after restoration or TUI exit.
FILE is a JSON object of VArgus options; no saved host settings change.
Standalone drafts keep last-confirmed readings by default. Installed
Codex startup hooks are enabled by default; neither needs an options file.
After updating, reload replaces the standalone helper and retains its options
and on/off mode. Supplied options override retained values. Codex keeps running.
Exit the wrapped CLI to restore the original tmux bar. After a crash, tmux-reset
cleans up an abandoned row when no wrapped session is still running.
`

export async function main(argv: string[]): Promise<number> {
  if (argv[0] === '--help' || !argv.length) { console.log(HELP); return 0 }
  if (['on', 'off', 'status', 'reload'].includes(argv[0]!)) return standalone(argv)
  if (argv[0] === '__hook-on') return standalone(['on', ...argv.slice(1)], true)
  if (argv[0] === 'hook') return hook(argv.slice(1))
  if (argv[0] === '__row') return rowWorker(JSON.parse(argv[1]!))
  const [host, ...rest] = argv
  if (host === 'tmux-reset') { await TmuxOutput.environment().reset(); return 0 }
  if (host === 'codex') throw new Error('Start Codex normally in tmux and run !vargus on. The Codex transport launcher was removed.')
  if (host !== 'claude') throw new Error(HELP)
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
  const tmux = TmuxOutput.environment()
  const runId = randomBytes(16).toString('hex')
  let child: ReturnType<typeof spawn> | undefined
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
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    claude = claudeLaunch(root, args, runId, given)
    await tmux.attach()
    const update = async () => { await tmux.update(await claude!.line()) }
    await update()
    timer = setInterval(() => {
      if (!updating) updating = update().catch(error => {
        console.error('VArgus row:', (error as Error).message)
      }).finally(() => { updating = undefined })
    }, 1000)
    child = spawn('claude', claude.args, { stdio: 'inherit', env: { ...process.env, VARGUS_TMUX_RUN_ID: runId } })
    const exit = new Promise<number>((resolve, reject) => {
      child!.once('error', reject)
      child!.once('exit', (code, signal) => resolve(code ?? (signal ? 128 : 0)))
    })
    return await Promise.race([exit, interrupted])
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
    await cleanup('Claude alias', async () => claude?.close())
    await cleanup('tmux restore', () => tmux.detach())
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
