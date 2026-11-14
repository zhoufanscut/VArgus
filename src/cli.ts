const HELP = `Usage:
  vargus omo install|remove [--dir EXTENSIONS_DIRECTORY]
  vargus statusline [--theme NAME] [--config FILE]
  vargus on|off|status|reload [--pane %ID] [--socket PATH] [--theme NAME] [--config FILE]
  vargus hook session-start|prompt [--config FILE] [--pane %ID] [--socket PATH]
  vargus tmux-reset

Antigravity CLI runs \`vargus statusline\` natively as \`statusLine.command\` in
~/.gemini/antigravity-cli/settings.json, piping session JSON on stdin with no tmux.

The tmux row is opt-in for Codex. Standalone on/off hide/restore Codex's saved footer
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
  if (argv[0] === 'statusline') return (await import('./cli/antigravity.ts')).statusline(argv.slice(1))
  if (argv[0] === 'omo') return (await import('./cli/omo.ts')).omo(argv.slice(1))
  if (['on', 'off', 'status', 'reload'].includes(argv[0]!)) return (await import('./cli/codex.ts')).standalone(argv)
  if (argv[0] === '__hook-on') return (await import('./cli/codex.ts')).standalone(['on', ...argv.slice(1)], true)
  if (argv[0] === 'hook') return (await import('./cli/hooks.ts')).hook(argv.slice(1))
  if (argv[0] === '__row') return (await import('./cli/codex.ts')).rowWorker(JSON.parse(argv[1]!))
  if (argv[0] === 'tmux-reset') { await (await import('./outputs/tmux/client.ts')).TmuxOutput.environment().reset(); return 0 }
  if (argv[0] === 'antigravity') throw new Error('Start Antigravity CLI normally and set statusLine.command to "vargus statusline".')
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
