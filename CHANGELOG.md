# Changelog

Notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/zhoufanscut/VArgus/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/zhoufanscut/VArgus/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/zhoufanscut/VArgus/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/zhoufanscut/VArgus/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/zhoufanscut/VArgus/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/zhoufanscut/VArgus/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/zhoufanscut/VArgus/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/zhoufanscut/VArgus/releases/tag/v0.1.0
