# Changelog

Notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-11-14

### Added

- Native OmO TUI support through a widget below the editor, enabled by default.
  `vargus omo install|remove` manages the checkout loader without an npm install,
  SDK package or build. `/vargus on|off|status|config JSON` saves controls and
  configuration in the current session across reload and resume.
- OmO context, session age, persisted main-session input plus output tokens,
  outer tool calls, accepted task IDs and optional persisted workflow notices.
  Cache and child usage are excluded; observed native assistant edits carry
  receipts so copied usage does not increase the token total. Skill counts
  remain unavailable and are omitted.
- OmO Claude and ChatGPT subscription windows filtered by the selected provider,
  with window labels, percentages and reset countdowns but no account names.
  Kimi Coding collects five-hour and monthly plan limits through its regional
  usage endpoint using credentials resolved by OmO.
- OmO versionless model families and speed labels after effort, including
  `sol:high(fast)`, `sol:high(ultrafast)` and Kimi highspeed as `(fast)`.
- Cached OmO Git collection with 5-second polling and a ten-times-duration
  hold-off, directory-change invalidation and optional detached-HEAD display.

### Changed

- While enabled, OmO replaces the entire native footer, including lifecycle and
  extension statuses. Disabling VArgus restores the built-in footer; separate
  task/todo widgets, questions and the working indicator remain owned by OmO.
- Share the Node Git reader between Antigravity and OmO, and share the Kimi usage
  parser between Claude and OmO without importing one host collector into another.
- Ignore local agent configuration and evidence directories.

## [0.5.0] - 2026-11-14

### Added

- Native inline `statusLine` support for Antigravity CLI (`agy`) through
  `vargus statusline [--theme NAME] [--config FILE]`, running TypeScript source
  directly with Node.js 24.12 or later and no tmux, npm install or build step.
  Nonempty rows include a two-space left indent and reserve 2 columns from
  `terminal_width` so narrow terminals drop trailing fragments without wrapping.
- Antigravity model-category quota selection (`gemini-5h` and `gemini-weekly`
  for Gemini and Orchestrator models, `3p-5h` and `3p-weekly` for Claude and
  GPT models), with the non-active group's weekly bucket (`3p` or `gm`) shown
  from 80% when `otherModelWeekly` is on.
- Antigravity short model names (`Gemini 4 Carbon (High)` → `carbon:high`,
  `Orchestrator (Carbon)` → `orchestrator(carbon)`, `Claude Opus 5.5 (High)` →
  `opus:high`, gateway IDs preserved whole) and startup effort inference before
  `model.effort` is populated.
- Incremental Antigravity `transcript.jsonl` replay (cached by byte offset plus
  first-line and trailing SHA-256 digests across `/rewind`) for session age,
  uncached input plus output tokens, and tool, subagent (`invoke_subagent`,
  `swarm` `add`), workflow (`run_workflow`) and Antigravity skill (`SKILL.md`
  reads) counts, including resolution of `agy` 1.5.8's `.gemini/antigravity` vs
  `.gemini/antigravity-cli` transcript path mismatch under `/brain/<id>/`
  containment.
- Cached Antigravity Git collection with VArgus's 5-second and `10×` slow-walk
  poll hold-off, immediate refresh after mutating tools, linked-worktree and
  opt-in `detachedHead` support, and a 4-second Git timeout under `agy`'s
  5-second `statusLine` limit.

### Changed

- Load CLI subcommands lazily in `src/cli.ts` so `vargus statusline` never
  imports the Codex or tmux module graph.

## [0.4.4] - 2026-11-13

### Fixed

- Scope Codex's extra status row to windows with a VArgus owner on POSIX tmux
  and native Windows psmux. Windows without VArgus use their original height
  and bar formats; with the default bar, this means one row in a plain window
  and two in a VArgus window. The behavior is enabled by default.
- Preserve user hooks, custom and hidden bars, window-local formats and styles,
  asynchronous shell formatters, and later user settings across window switches
  and cleanup. Native hook writes use separate requests, and callbacks retained
  after ambiguous user edits become inert when their attachment ends.

### Changed

- Synchronize live Codex navigation tests with the confirmed visible view and
  completed footer work instead of fixed delays, including crowded footers.
