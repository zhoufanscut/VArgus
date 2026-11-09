# AGENTS.md

Guidance for coding agents (Claude Code reads it through `CLAUDE.md`) working on VArgus.

VArgus supports Claude Code and Codex CLI, with an opt-in tmux output for both.
The existing Claude inline status line has two parts: a mod (a plugin hooks module) that collects the
numbers and writes the finished line to a file, and a `statusLine` command that prints it. It
replaces VantageHUD (github.com/zhoufanscut/VantageHUD, last release 0.6.0) and shares no code
with it.
[DESIGN.md](DESIGN.md) is how it works: each rule with its reason, the mod facts it relies on,
the rules carried over from VantageHUD and what is still unsettled. Read its section before you
change what it describes, and update it in place in the same commit when a rule changes.

`PLAN.md`, where it exists, is the maintainer's local working notes (status, the gate, open
questions, the verification log). It is gitignored: never commit it.

**Built on an early-access API.** The bundled `plugin-authoring` types and `reference.md` still
say "EARLY ACCESS"; the maintainer chose to build anyway and take the churn. Settle an item in
DESIGN.md "Unsettled" with a throwaway mod before building on it.

## Code boundaries

- `src/core`, `src/render`, `src/theme`, `src/i18n` and `src/options.ts` hold shared values and
  presentation. They import no host API, host module or output adapter.
- `src/hosts/claude` owns the mod, its collectors, state contract integration and detail pane.
  Its `launch-node.ts` is Node-side only and must stay outside the mod's import graph.
- `src/hosts/codex` owns Codex protocol collection and transport. Host adapters do not import
  each other or a display adapter.
- `src/outputs` owns display encoding and tmux lifecycle; it imports no host code.
  `src/cli.ts` and `src/cli` wire a host to an output. Check these boundaries with `npm test`.
- For the Node launcher run `npm run build` and `npm test`; for Claude run
  `npm run test:claude`. Codex protocol fixtures complement, rather than establish, live model
  behavior: keep the live verification limits in DESIGN.md current.

## Working rules

- **Evidence before ideas.** Back each proposed feature or design choice with a measured number or
  a quoted source (types, docs, CHANGELOG, VantageHUD's code), and say which candidates the
  evidence rules out. A list of plausible ideas gets rejected.
- **Features are enabled by default.** This applies to every host and shared feature,
  including new behaviour inside an existing element. Make a feature opt-in only when
  the user explicitly requests it. Document how to use the feature in README.md.
- **VantageHUD is a read-only reference.** Port its rules (DESIGN.md "Rules carried over from
  VantageHUD") as a rule plus a test; never copy its code or import it. Never edit VantageHUD.
- **Mod API facts come from the build's own types.** Load the `plugin-authoring` skill to get
  `claude-code.d.ts` and `reference.md` for the installed version; grep by name, line numbers move.
  Quote the line when a claim goes into DESIGN.md, and re-check its mod facts after each Claude
  Code release.
- **Review before landing.** Run a `reviewer` agent on substantial changes before committing: tell
  it what earlier reviews covered, make it verify by running things, include docs as a target,
  and re-check its findings before editing.
- **Commit only when asked.** Commits are small and specific, with full messages: the measured
  numbers, how a bug was reproduced, how the change was verified (as in VantageHUD's history).

## Releases

Same steps as VantageHUD: a version bump (`.claude-plugin/plugin.json`) and a dated
`## [x.y.z] - YYYY-MM-DD` section in `CHANGELOG.md` (Keep a Changelog: Added / Changed / Fixed /
Removed, compare link at the bottom), committed as `chore(release): x.y.z`; an annotated tag
`vX.Y.Z`; push `main` and the tag; `gh release create vX.Y.Z --title vX.Y.Z --notes-file notes.md
--latest --verify-tag`. Notes style: one lead sentence, a `##` section per headline change with
its measured numbers, an `## Also` list, an `## Upgrading` section when there are migration steps,
then `---` and `**Full changelog**: <compare link>` (see VantageHUD's GitHub releases).
