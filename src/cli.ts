import { standalone, rowWorker } from './cli/codex.ts'
import { hook } from './cli/hooks.ts'
import { TmuxOutput } from './outputs/tmux/client.ts'

const HELP = `Usage:
  vargus on|off|status|reload [--pane %ID] [--socket PATH] [--theme NAME] [--config FILE]
  vargus hook session-start|prompt [--config FILE] [--pane %ID] [--socket PATH]
  vargus tmux-reset

The tmux row is opt-in. Standalone on/off hide/restore Codex's saved footer
through tmux /statusline commands. Off removes the row; inactive views restore
on their next empty-composer visit. The helper exits after restoration or TUI exit.
FILE is a JSON object of VArgus options; no saved host settings change.
Standalone drafts keep last-confirmed readings by default. Installed
Codex startup hooks are enabled by default; neither needs an options file.
After updating, reload replaces the standalone helper and retains its options
and on/off mode. Supplied options override retained values. Codex keeps running.
Exit Codex to restore the original tmux bar. After a helper crash, tmux-reset
cleans up an abandoned row when no VArgus helper is still running.
`

export async function main(argv: string[]): Promise<number> {
  if (argv[0] === '--help' || !argv.length) { console.log(HELP); return 0 }
  if (['on', 'off', 'status', 'reload'].includes(argv[0]!)) return standalone(argv)
  if (argv[0] === '__hook-on') return standalone(['on', ...argv.slice(1)], true)
  if (argv[0] === 'hook') return hook(argv.slice(1))
  if (argv[0] === '__row') return rowWorker(JSON.parse(argv[1]!))
  if (argv[0] === 'tmux-reset') { await TmuxOutput.environment().reset(); return 0 }
  if (argv[0] === 'codex') throw new Error('Start Codex normally in tmux and run !vargus on. The Codex transport launcher was removed.')
  if (argv[0] === 'claude') throw new Error('Start Claude normally and use the VArgus inline plugin. The Claude tmux launcher was removed.')
  throw new Error(HELP)
}

if (process.env.VARGUS_CLI_MAIN === '1') {
  main(process.argv.slice(2)).then(code => { process.exitCode = code }).catch(error => {
    console.error('VArgus:', (error as Error).message)
    process.exitCode = 1
  })
}
