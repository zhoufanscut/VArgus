# VArgus

A status line for [Claude Code](https://code.claude.com/docs/en/overview) that keeps up with the
session: context, rate limits with live countdowns, token counts from each API request (subagents
included) and git, in the status-line row under the prompt.

> **Status: in development.** Nothing is released yet; the design is [DESIGN.md](DESIGN.md).
> Until 0.1.0, use [VantageHUD](https://github.com/zhoufanscut/VantageHUD), which VArgus
> replaces.

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

Answer `y` to add the marketplace, then pick a scope. From a shell instead:
`claude plugin install vargus --marketplace zhoufanscut/VArgus`.

### 2. Load it

Run `/reload-plugins`, or start a new session, so the mod and its setup skill are loaded.

### 3. Set up the status line

A plugin can't change your status line, so this step edits your settings once. Ask Claude:

> set up the VArgus status line

The plugin's `vargus-setup` skill tells Claude what to do: it shows your current `statusLine`
entry if you have one, asks before replacing it, and adds the VArgus one.

#### By hand

Add this to `~/.claude/settings.json`, replacing any `statusLine` entry you have. It assumes the
default config folder (`~/.claude`); with `CLAUDE_CONFIG_DIR` set, let the skill do it.

```json
"statusLine": {
  "type": "command",
  "command": "cat \"$HOME/.claude/plugins/data/vargus-vargus/$CLAUDE_CODE_SESSION_ID/line\" 2>/dev/null",
  "refreshInterval": 1
}
```

## Verify it works

Start a session and send one prompt. The line shows under the prompt within a second of the
reply. If the row stays empty:

- the mod hasn't written the line yet: check that the plugin is enabled in `/plugin`;
- the folder isn't trusted yet: the status line stays blank until you accept the workspace trust
  dialog (statusline docs).

## Configure

Options are shown in `/config` under the plugin. Every option that adds something is off by
default, so an update never changes your line without you asking.

- **Theme**: one of five bundled palettes, `graphite` by default (near-monochrome; only the usage
  colours carry hue). All but `daylight` assume a dark terminal.
- **Colours off**: set `NO_COLOR` (to any value) in the environment you start Claude Code from.
  Other programs Claude Code starts see it too.

## Update

```
/plugin update vargus
```

Then run `/reload-plugins`. Your `statusLine` entry doesn't change between versions.

## Uninstall

1. Remove the `statusLine` entry from `~/.claude/settings.json`, or ask Claude to. Do this first:
   uninstalling deletes the plugin's data folder, and a status-line command left behind shows a
   blank row.
2. `claude plugin uninstall vargus` from a shell, or remove it in `/plugin` under **Installed**.

## Limits

- Teammates that run in their own tmux pane are not seen.
- Data that only Claude Code's status-line input carries is not shown: lines changed, PR state,
  session name. `cache:` is not in 0.1.0.
- One small folder per session is left in the plugin's data folder after the session ends.
- Labels are English only for now.
- A line can lag the session by up to about a second. If the plugin stops (turned off, or a
  crash), the last line stays on screen with frozen numbers.

## Development

- [DESIGN.md](DESIGN.md): how VArgus works, every rule with its reason, and what is still to be
  checked.
- [AGENTS.md](AGENTS.md): working rules for coding agents in this repo.
