# Changelog

Notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.1]: https://github.com/zhoufanscut/VArgus/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/zhoufanscut/VArgus/releases/tag/v0.1.0
