import { join, resolve } from 'node:path'

const CHECKOUT = resolve(import.meta.dirname, '../..')

const USAGE = `Usage:
  vargus agent-guide

Prints checkout paths, host setup guide locations, and rules for LLM agents.`

/** Format the compact agent guide with resolved checkout paths and cross-host rules. */
export function formatAgentGuide(checkout = CHECKOUT): string {
  return `# VArgus agent guide

Read the target host's setup guide before installing, changing settings, or troubleshooting.

Checkout and files:
  Checkout:        ${checkout}
  Shared config:   ${join(checkout, 'vargus.jsonc')} (copy from ${join(checkout, 'vargus.sample.jsonc')})
  Antigravity CLI: ${join(checkout, 'docs', 'setup-antigravity.md')}
  Claude Code:     ${join(checkout, 'docs', 'setup-claude.md')}
  Codex CLI:       ${join(checkout, 'docs', 'setup-codex.md')}
  OmO Native:      ${join(checkout, 'docs', 'setup-omo.md')}
  Overview/design: ${join(checkout, 'README.md')}, ${join(checkout, 'DESIGN.md')}

Rules:
- Use \`vargus install|remove <host>\` for setup (\`vargus install <host> --help\` for flags).
  Do not run \`vargus statusline\` or \`vargus hook\` interactively; both read host JSON from stdin.
- \`vargus on|off|status|reload\` and \`vargus tmux-reset\` are Codex CLI only (tmux/psmux helper).
  Other hosts use their own controls: \`/vargus\` (OmO), \`/config\` and \`/reload-plugins\` (Claude),
  and \`/statusline\` (Antigravity CLI).
- Edit ${join(checkout, 'vargus.jsonc')} for shared settings; all four hosts pick up edits
  automatically while running. Per-host \`--config FILE\` overrides do not live-reload in OmO or Codex.
- Never overwrite an unrelated \`statusLine\`, OmO extension, or Codex hook group without asking
  and backing it up first.
- Hand off host UI or sandbox-protected steps to the user: running \`/statusline\` inside an open
  \`agy\` session, reviewing \`/hooks\` and selecting Thread ID in Codex, and reloading/reopening
  sessions when a host requires it.
- Verify changes with the host guide's Verify section (and \`vargus themes [NAME]\` for themes).`
}

/** Run the `vargus agent-guide` CLI subcommand. */
export function agentGuide(args: string[]): number {
  if (args.length === 1 && args[0] === '--help') {
    console.log(USAGE)
    return 0
  }
  if (args.length > 0) throw new Error(USAGE)
  console.log(formatAgentGuide())
  return 0
}
