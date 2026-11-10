# VArgus

A status line for **Claude Code and Codex CLI**: context, rate limits with reset
countdowns, token and call counts, and repository status.

Claude Code can show it under the prompt through a plugin, or in tmux. Codex CLI
uses a tmux row inside ordinary, unmodified Codex. Both hosts share the renderer,
fragment switches and colour themes; each collects its own readings.

VArgus replaces [VantageHUD](https://github.com/zhoufanscut/VantageHUD).
[DESIGN.md](DESIGN.md) explains the implementation and its verification limits;
[CHANGELOG.md](CHANGELOG.md) records each release.

## Contents

- [Choose your setup](#choose-your-setup), [Requirements](#requirements)
- [What it shows](#what-it-shows), [How it works](#how-it-works)
- [Codex CLI](#codex-cli): [agent setup](#set-up-codex-with-an-agent), [manual setup](#set-up-codex),
  [automatic startup](#automatic-startup-in-codex),
  [configure](#configure-codex), [update](#update-codex), [uninstall](#uninstall-codex)
- [Claude Code](#claude-code): [setup](#set-up-claude), [configure](#configure-claude),
  [update](#update-claude), [uninstall](#uninstall-claude), [tmux launcher](#claude-tmux-launcher)
- [Development](#development)

## Choose your setup

| Host | Display | Start here |
|---|---|---|
| Claude Code | Inline row under the prompt | [Install the Claude plugin](#set-up-claude) |
| Codex CLI | tmux row | [Ask an agent to set it up](#set-up-codex-with-an-agent), or [set it up by hand](#set-up-codex) |
| Claude Code | tmux row | [Launch `vargus claude --tmux`](#claude-tmux-launcher) |

The Claude plugin installation is only for Claude Code. Codex uses this clone's
CLI entry and does not need the Claude plugin. Automatic startup in Codex requires
[hook setup and trust](#automatic-startup-in-codex); manual controls work without it.

## Requirements

| Display | Requirements |
|---|---|
| Claude inline | Claude Code 2.1.299 or later in a terminal; POSIX `sh` on Linux/macOS, or Git for Windows on Windows |
| Either host through tmux | The host CLI, Bash, Node.js 24.12 or later, and tmux on Linux or macOS; Codex also needs saved session logs |
| Codex through native Windows psmux | Codex CLI, PowerShell, Node.js 24.12 or later, psmux, and saved session logs |

The Claude inline plugin needs no Node install. The tmux commands run TypeScript
source directly and need no npm install or build. Git supplies repository readings;
Claude's collector also supports svn working copies. Codex currently reads git only.

Live tmux checks cover Linux with Node.js 24.14.1, tmux 3.5a, Codex 0.167.0 and
Claude Code 2.1.319. Other host versions and macOS need their own live verification.
Claude inline Windows checks and limitations are described [below](#claude-code).
Native Windows Codex checks cover Codex 0.167.0, Node.js 24.21.0 and psmux 3.4.0
with an isolated local mock provider. See [Windows setup](#native-windows-setup).

## What it shows

Examples rendered with illustrative values. Claude Code:

```
~/proj/VArgus | opus:high | 5h:4%(4h37m) 7d:39%(5d6h) | ctx:20% | token:69.5k | session:24m | 🔧73 🤖2 ⚡1 | repo:VArgus | branch:main | ?4
```

Codex CLI:

```
~/proj/VArgus | sol:xhigh | 5h:4%(4h37m) 7d:39%(5d6h) | ctx:20% | token:69.5k | session:24m | 🔧73 🤖2 ⚡1 | repo:VArgus | branch:main | ?4
```

| Fragment | What it is |
|---|---|
| `~/proj/VArgus` | the working folder |
| `opus:high` / `sol:xhigh` | the model and effort level |
| `5h:` `7d:` | reported rate-limit windows, used percent and time until reset; Codex uses the recorded window duration |
| `ctx:` | how full the context window is |
| `token:` | uncached input plus output tokens; the collection scope differs by host, as described below |
| `session:` | age from the host-reported start time; Codex uses the displayed saved log's creation time |
| `🔧` `🤖` `⚡` | tool, agent and skill counts, with host-specific rules below |
| `repo:` `branch:` | repository and branch; Claude supports git and svn, Codex supports git |
| `?4` | working-tree status: staged `+`, modified `!`, untracked `?`, conflicts `✗`, ahead `⇡`, behind `⇣` |

Claude's token total includes the main conversation and subagents since the mod
first loaded, or since the last `/clear` or in-session resume. Cache reads and
writes are excluded. Its tool, agent and skill counts come from main-loop tool
starts. Separate teammates in their own panes are outside that collector.

Codex shows the displayed conversation's saved readings. Child totals are not
summed into the parent. Tools count completed visible items, agents count recorded
starts, and skills count observed loads. See [Readings and view changes](#readings-and-view-changes)
for the saved-log boundaries and missing readings.

Each fragment has a switch: [Claude's `/config`](#configure-claude) or
[Codex's CLI options](#configure-codex). Claude can also show per-model weekly
limits and a gateway spend limit; Codex uses its recorded quota windows. The
Claude detail pane and workflow count are not available in Codex.

## How it works

Claude Code's plugin keeps a mod loaded in the session. The mod observes usage,
tools, agents and repository changes, renders the line, and writes it to a file.
The inline `statusLine` command prints that file. The optional Claude tmux launcher
reads a separate launch-local line from the same mod.

Codex uses a background helper that reads saved session logs, identifies the
conversation currently displayed, and sends the rendered line to tmux. It hides
and restores the native footer through session-only `/statusline` commands.
Controls such as `!vargus on` run locally through Codex's shell mode.

The tmux row follows the active pane. Both hosts use shared rendering and themes,
while their collectors remain separate. [DESIGN.md](DESIGN.md#hosts-and-outputs)
contains the architecture, restoration rules and live verification limits.

## Codex CLI

### Set up Codex with an agent

From a VArgus checkout, ask your coding agent:

> Read this repository's README.md and set up VArgus for Codex, including the
> `vargus` PATH symlink and automatic startup hooks.

Search phrases for this workflow: `set up VArgus for Codex`, `VArgus Codex setup`,
`VArgus symlink`, `VArgus Codex hooks`.

When the user requests this setup, the agent should:

1. Check the [requirements](#requirements). Reuse the current VArgus checkout or
   an existing installation; report missing prerequisites before continuing.
2. Create or verify the `vargus` symlink using the [manual setup](#set-up-codex):
   `~/.local/bin/vargus` points to the chosen checkout's absolute `bin/vargus` path.
   Inspect an existing entry before changing it; preserve an unrelated command.
   Ensure the chosen directory is on the user's PATH and `vargus --help` resolves
   through that entry. A different PATH directory works too; use its quoted
   entrypoint in both hook commands below.
3. Resolve the Codex home from `CODEX_HOME`, or `~/.codex` when unset. Read its
   existing `hooks.json` and `config.toml` before editing, then create the
   `vargus/autostart` directory shown under [automatic startup](#automatic-startup-in-codex).
4. Merge the shown **SessionStart** and **UserPromptSubmit** callbacks into
   `hooks.json`, preserving unrelated hooks and settings. Update existing VArgus
   callbacks in place so repeating setup does not add duplicates. Verify that the
   effective `codexAutoStart` setting is true; the default setup needs no options
   file or `--config` argument.
5. Ensure the saved `[tui].status_line` selection in `config.toml` has exactly one
   **Thread ID** item. Keep the first existing `thread-id` or legacy `session-id`
   entry and remove extra identity entries; append `thread-id` only when neither
   spelling exists. Retain all other items and their order. Use the example below
   when no selection exists, and keep the full ID visible according to the
   [terminal-width notes](#narrow-terminals-and-ssh). Preserve other TOML settings.
6. Validate the edited configuration and the symlink, then report the actual
   checkout, PATH entry, Codex home and files changed. Runtime commands use the
   source directly; this setup needs no npm install or build.
7. Hand back the normal trust step: the user reopens Codex in tmux, reviews and
   trusts both VArgus callbacks through `/hooks` or the startup dialog, and sends
   a normal prompt. In checked Codex 0.167.0, activation waits for that first
   prompt. Confirm with `!vargus status` in the intended Codex TUI. Report prepared
   files separately from confirmed activation; leave hook trust to Codex's UI.

The following sections provide the exact symlink command, hook JSON and footer
TOML for this workflow.

On native Windows, follow [Windows setup](#native-windows-setup): use a `.cmd`
PATH entry and Windows hooks instead of the Bash symlink. Preserve an existing
unrelated command, hooks and saved footer items in the same way.

### Set up Codex

Clone VArgus and expose its Bash entry through a symlink in a directory on your
PATH. This example uses `~/.local/share/VArgus`; any clone location works:

```sh
mkdir -p "$HOME/.local/share" "$HOME/.local/bin"
git clone https://github.com/zhoufanscut/VArgus "$HOME/.local/share/VArgus"
ln -s "$HOME/.local/share/VArgus/bin/vargus" "$HOME/.local/bin/vargus"
```

Make sure `~/.local/bin` is on your PATH. If you already have a VArgus clone, use
its absolute `bin/vargus` path as the symlink target instead of cloning again.

Start ordinary `codex` in tmux. Run controls from its primary conversation view:

```text
!vargus on
!vargus status
!vargus reload
!vargus off
```

`!` runs a local shell command; no model decides how to run the control. With
manual setup, the row starts off. `on` starts a small background Node helper that
reads this conversation's saved session log and uses the shared renderer/tmux output. Code stays in the
clone. Codex is not patched or rebuilt.

Automatic selection uses the default tmux server and requires one matching Codex
pane. With several matching panes, select the intended one explicitly:

```text
!vargus on --pane %3
```

A custom tmux socket also needs `--socket /path/to/socket`. Codex's shared daemon
can inherit another terminal's environment, so pane selection does not trust
`TMUX_PANE`. Once attached, `off`, `status` and `reload` use the saved thread binding.
`--theme ember` and `--config /path/to/options.json` apply on activation.

### Native Windows setup

Run Codex in native **psmux**, with Windows Node and PowerShell. Use this checkout's
`bin\vargus.cmd`; it runs the TypeScript source directly and needs no Bash, build
or npm install. Put a small forwarding file named `vargus.cmd` in a user PATH
directory, for example `%USERPROFILE%\.local\bin`:

```bat
@echo off
"H:\VArgus\bin\vargus.cmd" %*
```

Replace `H:\VArgus` with your checkout's absolute path. Inspect any existing
`vargus` command before writing this file. Add its directory to the **user** PATH
if needed and reopen the terminal, then check `vargus --help`. A forwarding file
keeps the repository-relative entry intact and needs no symlink privileges.

Use the [automatic startup](#automatic-startup-in-codex) JSON structure, replacing
the two command strings with PowerShell commands for your actual user path:

```json
"command": "& 'C:\\Users\\you\\.local\\bin\\vargus.cmd' hook session-start"
```

```json
"command": "& 'C:\\Users\\you\\.local\\bin\\vargus.cmd' hook prompt"
```

Keep `async: true`, `timeout: 30` and the SessionStart matcher. Use Windows
`CODEX_HOME` when set, otherwise `%USERPROFILE%\.codex`; create
`vargus\autostart` there and include one full `thread-id` in the saved footer.
Preserve existing callbacks and settings. Reopen Codex in psmux, trust both
callbacks through `/hooks`, send a normal prompt and check `!vargus status`.

Windows background child processes use hidden windows. Windows process lookup
uses CIM rather than Unix `ps`. With psmux's built-in bar, VArgus appears above
the original session/window/right-side information. The bar stays at its saved
top/bottom position, and disabling VArgus restores the original scalar settings.
Unwrapped panes keep the original information while their VArgus header stays
blank. Routine updates publish differences together and use psmux's automatic
redraw instead of forcing another refresh for unchanged readings.
psmux 3.4.0 cannot read raw custom `status-format[]` values; an existing custom
first row or multi-row layout is retained, with VArgus appended after it. Original
formats that execute `#()` commands, including global window separators and flag
styles, also retain that layout to preserve psmux's asynchronous command cache.
Window-local bar formats and styles keep native rendering with VArgus appended;
adding an override while VArgus runs switches to that layout automatically.
Failed attachment restores the original scalar settings and row count while
preserving other active owners. Inactive
windows wait for a visit before footer automation; an existing inactive custom
slot blocks activation, even when its text currently expands empty. VArgus
retains its own hidden format slot for repeat activation without overwriting row zero. An originally hidden
bar uses two rows while VArgus is active and returns to hidden on shutdown.
Windows verification covers automatic
startup, token display, `on/status/reload/off`, preserving a custom first row and
sharing the added row between two owners. Windows subagent navigation and draft
scenarios and shared-daemon mode need their own live verification. The native
TUI rig uses `--no-daemon`; an independent real-TUI probe also verified `!` shell
controls and that a normal prompt after manual off leaves the row off.

### Readings and view changes

The helper follows the displayed parent or subagent through Alt+Left/Right and
`/subagents`. Each view shows its own recorded readings; child totals are not
aggregated. VArgus matches Codex's contextual agent label to saved session metadata.
If a popup, clipped label or ambiguous agent path prevents identification, the row
blanks until the view can be identified again, except for the last-confirmed draft
snapshot described below. `status` reports the current view or pause.
Without the optional startup hook, after `/new` or `/resume` run `!vargus on` again (with pane selection if needed)
to bind the new conversation. Its token total covers recorded uncached input and output.
Tool counts replay completed visible items and exclude `!` controls. `🤖2` counts
recorded subagent starts in the displayed conversation; `⚡3` counts observed skill
loads, once per skill path per user turn. Workflow counts are omitted. Missing readings stay hidden.
Ephemeral chats without a saved transcript are unsupported. Log-backed readings
update when Codex writes them; model/effort picks are not inferred ahead of that.
For paginated subagent logs with Codex's recorded history boundary, VArgus skips
inherited parent activity and counts the child's own work. Inherited skill catalogs
can still identify later skill reads by the child. Logs without that supported
boundary can initially report `The transcript belongs to another Codex thread.`
through `status`; later refreshes can advance past the error. Readings from those
mixed logs remain unsupported, and their subagent and skill counts stay omitted.

### Footer restoration and typing

`on` also hides Codex's configurable footer in each recognized view you visit.
`off` removes the tmux row immediately. A small helper restores the saved footer
layout as you visit affected views with an empty composer; it exits once all pending
views are restored or the Codex terminal process exits. Inactive views cannot be
restored immediately through Codex's session-only command. `!vargus status` reports
pending restorations. Running `on` again reuses the helper and original backups.
Backups from before `/new` or `/resume` remain eligible for restoration. Visit
each affected conversation with an empty composer; if its saved footer has no
full thread ID, run `!vargus off` in that conversation's primary view to confirm
its identity and finish restoration, using pane/socket selection when needed.
Rebinding a pending restore helper with `off` preserves its display options for
a later `on`.

VArgus preloads saved footer settings per known workspace before checking the view,
so a first subagent visit can use the cached layout. Explicit `on` refreshes that
cache while keeping existing restore backups. A footer that already hides the full
agent label can still pause automation. No status cards or extra menus are opened.
VArgus sends session-only `/statusline` commands through tmux, including in read-only
subagent views. Codex's shortcut/context hint
row remains. Saved config files are not rewritten. Backups survive a helper crash;
`!vargus off` restarts restoration. If its transcript is unavailable after a crash,
`off` still removes the abandoned row and keeps footer backups pending. Restore the
native footer through `/statusline` or restart Codex; retry `off` when the log is
available to resume automatic restoration. An already-empty saved footer stays empty.

Leave the composer empty when switching views and wait for footer automation before
typing. Drafts pause footer automation and are preserved. Standalone Codex keeps
the last confirmed readings while typing hides the view label, including with plain
`!vargus on`; no options file is needed. Readings and time stay frozen without an
extra label in the row; `!vargus status` reports that the current view is unknown.
These historical readings may belong to a different view after navigation.
Live readings resume when the view is identified again. This needs a previously
rendered snapshot in the current helper plus the native `% context left` or matched
`Shell mode` hint. A native warning notice beside the hint keeps these readings
visible. Dialogs, explicit foreign/clipped identities and unsupported
layouts still blank the row. Reloading discards the snapshot until a view is
recognized again. See [Narrow terminals and SSH](#narrow-terminals-and-ssh) for
footer clipping and restore commands that would wrap. A visible native statusline error
makes completion inconclusive, including an error from an earlier attempt: the
backup remains. Resolve the error and move it out of view before retrying. This is
TUI automation; tmux does not provide an atomic lock on Codex's editor. Simultaneous
typing or navigation can still race the observations. Temporary session-only
`/statusline` selections and launch-time overrides cannot be read back reliably:
restoration uses saved configuration, including its default layout when unset.

Codex can report a current transcript with an extra UUID suffix while an older
same-thread file remains. VArgus uses the reported path and validates its metadata;
it does not pick the newest filename. The root view stays pinned to that path.

Saved session logs and composer recognition are version-sensitive interfaces.
Compatibility is checked with fixtures and a live official-Codex/local-mock test
on 0.167.0. Other prompt layouts can require a compatibility update.

#### Narrow terminals and SSH

Check the tmux pane's column width when switching terminals or SSH clients. A
footer that fits one terminal can be clipped in another. There are two separate
width limits:

- **`on` reports an unknown view:** a clipped session ID can prevent recognition.
  Shorten the native footer or widen the pane. `thread-id` need not be first if
  the entire footer fits without clipping. Putting it first in the saved layout
  tolerates clipped later items, provided the full ID remains visible.
- **`off` asks for a wider pane:** VArgus restores the saved layout by typing
  `/statusline <item names>` into Codex. That command can be longer than the footer
  it produces. VArgus currently rejects commands that would wrap; this is an
  automation limit. The tmux row is removed immediately, but restoration stays
  pending. Widen the pane, leave the composer empty and retry `!vargus off`.

For future activations, keep the saved footer short enough for both limits.
Changing saved settings does not replace an existing restoration backup; finish
the pending restore before relying on a shorter layout for a new `on`/`off` cycle.

### Automatic startup in Codex

`codexAutoStart` defaults to true. Installed, trusted hooks use the defaults;
an options file or `--config` argument is not needed.

Create the startup state directory before your first session. This lets
`!vargus off` remember your choice before any startup callback has run:

```sh
mkdir -p "${CODEX_HOME:-$HOME/.codex}/vargus/autostart"
```

Add these entries to Codex's `hooks.json` in `${CODEX_HOME:-$HOME/.codex}`,
preserving any existing hooks:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "^(startup|resume|clear|fork)$",
        "hooks": [
          {
            "type": "command",
            "command": "\"$HOME/.local/bin/vargus\" hook session-start",
            "async": true,
            "timeout": 30
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"$HOME/.local/bin/vargus\" hook prompt",
            "async": true,
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

Include **Thread ID** (`thread-id`) in your saved Codex footer selection; the older
`session-id` alias also works. It can go at the tail
when the entire footer fits. See [Narrow terminals and SSH](#narrow-terminals-and-ssh).
For example, merge this into the existing `[tui]` table in the same home's
`config.toml`, retaining any other footer items you want restored by `!vargus off`:

```toml
[tui]
status_line = ["model-with-reasoning", "current-dir", "thread-name", "thread-id"]
```

Start ordinary `codex` in tmux, then review and trust the hook
through `/hooks`. When removing an older `--config` argument, update both VArgus
commands and review their changed definitions in a reopened TUI before deleting
the old options file. Trust both entries, including the prompt fallback when upgrading
from a SessionStart-only setup. Shared-daemon mode is supported. In checked Codex 0.167.0,
SessionStart runs with the first prompt: the native footer displays the thread ID
until then. Reopening a thread already loaded in the shared daemon can omit
SessionStart; the UserPromptSubmit fallback covers that case on a normal prompt.
SessionStart scans foreground Codex panes on the selected tmux server,
with an eight-second retry deadline. It requires one full ID below a recognizably
empty composer that matches the event's saved transcript. It then uses the normal helper to
hide the native footer and attach the tmux row. `!vargus off` restores the saved
selection, including its ID. The [terminal-width notes](#narrow-terminals-and-ssh)
explain when to shorten the footer or put the ID first. Avoid invocation or
session-only footer overrides: automatic matching uses the saved layout.
Restart Codex after changing the saved item order so its displayed layout matches.

Prompt fallback makes one activation attempt. When the native ID is hidden
(already using VArgus), missing or explicitly suppressed by off, it returns before
starting a Codex config reader. It does not add an eight-second scan on every turn.

Missing/clipped IDs, drafts, unknown layouts and duplicate visible matches skip
automatic activation; use `!vargus on` when ready. Inherited `CODEX_THREAD_ID`,
terminal variables, directory names and transcript creation sources do not choose
a pane. Events for other displayed threads do not activate it. Matching identifies
the displayed conversation, not which frontend emitted the event. An ephemeral
session with no saved transcript is skipped. Custom tmux servers need
`--socket /path/to/socket`; `--pane %ID` restricts the match without bypassing the
full-ID and uniqueness checks. The callback scans panes itself and exits; no
permanent listener or launcher is required. Hook stdout adds no model context.

The prompt fallback respects manual off; later turns do not reactivate that row.
Compaction has no separate handler. Off also
records suppression before the first row attaches. Unbound controls on a custom
server need `--socket`; ambiguous panes can require `--pane`. Manual off is remembered per thread and TUI process under `~/.codex/vargus/autostart` (or your
`CODEX_HOME`), so delayed duplicate callbacks cannot undo it. Explicit
`!vargus on` clears that thread's suppression; another thread or a new Codex process
has its own state. `/new` and resume can activate through SessionStart or the
prompt fallback when the full ID is visible. Disable automatic startup by setting
`codexAutoStart` to false in an explicit `--config` file, or disabling the hook
through `/hooks`; use
`!vargus off` to remove an active row. Saved footer settings are changed only by
the setup step above; on/off still use session-only commands.

### Configure Codex

Defaults work without an options file. For a different theme or fragment switches,
pass `--theme NAME` or `--config /absolute/path/to/vargus.json` on first activation.
To change a running helper's options, use `reload` with those flags:

```text
!vargus on --theme ember
!vargus reload --theme graphite
```

An optional JSON config uses the same keys and defaults as
[`src/options.ts`](src/options.ts). For example:

```json
{
  "theme": "ember",
  "session": false
}
```

Pass it with `!vargus on --config /absolute/path/to/vargus.json`, or with
`!vargus reload --config /absolute/path/to/vargus.json` for an existing helper.
`NO_COLOR` disables colours in the environment that starts the helper.

Codex always displays known model families as `astra`, `sol`, `terra` or `luna`, for example
`sol:xhigh`. Both `gpt-6-sol` and `gpt-6.1-sol` display `sol`; unfamiliar IDs remain
whole. The former `codexShortModel` option is ignored in existing options files.
Subagent counts and skill counts default to on for Codex; set `codexAgentCounts`
or `codexSkillCounts` to `false` in a JSON options file passed with `--config` to
disable either. These switches do not affect Claude. `model` and `callCounts`
still control their whole fragments.

Codex Fast mode adds `(fast)` beside the model and effort, such as `sol:max(fast)`.
The suffix is on by default when the displayed thread's saved settings select
Fast; Standard or unrecorded settings leave it out. Use Codex's `/fast` command
to toggle the mode. With `effort: false`, the display is `sol(fast)`.
The suffix follows recorded settings, like the model and effort readings.

Skill loads come from Codex's marked instruction injections or successful,
recognizable reads of a catalogued local `SKILL.md`. Repeated loads in the same
turn count once; loading it in a later turn counts again. Catalog entries, ordinary
mentions, references and failed reads do not add loads. This is an observed-load
count: cached reuse without a new load, unrecognized shell commands, and cloud or
executor skill loaders are not covered. It does not prove the instructions were
followed. The display uses the icon and count directly, such as `⚡3`.

### Update Codex

Update your clone with `git -C /absolute/path/to/VArgus pull`, or fetch tags and
check out the release you want. Then, in Codex:

```text
!vargus reload
```

This replaces the standalone helper with the current source while Codex, its daemon
and conversation keep running. It retains effective options, replays recorded readings,
rediscovers the displayed view, and keeps the
original footer backups. Plain `on` also upgrades an older helper with reload
metadata, preserving those options and backups; the retired draft-hold setting
cannot disable paused readings. Reload flags override retained options: `--config` merges
only supplied keys, and `--theme`/`--config` are applied in command order. A reload
while off stays off, including pending footer restoration and manual-off suppression
recorded by an interrupted off command.
An older helper without reload metadata stays running and reports how to migrate:
run `!vargus off`, then `!vargus on` with your original options once. Unreadable
history leaves a healthy helper running. Failed replacement retains backups and
options for another `reload`; `off` remains available for footer recovery. Reload
does not build or install anything.

### Uninstall Codex

1. If you installed automatic startup, remove only VArgus's command entries for
   `SessionStart` and `UserPromptSubmit` from `hooks.json` in your Codex home.
   Preserve other hooks and settings. Untrusted or modified entries can be removed
   from the file without trusting them first.
2. In each Codex TUI using VArgus, run `!vargus off`, then `!vargus status` while
   the clone and PATH entry still exist. If restoration is pending, visit the
   affected conversations with an empty composer and follow the
   [restoration notes](#footer-restoration-and-typing). Finish those restores, or
   exit Codex before removing the helper's source.
3. If you removed startup hooks, close the affected Codex TUIs before removing the
   PATH entry or clone. In checked Codex 0.167.0, reopening the TUI loads the updated
   hook definitions; reopening only `/hooks` inside a running TUI keeps the removed
   entries in its cached inventory.
4. Remove the PATH symlink you created for `vargus`, after checking its target with
   `readlink "$HOME/.local/bin/vargus"`. Keep it if you still use the Claude tmux
   launcher through that command. Delete the clone only when neither integration
   uses it; a Claude plugin installed from that folder still needs it.

On native Windows, remove only the forwarding `vargus.cmd` file you created,
after inspecting its checkout path. Keep the PATH directory if other commands use it.

The saved footer selection from hook setup is yours to keep or edit. `off` restores
that saved layout; it does not remove your `thread-id` preference.

## Claude Code

The inline plugin uses Claude's native status-line row. Its `vargus-setup` skill
handles that integration only. For a tmux row instead, use the
[Claude tmux launcher](#claude-tmux-launcher).

### Inline requirements

- Claude Code 2.1.299 or later, in a terminal. The status line is not shown in the VS Code chat
  panel or under `claude -p`.
- Linux or macOS: the status-line command is POSIX `sh`.
- Windows: only with [Git for Windows](https://git-scm.com/downloads/win) installed. Claude Code
  runs the status-line command through Git Bash when it finds it, else through PowerShell, where
  the VArgus command fails and the row stays blank. The setup skill checks this first and stops
  if the session has no Bash tool (no Git Bash). Tested on one Windows 11 machine (Git 2.56.0,
  Claude Code 2.1.300).

### Set up Claude

#### 1. Install the plugin

In Claude Code:

```
/plugin install vargus --marketplace zhoufanscut/VArgus
```

Answer `y` to add the marketplace, then pick the **user** scope, so the line shows in every
project. From a shell instead: `claude plugin install vargus --marketplace zhoufanscut/VArgus`
(user scope is the default). Installed for one project only, the mod runs only there: the setup
skill then offers a user-scope install, or puts the status-line command in that project's
`.claude/settings.local.json`, since in your user settings it would leave the row blank in every
other project.

##### Or from a clone, updated with `git pull`

```sh
git clone https://github.com/zhoufanscut/VArgus ~/.claude/VArgus   # any folder works
claude plugin marketplace add ~/.claude/VArgus
claude plugin install vargus@vargus                                # user scope by default
```

Claude Code reads a plugin from a folder marketplace straight from that folder (`claude plugin
list` shows `Read from: <folder>`), so `git -C ~/.claude/VArgus pull` updates it, no reinstall:
a new session runs the pulled code, also across a version change, and `/reload-plugins` brings it
into an open one. You then follow `main`, every commit as soon as you pull. To stay on a release
instead, fetch tags with `git -C ~/.claude/VArgus fetch --tags` and check out the
release tag you want (`pull` doesn't update a checked-out tag). Add only one of
the two marketplaces: both are named `vargus`.

#### 2. Load it

Run `/reload-plugins`, or start a new session, so the mod and its setup skill are loaded.

#### 3. Set up the status line

A plugin can't change your status line, so this step edits your settings once. Ask Claude:

> set up the VArgus status line

The plugin's `vargus-setup` skill tells Claude what to do: it shows your current `statusLine`
entry if you have one, asks before replacing it, and adds the VArgus one.

##### By hand

Add this to `~/.claude/settings.json` (or, for a plugin installed for one project only, to that
project's `.claude/settings.local.json`), replacing any `statusLine` entry you have. It assumes the
default config folder (`~/.claude`); with `CLAUDE_CONFIG_DIR` set, or on Windows, let the skill
do it.

```json
"statusLine": {
  "type": "command",
  "command": "cat \"$HOME/.claude/plugins/data/vargus-vargus/$CLAUDE_CODE_SESSION_ID/line\" 2>/dev/null",
  "refreshInterval": 1
}
```

With the **Blank a stopped line** option on ([Configure Claude](#configure-claude)), use this entry instead:

```json
"statusLine": {
  "type": "command",
  "command": "f=\"$HOME/.claude/plugins/data/vargus-vargus/$CLAUDE_CODE_SESSION_ID/line\"; [ -n \"$(find \"$f\" -mmin -2 2>/dev/null)\" ] && cat \"$f\"",
  "refreshInterval": 1
}
```

### Verify Claude works

Start a session and send one prompt. The line shows under the prompt within about two seconds
of the reply. If the row stays empty:

- the mod hasn't written the line yet: check that the plugin is enabled in `/plugin`;
- the folder isn't trusted yet: the status line stays blank until you accept the workspace trust
  dialog (statusline docs).

### Configure Claude

Options are shown in `/config` under the plugin. Existing option defaults are
documented below. The Codex model/counter defaults are described [above](#configure-codex);
their switches have no effect on the Claude line.

The spend limit (`spendLimit`), other models' weekly limits (`otherModelWeekly`),
workflow runs (`workflowRuns`) and detached-HEAD naming (`detachedHead`) default
to off. Sonnet's weekly `sn:` appears from 80% used; Opus's `op:` appears when
reported. Other models' weekly limits use the same threshold when enabled.

- **Theme**: one of five bundled palettes, `graphite` by default (near-monochrome; only the usage
  colours carry hue). All but `daylight` assume a dark terminal.
- **Blank a stopped line** (off by default): if the plugin stops mid-session (its module fails
  to load at `/reload-plugins`; turning it off is expected to do the same, not tested), the row
  goes blank within about two minutes instead of showing frozen numbers. After turning it on or
  off in `/config`, ask Claude to set up the VArgus status line again: the status-line command
  changes to one that checks the file's age, or back. The
  plugin rewrites the line every 30 s while it is on. Left with that command after turning the
  option off, the row goes blank whenever the line has not changed for two minutes.
- **Detail view** (off by default): turn on `detailView` in `/config`, then run `/vargus` to open
  a live pane (beside the conversation in the fullscreen layout from 110 columns, else above the
  prompt) with every rate limit and its reset time, the context window in tokens, tokens by agent
  (main conversation and each subagent: input, output, cache read and write) and the branch with
  the changed files. `/vargus` again or Esc closes it.
- **Colours off**: set `NO_COLOR` (to any non-empty value) in the environment you start Claude Code from.
  Other programs Claude Code starts see it too.

### Update Claude

```
/plugin update vargus
```

Then run `/reload-plugins`. Your `statusLine` entry doesn't change between versions. Installed
from a clone: `git -C <clone> pull` (or check out the newer tag), then `/reload-plugins`.

### Uninstall Claude

1. Remove the `statusLine` entry from `~/.claude/settings.json` (or, for a one-project install,
   that project's `.claude/settings.local.json`), or ask Claude to. Do this first:
   uninstalling deletes the plugin's data folder, and a status-line command left behind shows a
   blank row.
2. `claude plugin uninstall vargus@vargus --scope <scope>` from a shell (the scope you installed
   at; `user` is the default), or remove it in `/plugin` under **Installed**. From a clone, also
   `claude plugin marketplace remove vargus`.

### Claude limits

- Teammates that run in their own tmux pane are not seen.
- Data that only Claude Code's status-line input carries is not shown: lines changed, PR state,
  session name. The prompt-cache lifetime (`cache:`) is not shown.
- A session that ends without its end event (a crash, `kill -9`) leaves its small folder in the
  plugin's data folder until a later session removes it, 14 days after its last write. Where an
  organization refuses the mod's processes, every session's folder stays.
- Labels are English only for now.
- On Windows the mod moves and removes files with `cmd.exe` (`move`, `rmdir`). When the config
  folder's path holds a character cmd acts on (`&`, `,`, `;`, `=`, `^`, `%`, `!`, `(`, `)` and
  others), it hands cmd nothing: the line is written in place (a refresh can catch it
  half-written) and session folders are not removed.
- A line can lag the session by up to about two seconds. If the plugin stops (turned off, or a
  crash), the last line stays on screen with frozen numbers, unless **Blank a stopped line** is
  on.

### Rules carried over from VantageHUD

The Claude integration carries over VantageHUD's fragment order and presentation
rules. [DESIGN.md](DESIGN.md#rules-carried-over-from-vantagehud) records each rule
and its tests; Codex's saved-log collection is described separately under
[Hosts and outputs](DESIGN.md#hosts-and-outputs).

### Claude tmux launcher

Clone VArgus using the [clone instructions above](#set-up-codex), or use your existing
clone. Run from that clone; no npm install or `node_modules` folder is needed:

```sh
./bin/vargus claude --tmux
```

Put Claude arguments after `--`; VArgus options go before it:

```sh
./bin/vargus claude --tmux --theme ember -- --model sonnet
```

The launcher adds a row above your existing bar when the bar is at the bottom. It follows the
active tmux pane; switching to an unwrapped pane leaves the VArgus row blank. Multiple wrapped
panes share the row, and exiting the last wrapper restores the original bar. A bar already using
five rows is left alone. If you change its status formats while VArgus runs, your newer settings
are kept. After a killed/crashed wrapper, run `./bin/vargus tmux-reset` inside that tmux session;
it refuses while a wrapped process is still running.

The launcher hides Claude's configurable inline status line for that launch. Saved settings
are not edited. Claude's `tmuxOutput` option
defaults to off; the wrapper enables it through command-line settings and loads this clone's
mod with `--plugin-dir`. Enabling that option alone does not create a tmux row.

Use `--config /path/to/vargus.json` for a JSON object of fragment switches and theme, with the
same keys as the Claude plugin's `userConfig`. `NO_COLOR` disables VArgus colours. The Claude
wrapper's explicit options apply to its inline-loaded copy, so pass your preferred theme here.

## Development

- [DESIGN.md](DESIGN.md): how VArgus works, every rule with its reason, and what is still to be
  checked.
- [AGENTS.md](AGENTS.md): working rules for coding agents in this repo.
- Node development only: `npm ci`, `npm test` (tests require Codex CLI and tmux).
  On Windows, `npm test` runs shared checks and the native Codex/psmux rig;
  POSIX executable-shim and Linux engine rigs are excluded and reported.
  All npm dependencies are development/test tools; users run the source directly.
- Claude checks: `npm run test:claude` runs plugin validation, type-checking, engine
  tests, and the reader/manifest checks. DESIGN.md "Tests" has the details.
