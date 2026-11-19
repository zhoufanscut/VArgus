# AGENTS.md

VArgus is a status line for Claude Code, OmO Native, Antigravity CLI and Codex CLI.
Use [README.md](README.md) for setup. Read the relevant [DESIGN.md](DESIGN.md)
section before changing a rule and update it in the same commit as the code.
Keep the gitignored `PLAN.md` local.

## Working rules

- Support feature and design choices with a measurement or a quoted source.
  Say which alternatives the evidence rules out.
- Enable new features and behavior by default across hosts. Make them opt-in
  only when the user explicitly asks. Document host usage in its setup guide and
  shared usage in README.md.
- Follow the [code boundaries](DESIGN.md#hosts-and-outputs). Keep shared code free of
  host and output imports. Host collectors stay independent of each other and of
  outputs. Wire hosts to outputs in the CLI or OmO registration. Keep Node code out
  of the Claude mod.
- Keep VantageHUD read-only. Port its [rules](DESIGN.md#rules-carried-over-from-vantagehud)
  with tests and write the implementation in VArgus without copying or importing its code.
- The Claude mod API is early access. Load the installed build's `plugin-authoring` skill
  for `claude-code.d.ts` and `reference.md`. Find facts by name, quote the source in
  DESIGN.md, and recheck after each Claude Code release. Probe an
  [unsettled point](DESIGN.md#unsettled) in a throwaway mod before relying on it.
- Before committing substantial changes, have a reviewer agent cover the diff
  and docs, including earlier review coverage and runtime checks. Recheck its
  findings before editing.
- Commit only when asked. Keep commits focused and record the reproduction,
  measurements and verification in the commit message.

## Testing and releases

- Before any test or probe, inspect its harness and follow the
  [test process cleanup rules](docs/maintenance.md#test-process-cleanup).
  Use isolated test homes and sockets and confirm owned processes exit before cleanup.
- Run `npm test` for Node CLI, hooks and tmux output, including boundary and native-entry
  checks. Run `npm run test:claude` for the Claude mod. Record the scope of Codex
  fixture and live checks in [DESIGN.md](DESIGN.md#tests).
- Follow the [release checklist](docs/maintenance.md#releases) for releases.