- Wait for complete tmux option restoration after Codex `/new` before checking
  cleanup in the live regression. Give standalone integration fixtures a
  120-second overall deadline while keeping their existing per-step waits.
- Existing shared attachments need every VArgus helper in the session stopped
  once, or a tmux/psmux session restart, before activation installs the new layout.

## [0.4.3] - 2026-11-11

### Fixed

- Codex releases its empty tmux row at an empty composer, including after an
  identified `/new` transition. The last owner restores the original bar height;
  readings returning reattach the row. Typing in the new conversation cannot
  revive the previous snapshot, while transient shell and popup frames preserve
  existing draft readings.
- Codex clears stale Git readings when its recorded working directory changes,
  including the snapshot kept while typing, and discards Git results for the old
  directory.
- Claude discards usage responses from before `/clear` or an in-session resume.
  Worktree changes clear old repository readings and invalidate pending Git walks
  and their polling hold.

### Changed

- Stop Git collection when its display consumers are disabled. Claude also stops
  rate-limit API collection when both the inline fragment and detail view are off;
  the detail view keeps its readings when only inline fragments are hidden.
- Resolve Codex's reported transcript before falling back to a filename scan, and
  collect aggregate Git status without parsing unused changed-file details.
- Simplify Claude's per-agent state by removing unused classification and request
  counters. Strengthen tests for the main, subagent and total token columns and
  restored readings after reload.

## [0.4.2] - 2026-11-10

### Added

- Claude Code with Kimi Code shows the rolling five-hour and membership monthly
  total quotas as `5h` and `1m`, using Kimi's direct usage endpoint. Direct
  third-party usage providers bypass `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`.
- Codex Fast-mode selection appears beside the model and effort as
  `sol:max(fast)`, or `sol(fast)` when effort is hidden.

### Changed

- Codex always uses short names for recognized model families, matching Claude's
  display rule. The `codexShortModel` switch is removed; existing values are ignored.

### Removed

- Claude Code's `vargus claude --tmux` launcher and its `tmuxOutput` publisher
  option. Start Claude normally and use the VArgus inline plugin instead.

## [0.4.1] - 2026-11-10

### Added

- Native Windows Codex support through psmux, with `bin/vargus.cmd`, PowerShell
  startup hooks and CIM process discovery. The CLI and helpers run with Windows
  Node directly, without Bash, an npm install or a build. README includes setup
  and verification limits.
- A Windows status row that preserves psmux's original bar. With the built-in
  bar, VArgus appears above the session/window/right-side information; custom
  formats and asynchronous shell formatters retain their native layout.

### Fixed

- Native Windows attachment rolls back bar settings and owner registration on
  failure, allowing retry without leaving the original bar hidden.
- Windows formatter detection reads global window options, preserving asynchronous
  shell commands in separators and flag styles. Window-local bar formats and
  styles retain psmux's native rendering, including overrides added while active.

## [0.4.0] - 2026-11-10

### Added

- Standalone `!vargus on|off|status|reload` controls inside official Codex, using a repo-local
  Bash entry, one PATH symlink and a background log reader. Explicit pane/socket
  selection handles multiple panes and custom tmux servers; TUI exit restores the bar.
- Opt-in tmux output for Claude Code through `bin/vargus claude --tmux`, sharing
  row lifecycle with standalone Codex. The active pane supplies the row; the last
  owner restores the original tmux bar.
- Claude `tmuxOutput` option (off by default), publishing a launch-local line for the wrapper.
- Codex automatic startup through trusted `SessionStart` and `UserPromptSubmit`
  hooks, including shared-daemon resumes. `codexAutoStart` defaults to true;
  activation waits for the first normal prompt on checked
  Codex 0.167.0. Manual off suppresses later callbacks for that thread and TUI.
- Standalone `!vargus reload` replaces the helper from the updated clone without
  restarting Codex or its daemon. It replays recorded readings and retains options,
  footer backups and on/off mode; command-line options can override retained values.
- Codex short model names, subagent-start counts and observed skill-load counts,
  enabled by default with separate switches. Counts belong to the displayed
  conversation; supported paginated child logs skip inherited parent activity.

### Changed

- Present VArgus as a status line for Claude Code and Codex CLI, with separate
  setup, configuration, update and removal instructions for each host.
