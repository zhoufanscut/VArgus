const INSTALL_COMMANDS = `  vargus install antigravity
  vargus install claude
  vargus install codex [--home CODEX_HOME]
  vargus install omo [--dir EXTENSIONS_DIRECTORY] [--config FILE]`
const REMOVE_COMMANDS = `  vargus remove codex [--home CODEX_HOME]
  vargus remove omo [--dir EXTENSIONS_DIRECTORY]`
const INSTALL_DETAILS = `Installing for Antigravity sets \`statusLine.command\` in ~/.gemini/antigravity-cli/settings.json.
Installing for Claude sets up the VArgus plugin and inline status line at user scope.
Installing for Codex adds the VArgus startup hooks.
Installing for OmO adds the VArgus extension loader.`

const HELP = `Usage:
${INSTALL_COMMANDS}
${REMOVE_COMMANDS}
  vargus statusline [--theme NAME] [--config FILE]
  vargus themes [NAME]
  vargus on|off|status|reload [--pane %ID] [--socket PATH] [--theme NAME] [--config FILE]
  vargus hook session-start|prompt [--config FILE] [--pane %ID] [--socket PATH]
  vargus tmux-reset

${INSTALL_DETAILS}
Antigravity CLI runs \`vargus statusline\` from PATH and pipes session JSON on stdin.
Run \`vargus themes [NAME]\` to preview bundled colour themes in your terminal.

The tmux row is opt-in for Codex. Standalone on/off hide/restore Codex's saved footer
through tmux /statusline commands. Off removes the row; inactive views restore
on their next empty-composer visit. The helper exits after restoration or TUI exit.
VArgus reads vargus.jsonc from its checkout. --config FILE overlays a JSON or JSONC options object.
The tmux controls leave saved Codex settings alone.
Standalone drafts keep last-confirmed readings by default. Installed
Codex startup hooks are enabled by default; neither needs an options file.
After updating, reload replaces the helper, rereads checkout defaults, and retains
explicit overrides and on/off mode. Supplied options override retained values. Codex keeps running.
Exit Codex to restore the original tmux bar. After a helper crash, tmux-reset
cleans up an abandoned row when no VArgus helper is still running.
`

export async function main(argv: string[]): Promise<number> {
  const [command, host] = argv
  if (command === undefined || command === '--help') { console.log(HELP); return 0 }
  if (command === 'statusline') return (await import('./cli/antigravity.ts')).statusline(argv.slice(1))
  if (command === 'themes') return (await import('./cli/themes.ts')).themes(argv.slice(1))
  if (command === 'install' || command === 'remove') {
    const usage = `Usage:\n${command === 'install' ? INSTALL_COMMANDS : REMOVE_COMMANDS}`
    if (host === '--help' && argv.length === 2) {
      console.log(command === 'install' ? `${usage}\n\n${INSTALL_DETAILS}` : usage)
      return 0
    }
    if (host === 'codex') return (await import('./cli/codex/setup.ts')).codexSetup([command, ...argv.slice(2)])
    if (host === 'omo') return (await import('./cli/omo.ts')).omo([command, ...argv.slice(2)])
    if (command === 'install' && argv.length === 2) {
      if (host === 'antigravity') return (await import('./cli/antigravity-setup.ts')).installAntigravity()
      if (host === 'claude') return (await import('./cli/claude-setup.ts')).installClaude()
    }
    throw new Error(usage)
  }
  if (['on', 'off', 'status', 'reload'].includes(command)) return (await import('./cli/codex/control.ts')).standalone(argv)
  if (command === '__hook-on') return (await import('./cli/codex/control.ts')).standalone(['on', ...argv.slice(1)], true)
  if (command === 'hook') return (await import('./cli/codex/hooks.ts')).hook(argv.slice(1))
  if (command === '__row') return (await import('./cli/codex/worker.ts')).rowWorker(JSON.parse(argv[1]!))
  if (command === 'tmux-reset') { await (await import('./outputs/tmux/client.ts')).TmuxOutput.environment().reset(); return 0 }
  if (command === 'antigravity') throw new Error('Usage: vargus install antigravity. In an open Antigravity CLI session, use /statusline.')
  if (command === 'codex') throw new Error('Start Codex normally in tmux and run !vargus on. The Codex transport launcher was removed. Use vargus install codex or vargus remove codex to manage startup hooks.')
  if (command === 'claude') throw new Error('Start Claude normally and use the VArgus inline plugin. Set it up with vargus install claude.')
  throw new Error(HELP)
}

if (process.env.VARGUS_CLI_MAIN === '1') {
  main(process.argv.slice(2)).then(code => { process.exitCode = code }).catch(error => {
    console.error('VArgus:', (error as Error).message)
    process.exitCode = 1
  })
}
