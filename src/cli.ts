const INSTALL_COMMANDS = `  vargus install antigravity
  vargus install claude
  vargus install codex [--home CODEX_HOME]
  vargus install omo [--dir EXTENSIONS_DIRECTORY] [--config FILE]`
const REMOVE_COMMANDS = `  vargus remove antigravity
  vargus remove claude
  vargus remove codex [--home CODEX_HOME]
  vargus remove omo [--dir EXTENSIONS_DIRECTORY]`
const HOST_HELP = {
  install: {
    antigravity: `Usage:
  vargus install antigravity

Sets \`statusLine.command\` in ~/.gemini/antigravity-cli/settings.json.
See docs/setup-antigravity.md for manual setup and override flags.`,
    claude: `Usage:
  vargus install claude

Sets up the VArgus plugin and inline status line at user scope.
See docs/setup-claude.md for manual or project-scoped setup.`,
    codex: `Usage:
  vargus install codex [--home CODEX_HOME]

Adds the VArgus startup hooks to hooks.json in CODEX_HOME (default: $CODEX_HOME or ~/.codex).
See docs/setup-codex.md for hook trust, Thread ID setup, and manual activation.`,
    omo: `Usage:
  vargus install omo [--dir EXTENSIONS_DIRECTORY] [--config FILE]

Adds the VArgus extension loader to OmO's extensions directory.
--dir EXTENSIONS_DIRECTORY  Install into an explicit extensions directory.
--config FILE               Overlay a JSON or JSONC options file on top of vargus.jsonc.
See docs/setup-omo.md for details.`,
  },
  remove: {
    antigravity: `Usage:
  vargus remove antigravity

Clears the VArgus \`statusLine\` from ~/.gemini/antigravity-cli/settings.json.
See docs/setup-antigravity.md for details.`,
    claude: `Usage:
  vargus remove claude

Uninstalls the user-scope plugin, removes its checkout marketplace when unused,
and clears the VArgus \`statusLine\`.
See docs/setup-claude.md for details.`,
    codex: `Usage:
  vargus remove codex [--home CODEX_HOME]

Removes the VArgus startup hooks and autostart state from CODEX_HOME (default: $CODEX_HOME or ~/.codex).
See docs/setup-codex.md for details.`,
    omo: `Usage:
  vargus remove omo [--dir EXTENSIONS_DIRECTORY]

Removes the VArgus extension loader from OmO's extensions directory.
--dir EXTENSIONS_DIRECTORY  Remove from an explicit extensions directory.
See docs/setup-omo.md for details.`,
  },
} as const

const HELP = `Usage:
  vargus install|remove antigravity|claude|codex|omo [OPTIONS]
  vargus themes [NAME]

Run \`vargus install --help\`, \`vargus remove --help\`, or \`vargus themes --help\` for options.

Configuration:
  Copy vargus.sample.jsonc to vargus.jsonc in the VArgus checkout to customize
  settings across all four hosts. Edits apply automatically while running.

Runtime controls by host:
  Codex CLI:       !vargus on|off|status|reload inside Codex (\`vargus on --help\` for options)
  OmO Native:      /vargus on|off|status|config; /reload after code updates
  Claude Code:     /config for options, /plugin to enable/disable, /reload-plugins after code updates
  Antigravity CLI: /statusline on|off|delete (picks up code and config updates automatically)

See docs/setup-<host>.md for host setup, override files, and troubleshooting.
For LLM agents: run \`vargus agent-guide\` for checkout paths, host guides, and rules.`

export async function main(argv: string[]): Promise<number> {
  const [command, host] = argv
  if (command === undefined || command === '--help') { console.log(HELP); return 0 }
  if (command === 'statusline') return (await import('./cli/antigravity.ts')).statusline(argv.slice(1))
  if (command === 'themes') return (await import('./cli/themes.ts')).themes(argv.slice(1))
  if (command === 'agent-guide') return (await import('./cli/agent-guide.ts')).agentGuide(argv.slice(1))
  if (command === 'install' || command === 'remove') {
    const usage = `Usage:\n${command === 'install' ? INSTALL_COMMANDS : REMOVE_COMMANDS}`
    if (host === '--help' && argv.length === 2) {
      console.log(`${usage}\n\nRun \`vargus ${command} <host> --help\` for host-specific details and options.`)
      return 0
    }
    if (argv.length === 3 && argv[2] === '--help' && host !== undefined && Object.hasOwn(HOST_HELP[command], host)) {
      console.log(HOST_HELP[command][host as keyof typeof HOST_HELP[typeof command]])
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
