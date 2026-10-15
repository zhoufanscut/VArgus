# VArgus

A status line for [Claude Code](https://code.claude.com/docs/en/overview) that keeps up with the
session: context, rate limits with live countdowns, token counts from each API request (subagents
included) and git, in the status-line row under the prompt.

VArgus replaces [VantageHUD](https://github.com/zhoufanscut/VantageHUD). How it works, rule by
rule, is in [DESIGN.md](DESIGN.md); what changed in each version, in [CHANGELOG.md](CHANGELOG.md).

## Contents

- [What it shows](#what-it-shows), [How it works](#how-it-works),
  [Compared with VantageHUD](#compared-with-vantagehud)
- [Requirements](#requirements), [Setup](#setup), [Verify it works](#verify-it-works)
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

## Requirements

- Claude Code 2.1.299 or later, in a terminal. The status line is not shown in the VS Code chat
  panel or under `claude -p`.
- Linux or macOS: the status-line command is POSIX `sh`.

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
default config folder (`~/.claude`); with `CLAUDE_CONFIG_DIR` set, let the skill do it.

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

Options are shown in `/config` under the plugin. Every option that adds something is off by
default, so an update never changes your line without you asking.

- **Theme**: one of five bundled palettes, `graphite` by default (near-monochrome; only the usage
  colours carry hue). All but `daylight` assume a dark terminal.
- **Blank a stopped line** (off by default): if the plugin stops mid-session (its module fails
  to load at `/reload-plugins`; turning it off is expected to do the same, not tested), the row
  goes blank within about two minutes instead of showing frozen numbers. After turning it on or
  off in `/config`, ask Claude to set up the VArgus status line again: the status-line command
  changes to one that checks the file's age (about 3.4 ms a run instead of 1.9 ms), or back. The
  plugin rewrites the line every 30 s while it is on. Left with that command after turning the
  option off, the row goes blank whenever the line has not changed for two minutes.
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
- A line can lag the session by up to about two seconds. If the plugin stops (turned off, or a
  crash), the last line stays on screen with frozen numbers, unless **Blank a stopped line** is
  on.

## Development

- [DESIGN.md](DESIGN.md): how VArgus works, every rule with its reason, and what is still to be
  checked.
- [AGENTS.md](AGENTS.md): working rules for coding agents in this repo.
- Checks: `claude plugin validate .`, `tsc -p .`, `claude plugin test .`,
  `sh tests/reader.test.sh`, `sh tests/manifest.test.sh` (DESIGN.md "Tests" has the details).