- Standalone Codex keeps the last confirmed readings frozen while typing hides
  the view label, without an extra row label. `status` reports the pause; the
  historical snapshot can belong to a previously displayed view.
- Nonempty tmux rows start with two spaces, reserved from the renderer's width.
- Run the Node CLI, hooks and background helpers directly from `.ts` source with
  Node.js 24.12 or later. User commands need no npm install, `node_modules` folder
  or build; after updating, use `!vargus reload`. npm dependencies are for
  development/tests only.
- Standalone Codex `on` hides the native footer through tmux; `off` restores its
  saved layout. Backups survive helper crashes, and composer checks block delivery
  into an existing draft. Inconclusive native commands retain recovery state. Saved
  Codex config is not rewritten.
- Separate Claude and Codex host code from shared readings/rendering and tmux output. The
  existing Claude manifest loads `src/hosts/claude/register.ts` directly.

### Fixed

- Keep Codex's last-confirmed readings visible while typing when a native warning
  notice follows the context or shell-mode hint.
- Keep the Codex contextual agent label identifiable when earlier footer items
  contain backtick-quoted text, fixing the quoted-title restoration failure.
- Incomplete temporary footer-backup writes no longer break ordinary `on`, `off`
  or `status` discovery.
- Footer restoration includes backups from earlier root conversations in the
  same TUI. Explicit `off` in an older primary conversation rebinds restoration
  when its saved footer has no full thread ID, retaining the helper's display
  options. `on` also preserves those options when restoration finishes before
  its request can be acknowledged.
- Codex automatic startup accepts the statusline picker's `thread-id` item as well
  as the older `session-id` alias, including first-item view recognition.
- Preload Codex footer settings per workspace before pane observation, removing a
  config read from the first-subagent switch. Existing restore backups remain intact;
  the UI uses the same footer commands without extra cards or menus.
- Standalone Codex follows parent/subagent navigation with per-view readings and
  footer suppression. `off` removes the tmux row immediately and restores affected
  views on their next visit; a helper remains until restoration completes or Codex
  exits. Unknown view identities pause automation instead of selecting by log activity.
