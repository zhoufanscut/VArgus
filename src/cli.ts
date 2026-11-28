const INSTALL_COMMANDS = `  vargus install antigravity
  vargus install claude
  vargus install codex [--home CODEX_HOME]
  vargus install omo [--dir EXTENSIONS_DIRECTORY] [--config FILE]`
const REMOVE_COMMANDS = `  vargus remove antigravity
  vargus remove claude
  vargus remove codex [--home CODEX_HOME]
  vargus remove omo [--dir EXTENSIONS_DIRECTORY]`
const INSTALL_DETAILS = `Installing for Antigravity sets \`statusLine.command\` in ~/.gemini/antigravity-cli/settings.json.
Installing for Claude sets up the VArgus plugin and inline status line at user scope.
Installing for Codex adds the VArgus startup hooks.
Installing for OmO adds the VArgus extension loader.`
const REMOVE_DETAILS = `Removing for Antigravity clears the VArgus \`statusLine\` from ~/.gemini/antigravity-cli/settings.json.
Removing for Claude uninstalls the user-scope plugin, removes its checkout marketplace when unused, and clears the VArgus \`statusLine\`.
Removing for Codex removes the VArgus startup hooks and autostart state.
Removing for OmO removes the VArgus extension loader.`

const HELP = `Usage (all hosts):
  vargus install|remove antigravity|claude|codex|omo [OPTIONS]
  vargus themes [NAME]

Antigravity CLI only (configured as statusLine.command):
  vargus statusline [--theme NAME] [--config FILE]

Codex CLI only (tmux/psmux helper):
  vargus on|off|status|reload [--pane %ID] [--socket PATH] [--theme NAME] [--config FILE]
  vargus hook session-start|prompt [--config FILE] [--pane %ID] [--socket PATH]
  vargus tmux-reset

Run \`vargus install --help\` or \`vargus remove --help\` for host options and details.
Run \`vargus themes [NAME]\` to preview bundled colour themes in your terminal.

Shared configuration:
  VArgus reads vargus.jsonc from its checkout. Edits to vargus.jsonc apply
  automatically across all four hosts while running. --config FILE overlays a
  JSON or JSONC options object.

Runtime controls by host:
  Codex CLI:       !vargus on|off|status|reload (tmux/psmux helper; reload upgrades code/explicit flags)
  OmO Native:      /vargus on|off|status|config in OmO; /reload after code or --config updates
  Claude Code:     /config for options, /plugin to enable/disable, /reload-plugins after code updates
  Antigravity CLI: /statusline on|off|delete in agy (vargus statusline refreshes code and config each draw)

Codex tmux details:
  The tmux row is opt-in for Codex. Standalone on/off hide/restore Codex's saved footer
  through tmux /statusline commands. Off removes the row; inactive views restore
  on their next empty-composer visit. The helper exits after restoration or TUI exit.
  The tmux controls leave saved Codex settings alone.
  Standalone drafts keep last-confirmed readings by default. Installed
  Codex startup hooks are enabled by default; neither needs an options file.
  After updating code or changing explicit flags, !vargus reload replaces the helper,
  rereads checkout defaults, and retains explicit overrides and on/off mode.
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
      console.log(`${usage}\n\n${command === 'install' ? INSTALL_DETAILS : REMOVE_DETAILS}`)
      return 0
    }
    if (host === 'codex') return (await import('./cli/codex/setup.ts')).codexSetup([command, ...argv.slice(2)])
    if (host === 'omo') return (await import('./cli/omo.ts')).omo([command, ...argv.slice(2)])
    if (argv.length === 2) {
      if (host === 'antigravity') {
        const mod = await import('./cli/antigravity-setup.ts')
        return command === 'install' ? mod.installAntigravity() : mod.removeAntigravity()
      }
      if (host === 'claude') {
        const mod = await import('./cli/claude-setup.ts')
        return command === 'install' ? mod.installClaude() : mod.removeClaude()
      }
    }
    throw new Error(usage)
  }
  if (['on', 'off', 'status', 'reload'].includes(command)) return (await import('./cli/codex/control.ts')).standalone(argv)
  if (command === '__hook-on') return (await import('./cli/codex/control.ts')).standalone(['on', ...argv.slice(1)], true)
  if (command === 'hook') return (await import('./cli/codex/hooks.ts')).hook(argv.slice(1))
  if (command === '__row') return (await import('./cli/codex/worker.ts')).rowWorker(JSON.parse(argv[1]!))
  if (command === 'tmux-reset') { await (await import('./outputs/tmux/client.ts')).TmuxOutput.environment().reset(); return 0 }
  if (command === 'antigravity') throw new Error('Usage: vargus install antigravity or vargus remove antigravity. In an open Antigravity CLI session, use /statusline.')
  if (command === 'codex') throw new Error('Start Codex normally in tmux and run !vargus on. The Codex transport launcher was removed. Use vargus install codex or vargus remove codex to manage startup hooks.')
  if (command === 'claude') throw new Error('Start Claude normally and use the VArgus inline plugin. Set it up with vargus install claude or remove it with vargus remove claude.')
  if (command === 'omo') throw new Error('Usage: vargus install omo or vargus remove omo.')
  throw new Error(HELP)
}

if (process.env.VARGUS_CLI_MAIN === '1') {
  main(process.argv.slice(2)).then(code => { process.exitCode = code }).catch(error => {
    console.error('VArgus:', (error as Error).message)
    process.exitCode = 1
  })
}
