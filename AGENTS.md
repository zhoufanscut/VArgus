# AGENTS.md

Guidance for coding agents (Claude Code reads it through `CLAUDE.md`) working on VArgus.

VArgus is a Claude Code status line in two parts: a mod (a plugin hooks module) that collects the
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

## Working rules

- **Evidence before ideas.** Back each proposed feature or design choice with a measured number or
  a quoted source (types, docs, CHANGELOG, VantageHUD's code), and say which candidates the
  evidence rules out. A list of plausible ideas gets rejected.
- **New features are opt-in.** Each new feature, or new behaviour inside an existing element,
  gets its own `userConfig` flag defaulting to off, and a README line saying how to turn it on.
  Bug fixes need no flag.
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
