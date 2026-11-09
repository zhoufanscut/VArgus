# VArgus

A status line for [Claude Code](https://code.claude.com/docs/en/overview) that keeps up with the
session: context, rate limits with live countdowns, token counts from each API request (subagents
included) and git, in the status-line row under the prompt.

An optional tmux row also supports Codex CLI, and can display Claude Code through the same
output. See [tmux output](#tmux-output). Normal Claude inline setup needs no Node install.

VArgus replaces [VantageHUD](https://github.com/zhoufanscut/VantageHUD). How it works, rule by
rule, is in [DESIGN.md](DESIGN.md); what changed in each version, in [CHANGELOG.md](CHANGELOG.md).

## Contents

- [What it shows](#what-it-shows), [How it works](#how-it-works),
  [Compared with VantageHUD](#compared-with-vantagehud)
- [tmux output](#tmux-output), [Requirements](#requirements), [Setup](#setup), [Verify it works](#verify-it-works)
- [Configure](#configure), [Update](#update), [Uninstall](#uninstall)
- [Limits](#limits), [Development](#development)

## What it shows

A planned line (numbers made up):

```
~/proj/VArgus | opus:high | 5h:4%(4h37m) 7d:39%(5d6h) | ctx:20% | token:69.5k | session:24m | 🔧73 🤖2 ⚡1 | repo:VArgus | branch:main | ?4
```

| Fragment | What it is |
|---|---|
| `~/proj/VArgus` | the working folder |
| `opus:high` | the model and effort level |
| `5h:` `7d:` | rate-limit windows, used percent and time until each resets; a spend limit (off by default); per-model weekly limits (`sn:` from 80 %, `op:`; other models off by default) |
| `ctx:` | how full the context window is |
| `token:` | tokens since the mod loaded or the last `/clear` or resume, from each API request, the main conversation and subagents together |
| `session:` | time since the session started |
| `🔧` `🤖` `⚡` | tool calls, agents started, skills used |
| `repo:` `branch:` | repository and branch (svn working copies too) |
| `?4` | working-tree status: staged `+`, modified `!`, untracked `?`, conflicts `✗`, ahead `⇡`, behind `⇣` |

These are VantageHUD's fragments, in its order. Each has an option in `/config`; the ones off by
default are the spend limit, other models' weekly limits, workflow runs and naming a detached
HEAD. VantageHUD's `cache:` (off by default there) is not in 0.1.0: outside a model switch no
event tells the mod how long the prompt cache lasts.

## How it works

```
Claude Code ──events──▶ VArgus mod ──writes──▶ line file ◀──cat── your statusLine command
               (usage, tools, agents,   (one per session)        (runs every second)
                limits, git)
```

VArgus has two parts:

1. **A mod** (a Claude Code plugin whose code stays loaded for the whole session). It hears what
   happens in the session, including each API request's exact token usage and every subagent,
   keeps the numbers in memory, and writes the finished line to a small file.
2. **Your `statusLine` command**, a one-line shell command that prints that file. It costs about
   2-3 ms, so Claude Code can run it every second and the countdowns keep moving while the
   session is idle. The mod writes each line to a temporary file and renames it into place, so
   the command doesn't see a half-written line.

## Compared with VantageHUD

| | VantageHUD | VArgus |
|---|---|---|
| Each refresh | starts Node (a bare Node start alone is about 37 ms) | prints a file (2-3 ms) |
| While idle or while subagents work | the line can freeze | refreshes every second |
| Token counts | rebuilt from transcript files, a lower bound (`token:~`) | from each API request, per agent, since the mod loaded (or the last `/clear` or resume) |
| Colours | detects colour depth, converts to 256 or 16 colours | 24-bit colour; `NO_COLOR` turns it off |
| Not shown any more | | the spend limit's dollars; `cache:` |

## tmux output

Opt-in, for either host. Requires Node.js 24.12 or later and tmux on Linux or macOS; the live
startup checks were on Linux with tmux 3.5a, Codex 0.167.0 and Claude Code 2.1.319.
The sections below this one describe the existing Claude inline plugin.

### Inside official Codex

VArgus stays in this clone. Requires Bash, Node.js 24.12+ and tmux. It runs the
`.ts` source directly; no npm install, `node_modules` folder or build is needed. Expose the Bash entry
through a symlink in a directory on your PATH:

```sh
mkdir -p "$HOME/.local/bin"
ln -s /absolute/path/to/VArgus/bin/vargus "$HOME/.local/bin/vargus"
```

Start ordinary `codex` in tmux. Run controls from its primary conversation view:

```text
!vargus on
!vargus status
!vargus reload
!vargus off
```

`!` runs a local shell command; no model decides how to run the control. The row
starts off. `on` starts a small background Node helper that reads this conversation's
saved session log and uses the shared renderer/tmux output. Code stays in the
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

After updating the clone, run `!vargus reload` in Codex. This explicit command
replaces the standalone helper with the current source while Codex, its daemon and
conversation keep running. It retains effective options, replays recorded readings,
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

Codex displays known model families as `astra`, `sol`, `terra` or `luna`, for example
`sol:xhigh`. Both `gpt-6-sol` and `gpt-6.1-sol` display `sol`; unfamiliar IDs remain
whole. Short names, subagent counts and skill counts default to on for Codex and
have individual switches: `codexShortModel`, `codexAgentCounts`, `codexSkillCounts`.
Set any to `false` in a JSON options file passed with `--config` when starting the
helper. These switches do not affect Claude. `model` and `callCounts` still control
their whole fragments.

Skill loads come from Codex's marked instruction injections or successful,
recognizable reads of a catalogued local `SKILL.md`. Repeated loads in the same
turn count once; loading it in a later turn counts again. Catalog entries, ordinary
mentions, references and failed reads do not add loads. This is an observed-load
count: cached reuse without a new load, unrecognized shell commands, and cloud or
executor skill loaders are not covered. It does not prove the instructions were
followed. The display uses the icon and count directly, such as `⚡3`.

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
`Shell mode` hint. Dialogs, explicit foreign/clipped identities and unsupported
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

Add this entry to Codex's `~/.codex/hooks.json`, preserving any existing hooks:

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
For example, merge this into the existing `[tui]` table in `~/.codex/config.toml`, retaining any other
footer items you want restored by `!vargus off`:

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

### Claude tmux launcher

Run from this clone; no npm install or `node_modules` folder is needed:

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

## Requirements

- Claude Code 2.1.299 or later, in a terminal. The status line is not shown in the VS Code chat
  panel or under `claude -p`.
- Linux or macOS: the status-line command is POSIX `sh`.
- Windows: only with [Git for Windows](https://git-scm.com/downloads/win) installed. Claude Code
  runs the status-line command through Git Bash when it finds it, else through PowerShell, where
  the VArgus command fails and the row stays blank. The setup skill checks this first and stops
  if the session has no Bash tool (no Git Bash). Tested on one Windows 11 machine (Git 2.56.0,
  Claude Code 2.1.300).

## Setup

### 1. Install the plugin

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

#### Or from a clone, updated with `git pull`

```sh
git clone https://github.com/zhoufanscut/VArgus ~/.claude/VArgus   # any folder works
claude plugin marketplace add ~/.claude/VArgus
claude plugin install vargus@vargus                                # user scope by default
```

Claude Code reads a plugin from a folder marketplace straight from that folder (`claude plugin
list` shows `Read from: <folder>`), so `git -C ~/.claude/VArgus pull` updates it, no reinstall:
a new session runs the pulled code, also across a version change, and `/reload-plugins` brings it
into an open one. You then follow `main`, every commit as soon as you pull. To stay on a release
instead, `git -C ~/.claude/VArgus checkout v0.1.1`; to update, `git -C ~/.claude/VArgus fetch
--tags` and check out the newer tag (`pull` doesn't work on a checked-out tag). Add only one of
the two marketplaces: both are named `vargus`.

### 2. Load it

Run `/reload-plugins`, or start a new session, so the mod and its setup skill are loaded.

### 3. Set up the status line

A plugin can't change your status line, so this step edits your settings once. Ask Claude:

> set up the VArgus status line

The plugin's `vargus-setup` skill tells Claude what to do: it shows your current `statusLine`
entry if you have one, asks before replacing it, and adds the VArgus one.

#### By hand

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

With the **Blank a stopped line** option on ([Configure](#configure)), use this entry instead:

```json
"statusLine": {
  "type": "command",
  "command": "f=\"$HOME/.claude/plugins/data/vargus-vargus/$CLAUDE_CODE_SESSION_ID/line\"; [ -n \"$(find \"$f\" -mmin -2 2>/dev/null)\" ] && cat \"$f\"",
  "refreshInterval": 1
}
```

## Verify it works

Start a session and send one prompt. The line shows under the prompt within about two seconds
of the reply. If the row stays empty:

- the mod hasn't written the line yet: check that the plugin is enabled in `/plugin`;
- the folder isn't trusted yet: the status line stays blank until you accept the workspace trust
  dialog (statusline docs).

## Configure

Options are shown in `/config` under the plugin. Existing option defaults are
documented below. The Codex model/counter defaults are described [above](#inside-official-codex);
their switches have no effect on the Claude line.

- **Theme**: one of five bundled palettes, `graphite` by default (near-monochrome; only the usage
  colours carry hue). All but `daylight` assume a dark terminal.
- **Blank a stopped line** (off by default): if the plugin stops mid-session (its module fails
  to load at `/reload-plugins`; turning it off is expected to do the same, not tested), the row
  goes blank within about two minutes instead of showing frozen numbers. After turning it on or
  off in `/config`, ask Claude to set up the VArgus status line again: the status-line command
  changes to one that checks the file's age (about 3.4 ms a run instead of 1.9 ms), or back. The
  plugin rewrites the line every 30 s while it is on. Left with that command after turning the
  option off, the row goes blank whenever the line has not changed for two minutes.
- **Detail view** (off by default): turn on `detailView` in `/config`, then run `/vargus` to open
  a live pane (beside the conversation in the fullscreen layout from 110 columns, else above the
  prompt) with every rate limit and its reset time, the context window in tokens, tokens by agent
  (main conversation and each subagent: input, output, cache read and write) and the branch with
  the changed files. `/vargus` again or Esc closes it.
- **Colours off**: set `NO_COLOR` (to any non-empty value) in the environment you start Claude Code from.
  Other programs Claude Code starts see it too.

## Update

```
/plugin update vargus
```

Then run `/reload-plugins`. Your `statusLine` entry doesn't change between versions. Installed
from a clone: `git -C <clone> pull` (or check out the newer tag), then `/reload-plugins`.

## Uninstall

1. Remove the `statusLine` entry from `~/.claude/settings.json` (or, for a one-project install,
   that project's `.claude/settings.local.json`), or ask Claude to. Do this first:
   uninstalling deletes the plugin's data folder, and a status-line command left behind shows a
   blank row.
2. `claude plugin uninstall vargus@vargus --scope <scope>` from a shell (the scope you installed
   at; `user` is the default), or remove it in `/plugin` under **Installed**. From a clone, also
   `claude plugin marketplace remove vargus`.

## Limits

- Teammates that run in their own tmux pane are not seen.
- Data that only Claude Code's status-line input carries is not shown: lines changed, PR state,
  session name. `cache:` is not in 0.1.0.
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

## Development

- [DESIGN.md](DESIGN.md): how VArgus works, every rule with its reason, and what is still to be
  checked.
- [AGENTS.md](AGENTS.md): working rules for coding agents in this repo.
- Node development only: `npm ci`, `npm test` (tests require Codex CLI and tmux).
  All npm dependencies are development/test tools; users run the source directly.
- Claude checks: `claude plugin validate .`, `tsc -p .`, `claude plugin test .`,
  `sh tests/reader.test.sh`, `sh tests/manifest.test.sh` (DESIGN.md "Tests" has the details).