- Claude `ctx:` could keep the pre-compact fill until the next turn ended, which a long turn could
  stretch for minutes. The collector drops that fill when a compaction stands (`/compact`,
  auto-compact or a plugin's), then reads `$.session.usage()` after every main-loop `turn.step`.
  Every main response now updates `ctx:` while the turn is running; a fresh session, `/clear` or
  an in-session resume starts at `ctx:0%`, and a measure just after a compaction cannot restore
  the old fill. The one-second usage poll is gone.

### Removed

- Experimental `vargus codex --tmux` transport launcher and its RPC observer. Start
  ordinary Codex in tmux and use `!vargus on` instead.

## [0.3.0] - 2026-10-17

### Added

- Windows, with Git for Windows (no option: there was no Windows support to turn off). The mod
  takes `C:\...` and `C:/...` paths and its home from `USERPROFILE`, where Claude Code keeps its
  config even with `HOME` set to another folder; before, it wrote nothing there. It moves and
  removes files through `cmd.exe`, since Git's `mv` and `rm` are not on the `PATH` of a Claude
  Code started from PowerShell, and never hands cmd a path holding a character cmd acts on (`&`,
  `,`, `^`, `%` and others). The setup skill stops, settings unchanged, when the session has no
  Bash tool (no Git Bash: Claude Code would run the status line through PowerShell, where the
  reader fails). On drive paths the folder shortens to `~` with `\` separators, svn is found above
  the folder, and a detached HEAD in a linked worktree is named (these three unit-tested only).
  Tested live on one Windows 11 machine (Git 2.56.0, Claude Code 2.1.300), started from PowerShell
  and from Git Bash.

## [0.2.0] - 2026-10-16

### Added

- **Detail view** option (`detailView`, off by default): `/vargus` opens a live pane with every
  rate limit (gauge, local reset time and countdown), the context window in tokens, tokens by
  agent (input, output, cache read and write; the main conversation and each subagent, teammate
  or workflow agent) and git or svn detail (branch, counts, the first changed paths). It redraws
  every second while open; `/vargus` again or Esc closes it.

## [0.1.3] - 2026-10-15

### Added

- **Blank a stopped line** option (`blankStopped`, off by default): if the plugin stops
  mid-session, the status line goes blank within about two minutes instead of showing frozen
  numbers. After turning it on or off, ask Claude to set up the VArgus status line again.

### Fixed

- Each session's folder in the plugin's data folder is removed when the session ends (`/exit`,
  `/clear`, a resume, a closed terminal); they were all left behind. A folder left by a session
  that crashed is removed by a later session once it has been idle 14 days.

## [0.1.2] - 2026-10-15

### Fixed

- Setting up a one-project install now offers to remove a VArgus status-line command an earlier
  setup left in your user settings, which blanked the row in every other project; 0.1.1 wrote
  the project's `.claude/settings.local.json` but left that one in place.

## [0.1.1] - 2026-10-15

### Fixed

- **A one-project install no longer blanks the status line in every other project.** The
  `vargus-setup` skill put the status-line command in your user settings whatever scope the
  plugin was installed at; installed for one project only, the mod writes no line elsewhere, so
  every other project's row stayed blank. The skill now reads the install scope (`claude plugin
  list --json`): at user scope it writes your user settings as before; at project or local scope
  it offers a user-scope install, or puts the command in that project's
  `.claude/settings.local.json`. It also stops when the plugin came from a marketplace not named
  `vargus` (the line would stay blank), and its uninstall step names the scope.
- README: install at user scope; the uninstall command with its scope.

### Added

- README: **install from a clone**, updated with `git pull` and `/reload-plugins` (a folder
  marketplace is read from the folder, also across a version change).

## [0.1.0] - 2026-10-15

The first release: VantageHUD 0.6.0's status line, rebuilt as a Claude Code mod. The mod keeps the
numbers in memory, renders the line and writes it to a file; the `statusLine` command is one
`cat` of that file (2-3 ms), so the line refreshes every second, also while the session is idle
or subagents work. Needs Claude Code 2.1.299 or later.

### Added

- **The line**, VantageHUD's fragments in its order, each with a `/config` switch and
  VantageHUD's default: folder, `model:effort`, rate limits (`5h:`/`7d:` with countdowns; `sn:`
  from 80 %, `op:`, `extra:` from the usage API; other models' weekly and a gateway's `spend:`
  off by default), `ctx:` (`COMPRESS?` from 80 %, `CRITICAL` from 85 %), `token:`, `session:`,
  call counts (`🔧` `🤖` `⚡`, workflow runs off by default; `T:`/`A:`/`S:` on WSL), and
  `repo:`/`branch:`/status for git, or svn outside a git worktree (a named detached HEAD off by
  default).
- **Token counts from each API request**, main conversation and subagents together, counted
  since the mod loaded or the last `/clear` or resume; no transcript parsing and no `~` lower
  bound.
- **Themes**: VantageHUD's five palettes (`aurora`, `ember`, `nebula`, `graphite`, `daylight`) in
  24-bit colour, default `graphite`; `NO_COLOR` turns colour off.
- **Fits the row**: when the row is too narrow, whole fragments are dropped from the end.
- **One line file per session**, replaced whole by a temp file and `mv`, so the status line never
  shows a half-written line (0 wrong reads in 740,432 while it was rewritten 4,300 times).
- **`vargus-setup` skill**: Claude writes (or removes) the `statusLine` entry for you.

### Not carried over from VantageHUD

- `cache:` (no mod event reports the prompt cache's lifetime outside a model switch), the spend
  limit's dollars, 256/16-colour conversion, bar gauges, custom themes, label overrides and the
  zh-CN labels.

[Unreleased]: https://github.com/zhoufanscut/VArgus/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/zhoufanscut/VArgus/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/zhoufanscut/VArgus/compare/v0.4.4...v0.5.0
[0.4.4]: https://github.com/zhoufanscut/VArgus/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/zhoufanscut/VArgus/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/zhoufanscut/VArgus/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/zhoufanscut/VArgus/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/zhoufanscut/VArgus/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/zhoufanscut/VArgus/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/zhoufanscut/VArgus/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/zhoufanscut/VArgus/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/zhoufanscut/VArgus/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/zhoufanscut/VArgus/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/zhoufanscut/VArgus/releases/tag/v0.1.0
