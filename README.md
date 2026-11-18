# VArgus

A status line for **Claude Code, OmO Native, Antigravity CLI (`agy`) and Codex CLI**: context,
rate limits with reset countdowns, token and call counts, and repository status.

Claude Code shows it under the prompt through a plugin. Antigravity CLI runs
`vargus statusline` natively under the prompt with no tmux. Codex CLI
uses a tmux row inside ordinary, unmodified Codex. OmO Native uses an extension widget
under the editor, replacing the native footer. All four hosts share the renderer,
fragment switches and colour themes; each collects its own readings.

VArgus replaces [VantageHUD](https://github.com/zhoufanscut/VantageHUD).
[DESIGN.md](DESIGN.md) explains the implementation and its verification limits;
[CHANGELOG.md](CHANGELOG.md) records each release.

## Contents

- [Choose your setup](#choose-your-setup), [Requirements](#requirements)
- [Shared checkout and launcher](#shared-checkout-and-launcher)
- [What it shows](#what-it-shows), [How it works](#how-it-works)
- [OmO Native](#omo-native), [configure OmO Native](#configure-omo-native)
- [Antigravity CLI](#antigravity-cli): [agent setup](#set-up-antigravity-cli-with-an-agent),
  [terminal setup](#set-up-antigravity-cli), [in-session setup](#set-up-in-an-open-agy-session),
  [Windows setup](#windows-setup-for-antigravity-cli),
  [configure](#configure-antigravity-cli), [update](#update-antigravity-cli), [uninstall](#uninstall-antigravity-cli)
- [Codex CLI](#codex-cli): [agent setup](#set-up-codex-with-an-agent), [manual setup](#set-up-codex),
  [automatic startup](#automatic-startup-in-codex),
  [configure](#configure-codex), [update](#update-codex), [uninstall](#uninstall-codex)
- [Claude Code](#claude-code): [setup](#set-up-claude), [configure](#configure-claude),
  [update](#update-claude), [uninstall](#uninstall-claude)
- [Development](#development)

## Choose your setup

| Host | Display | Start here |
|---|---|---|
| Claude Code | Inline row under the prompt | [Install the plugin and status line](#set-up-claude) |
| OmO Native | Native widget under the editor | [Install the native extension](#omo-native) |
| Antigravity CLI (`agy`) | Native inline `statusLine` under the prompt | [Install from a terminal](#set-up-antigravity-cli) or [set it up inside `agy`](#set-up-in-an-open-agy-session) |
| Codex CLI | tmux row | [Ask an agent to set it up](#set-up-codex-with-an-agent), or [set it up by hand](#set-up-codex) |

The Claude plugin installation is only for Claude Code. Antigravity CLI and Codex use this clone's
CLI entry and do not need the Claude plugin. Automatic startup in Codex requires
[hook setup and trust](#automatic-startup-in-codex); manual controls work without it.

## Requirements

| Display | Requirements |
|---|---|
| Claude inline | Claude Code 2.1.299 or later in a terminal; POSIX `sh` on Linux/macOS, or Git for Windows on Windows |
| OmO Native | OmO 5.1.61 native TUI; Node.js 24.12 or later for the setup command; no npm install or build |
| Antigravity CLI inline | Antigravity CLI (`agy`) in a terminal and Node.js 24.12 or later (no tmux, npm install or build) |
| Codex through tmux | Codex CLI, Bash, Node.js 24.12 or later, tmux on Linux or macOS, and saved session logs |
| Codex through native Windows psmux | Codex CLI, PowerShell, Node.js 24.12 or later, psmux, and saved session logs |

The Claude inline plugin needs no Node install. The Antigravity CLI and tmux commands run TypeScript
source directly and need no npm install or build. Git supplies repository readings;
Claude's collector also supports svn working copies. OmO, Antigravity CLI and Codex currently read git only.

Live Antigravity CLI checks cover Linux with `agy` 1.5.8, Node.js 24.14.1 and git 2.47.3;
macOS and native Windows `agy` sessions need their own live verification.
Live tmux checks cover Linux with Node.js 24.14.1, tmux 3.5a and Codex 0.167.0.
Other host versions and macOS need their own live verification.
Claude inline Windows checks and limitations are described [below](#claude-code).
Native Windows Codex checks cover Codex 0.167.0, Node.js 24.21.0 and psmux 3.4.0
with an isolated local mock provider. See [Windows setup](#native-windows-setup).

## Shared checkout and launcher

Reuse one VArgus checkout for Codex, Antigravity CLI, OmO and a Claude directory
marketplace. Use its absolute path in each setup. If you need a checkout, for example:

```sh
mkdir -p "$HOME/.local/share"
git clone https://github.com/zhoufanscut/VArgus "$HOME/.local/share/VArgus"
```

On Windows, clone to a location such as `%USERPROFILE%\.local\share\VArgus`.
The Node integrations run
the source directly without an npm install or build.

### Put vargus on PATH

The host installers and the Codex and Antigravity CLI commands share a single
launcher. On Linux or macOS, use a symlink in a directory on your PATH, for example:

```sh
mkdir -p "$HOME/.local/bin"
ln -s "$HOME/.local/share/VArgus/bin/vargus" "$HOME/.local/bin/vargus"
```

Use your checkout's absolute `bin/vargus` path if it differs. On Windows, put a
forwarding file named `vargus.cmd` in a user PATH directory such as
`%USERPROFILE%\.local\bin`:

```bat
@echo off
"H:\VArgus\bin\vargus.cmd" %*
```

Replace the example path with your checkout's absolute path.
Check any existing launcher before making changes and preserve unrelated commands.
Add the directory to your user PATH if needed, reopen your terminal, and check
`vargus --help`. Use `vargus install --help` or `vargus remove --help` to see the
supported hosts and options.

### Remove shared files

After removing the host integration, check these paths separately.

1. Keep the PATH launcher while Codex controls or hooks, Antigravity's
   `statusLine`, or any other command uses that launcher. Once it is unused,
   verify it is the VArgus launcher you installed with
   `readlink "$HOME/.local/bin/vargus"` on Linux or macOS, or inspect the
   forwarding `vargus.cmd` on Windows. Remove that file and leave the PATH directory.
2. Keep the checkout while it is used by a launcher, a hook or status-line
   command pointing directly into it, an [OmO loader](#omo-native), or a
   [Claude directory marketplace](#or-from-a-clone-updated-with-git-pull).
   After removing the remaining integrations that reference that checkout and
   reloading or closing their sessions as directed, you can delete the checkout.

## What it shows

Examples rendered with illustrative values. Claude Code:

```
~/proj/VArgus | opus:high | 5h:4%(4h37m) 7d:39%(5d6h) | ctx:20% | token:69.5k | session:24m | 🔧73 🤖2 ⚡1 | repo:VArgus | branch:main | ?4
```

Antigravity CLI:

```
~/proj/VArgus | carbon:high | 5h:4%(4h37m) 7d:39%(5d6h) | ctx:20% | token:69.5k | session:24m | 🔧73 🤖2 ⚡1 | repo:VArgus | branch:main | ?4
```

Codex CLI:

```
~/proj/VArgus | sol:xhigh | 5h:4%(4h37m) 7d:39%(5d6h) | ctx:20% | token:69.5k | session:24m | 🔧73 🤖2 ⚡1 | repo:VArgus | branch:main | ?4
```

| Fragment | What it is |
|---|---|
| `~/proj/VArgus` | the working folder |
| `opus:high` / `carbon:high` / `sol:xhigh` | the model and effort level |
| `5h:` `7d:` `1m:` | reported rate-limit windows, used percent and time until reset; `1m` is Kimi Code's membership monthly total; Antigravity CLI selects the active model group's `5h` and `weekly` quota buckets; Codex uses the recorded window duration |
| `ctx:` | how full the context window is |
| `token:` | uncached input plus output tokens; the collection scope differs by host, as described below |
| `session:` | age from the host-reported start time; Antigravity CLI and Codex use the active conversation log's start time |
| `🔧` `🤖` `⚡` | tool, agent and skill counts, with host-specific rules below |
| `repo:` `branch:` | repository and branch; Claude supports git and svn, OmO, Antigravity CLI and Codex support git |
| `?4` | working-tree status: staged `+`, modified `!`, untracked `?`, conflicts `✗`, ahead `⇡`, behind `⇣` |

Effort colours follow the selected theme: `low` uses Alert, `medium` uses Middle,
and `high`, `xhigh`, and `max` share Calm.

With Claude Code on Kimi Code, an exact match for
`https://api.kimi.com/coding/` or `https://api.kimi.ai/coding/` enables Kimi's
`/coding/v1/usages` read and its `5h` and `1m` windows. It uses the existing
`ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` as a Bearer token, only for the
matched HTTPS host; the token is not cached. No Claude OAuth read or extra
setting is involved. Usage reads share the 90-second cache. Direct third-party
providers deliberately bypass `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`; the
flag still blocks the Anthropic OAuth usage read. Kimi's direct usage endpoint
is experimental, so its response shape may change.

Claude's token total includes the main conversation and subagents since the mod
first loaded, or since the last `/clear` or in-session resume. Cache reads and
writes are excluded. Its tool, agent and skill counts come from main-loop tool
starts. Separate teammates in their own panes are outside that collector.

Codex shows the displayed conversation's saved readings. Child totals are not
summed into the parent. Tools count completed visible items, agents count recorded
starts, and skills count observed loads. See [Readings and view changes](#readings-and-view-changes)
for the saved-log boundaries and missing readings.

Antigravity CLI reads live model, context and quota fields from `agy`'s `statusLine`
JSON input and incrementally replays the active conversation's `transcript.jsonl`
for session age, uncached input plus output tokens, and tool, subagent (`invoke_subagent`,
`swarm` `add`), workflow (`run_workflow`) and skill (`SKILL.md` reads) counts. Subagent
conversations have separate transcripts and are not summed into the parent's `token:`.

Each fragment has a switch. See the settings for [Claude](#configure-claude),
[OmO Native](#configure-omo-native), [Antigravity CLI](#configure-antigravity-cli),
and [Codex](#configure-codex). Claude can also show per-model weekly
limits and a gateway spend limit; Antigravity CLI shows the active model group's
`5h:` and `7d:` windows (plus the other quota group's weekly bucket from 80% when
`otherModelWeekly` is on); Codex uses its recorded quota windows. Workflow counts
(`🔀`) are available in Claude and Antigravity CLI when `workflowRuns` is on.

## How it works

Claude Code's plugin keeps a mod loaded in the session. The mod observes usage,
tools, agents and repository changes, renders the line, and writes it to a file.
The inline `statusLine` command prints that file.

Antigravity CLI invokes `vargus statusline` natively on state, resize and quota
updates, passing session JSON on `stdin` and drawing the 24-bit ANSI line beneath
the prompt border. Small cache files under the OS temporary directory keep
`transcript.jsonl` reads incremental by byte offset and enforce VArgus's 5-second
and `10×` slow-walk Git poll hold-off across 300 ms streaming bursts.

Codex uses a background helper that reads saved session logs, identifies the
conversation currently displayed, and sends the rendered line to tmux. It hides
and restores the native footer through session-only `/statusline` commands.
Controls such as `!vargus on` run locally through Codex's shell mode.

On Linux/macOS tmux and Windows psmux, windows without VArgus keep their original status bar height
(one line by default); switching to a window running VArgus adds its row automatically.
The tmux row follows the active pane. All four hosts use shared rendering and themes,
while their collectors remain separate. [DESIGN.md](DESIGN.md#hosts-and-outputs)
contains the architecture, restoration rules and live verification limits.

## OmO Native

From the [shared checkout](#shared-checkout-and-launcher), install the loader:

```sh
./bin/vargus install omo
```

On Windows use `bin\vargus.cmd install omo`. The command asks
`omo config agent-dir --json` for the active agent directory and creates only
`extensions/vargus.ts` there. Use `--dir EXTENSIONS_DIRECTORY` to choose an explicit
extension directory. It refuses to overwrite an unrelated or modified loader.
The loader imports `src/hosts/omo/register.ts` in this checkout; do not move or
delete the checkout while installed.
No Claude plugin, tmux, SDK package, npm install or build is needed.

Run `/reload` in OmO, or start a new native session. VArgus is enabled by default.
The row starts with two spaces, included in its terminal width budget.
It hides the **entire native footer, including lifecycle and extension statuses**,
as requested for this initial integration. Separate task/todo widgets, question
dialogs and the working indicator remain owned by OmO. Other footer-replacing
extensions can compete with VArgus; disabling VArgus restores OmO's built-in footer,
not an earlier custom footer.

### Configure OmO Native

To use a standalone JSON options file, pass its path at installation. You can
reuse the file you pass to Codex or Antigravity CLI.

```sh
./bin/vargus install omo --config "$HOME/.config/vargus.json"
```

Use a JSON object with the [shared option keys](src/options.ts), for example
`{"theme":"ember","session":false}`. The loader saves the absolute path and
VArgus reads the file when OmO loads the extension. Run `/reload` after editing
the file. To change the path, rerun `vargus install omo --config FILE` with the new
path. Reinstalling without `--config` keeps the saved path. To stop using the
file, run `vargus remove omo` and then `vargus install omo`.

```text
/vargus off
/vargus on
/vargus status
/vargus config {"theme":"graphite","folder":true,"rateLimits":true}
```

VArgus saves your on/off choice and `/vargus config` overrides with the current
session. Saved options take precedence over file values, and the file takes
precedence over built-in defaults. Sessions configured with an older VArgus may
have saved a full set of options. An explicit `off` survives reload and resume.
New sessions default on.

Tokens count persisted main-session assistant input plus output across the whole
session history, including earlier branches and compaction history. Cache reads,
cache writes and child/tool-result usage are excluded. Native assistant edits made
while this extension is loaded are recorded as non-billable copies, so editing a
response does not increase its token total. OmO does not persist edit provenance
itself: copies made before installation or through another client without VArgus
cannot be distinguished reliably and remain in the recorded total.
Tools count persisted outer
assistant tool calls; calls hidden inside `eval` are not added. Agents count distinct
task IDs from accepted spawn results. Workflow counts, when `workflowRuns` is enabled,
count distinct persisted DAG notices; a running workflow without a notice is not
yet counted. Skill counts are unavailable and omitted: reading `SKILL.md` does not
prove a skill was loaded.

OmO uses short model families such as `opus`, `fable`, `sol`, `terra`, `luna`
and `argon`, without versions. Other models use their family stem, such as
`glm`, `kimi`, `grok` or `qwen`. Fast and ultrafast variants appear after effort:
`sol:high(fast)` or `sol:high(ultrafast)`. Kimi's highspeed variants use `(fast)`.

Context stays absent until OmO supplies a reading. Quotas follow the selected
provider: Claude and ChatGPT subscription windows come from OmO's subscription-limit
service. Kimi Coding uses its regional usage endpoint for five-hour and monthly
windows, enabled by default. OmO resolves its existing Kimi credential and region;
VArgus does not read credential files. Usage refreshes every 90 seconds while Kimi
is selected, with a 30-second request timeout and longer waits after errors.
Switching to another provider clears Kimi readings and cancels pending requests.
Other API providers do not inherit unrelated subscription windows.
Only window labels, percentages and reset
countdowns are shown; provider/account names are hidden. Multiple accounts' windows
remain separate, without implying which account is active. Unknown durations keep their host labels.
Errored reports retain a stale `*` for at most 15 minutes; older readings and expired
windows disappear. An existing `kimi-coding-status.js` extension remains independent
and may also poll Kimi; VArgus does not consume its hidden footer status.

After updating this checkout, run `/reload` in OmO. If the checkout moved or your
loader still points to the former top-level extension entry, rerun
`./bin/vargus install omo` first to refresh its target. To remove:

```sh
./bin/vargus remove omo
```

Then `/reload` or quit each affected OmO session before
[removing shared files](#remove-shared-files).
Removal touches only the owned loader. The separate experimental
`vargus-preview.ts`, if installed, is left untouched.

Support targets the native TUI. RPC, JSON and print modes are not modified.
See [DESIGN.md](DESIGN.md#omo-native) for counting contracts and verification limits.

## Antigravity CLI

### Set up Antigravity CLI with an agent

From a VArgus checkout, ask your agent in `agy`:

> Read this repository's README.md and set up VArgus for Antigravity CLI.

Search phrases for this workflow: `set up VArgus for Antigravity`, `VArgus agy setup`,
`VArgus Antigravity statusLine`.

When the user requests this setup, the agent should:

1. Check the [requirements](#requirements) (`agy` and Node.js 24.12 or later). Reuse
   the current VArgus checkout or an existing installation. If you need a clone,
   follow [Shared checkout and launcher](#shared-checkout-and-launcher).
   Inside `agy`'s sandbox, clone outside the sandbox with user approval.
2. Set up or verify the [shared PATH launcher](#put-vargus-on-path).
   Inside `agy`'s default terminal sandbox:
   - On Linux, `~/.local/bin` mounts only `agy` read-only. Inspecting the launcher
     with `readlink -f` or creating the directory and link requires user approval
     to run outside the sandbox.
   - On macOS, `ls -ld` and `readlink -f` on `~/.local/bin/vargus` work inside
     the sandbox. Listing `~/.local/bin` returns `Operation not permitted`.
     Creating the directory or the launcher requires user approval to run
     outside the sandbox.
3. Verify that piping `{}` to `"$HOME/.local/bin/vargus" statusline` exits 0.
   Run the check outside the sandbox if it blocks the launcher or checkout.
   Inside the sandbox you can also check the active workspace's `bin/vargus`.
   On Windows, use `vargus statusline`.
4. Configure `statusLine`:
   - **When running inside `agy`**: `agy` protects `~/.gemini/antigravity-cli/settings.json`
     behind a hardcoded system protection boundary, so an `agy` agent cannot read or edit
     `settings.json` directly. Report the verified checkout and PATH entry, and hand back the
     slash command for the user to run in `agy`:
     - Linux / macOS: `/statusline "$HOME/.local/bin/vargus" statusline`
     - Windows: `/statusline vargus statusline`
     Running `/statusline <command>` in `agy` saves `statusLine` to `settings.json` and
     activates VArgus immediately in the open TUI with no restart.
   - **When running from another coding agent outside `agy`**: run
     `vargus install antigravity`. If the installer finds a different command, report it
     so the user can choose a status line with `/statusline` in `agy`.

### Set up Antigravity CLI

Use the [shared checkout and PATH launcher](#shared-checkout-and-launcher).
Run this from a terminal on Linux, macOS or Windows:

```sh
vargus install antigravity
```

The installer adds `vargus statusline` to `~/.gemini/antigravity-cli/settings.json`
and preserves your other settings. It keeps an existing VArgus command and its options,
and stops if a different status line command is configured. Open or reopen `agy` to
load the settings. The launcher's directory must be on `agy`'s PATH.

### Set up in an open `agy` session

After setting up the launcher, run this inside `agy` on Linux or macOS to save the
setting and show the row immediately:

```text
/statusline "$HOME/.local/bin/vargus" statusline
```

Or merge the equivalent `statusLine` entry into `~/.gemini/antigravity-cli/settings.json` by
hand, preserving your other settings:

```json
{
  "statusLine": {
    "type": "command",
    "command": "\"$HOME/.local/bin/vargus\" statusline",
    "enabled": true,
    "padding": 0,
    "stack_with_default": false
  }
}
```

Inside `agy`, `/statusline` (no arguments) or `/statusline off` and `/statusline on` toggle
the custom row without removing the command, and `/statusline delete` (or `/statusline reset`)
reverts to the built-in row. Nonempty rows include a two-space left indent to align with the
prompt text; keep `"padding": 0` unless you want blank vertical lines above the row, and set
`"stack_with_default": true` in `settings.json` if you want VArgus placed below Antigravity's
built-in status line instead of replacing it.

### Windows setup for Antigravity CLI

Set up the [Windows PATH launcher](#put-vargus-on-path), then run
`vargus install antigravity` from a terminal. To save and apply the setting in an
open `agy` session, run:

```text
/statusline vargus statusline
```

Or merge this entry into `%USERPROFILE%\.gemini\antigravity-cli\settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "vargus statusline",
    "enabled": true,
    "padding": 0,
    "stack_with_default": false
  }
}
```

Invoking `vargus` from PATH avoids shell-specific `%USERPROFILE%` expansion and
`cmd.exe /c` outer-quote stripping when `--config "C:\\path\\to\\vargus.json"` is appended.
Windows `bin\vargus.cmd` execution is covered by CLI tests; live Windows `agy` rendering
has not yet been verified on a Windows machine.

### Configure Antigravity CLI

Defaults work with no extra flags or files. Pass `--theme NAME` or
`--config /absolute/path/to/vargus.json` in `statusLine.command`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "\"$HOME/.local/bin/vargus\" statusline --theme ember --config \"$HOME/.config/vargus.json\"",
    "enabled": true
  }
}
```

The JSON file uses the same keys and defaults as [`src/options.ts`](src/options.ts):

- **Model names**: Gemini and Claude display labels shorten to their family with effort
  (`Gemini 4 Carbon (High)` → `carbon:high`, `Gemini 4 Hydrogen (XHigh)` → `hydrogen:xhigh`,
  `Gemini 3.8 Flash (Low)` → `flash:low`, `Claude Opus 5.5 (High)` → `opus:high`);
  Orchestrator models keep their variant (`orchestrator(carbon)`, `orchestrator(argon)`);
  other provider names stay whole (`GPT-OSS 120B (Medium)` → `gpt-oss-120b:medium`).
- **Quota groups**: Gemini and Orchestrator models show the `"Gemini Models"` `5h:` and `7d:`
  buckets; Claude and GPT models show the `"Claude and GPT models"` `5h:` and `7d:` buckets.
  Setting `"otherModelWeekly": true` also shows the non-active group's weekly bucket (`3p:`
  or `gm:`) once it reaches 80% used.
- **Call counts**: `🔧` counts `tool_calls`, `🤖` counts `invoke_subagent` and `swarm` `add`
  spawns, `⚡` counts Antigravity `SKILL.md` reads once per skill path per user turn, and
  `"workflowRuns": true` adds `🔀` for `run_workflow` calls.
- **Git & colours**: `"detachedHead": true` names detached tags/commits and rebase/merge
  operations; setting `repo`, `branch` and `status` all to `false` disables Git checks;
  setting `NO_COLOR` in the shell environment disables ANSI colours.

### Update Antigravity CLI

Update your clone with `git -C "$HOME/.local/share/VArgus" pull` (or fetch tags and check
out a release tag). Because `agy` runs `vargus statusline` on each refresh, updated code
takes effect immediately on the next status-line update with no restart.

### Uninstall Antigravity CLI

1. Run `/statusline delete` inside `agy`, or remove the `"statusLine"` object from
   `~/.gemini/antigravity-cli/settings.json` (preserving your other settings).
2. Follow [Remove shared files](#remove-shared-files).

## Codex CLI

### Set up Codex with an agent

From a VArgus checkout, ask your coding agent:

> Read this repository's README.md and set up VArgus for Codex, including the
> `vargus` PATH symlink and automatic startup hooks.

Search phrases for this workflow: `set up VArgus for Codex`, `VArgus Codex setup`,
`VArgus symlink`, `VArgus Codex hooks`.

When the user requests this setup, the agent should:

1. Check the [requirements](#requirements) and reuse an existing
   [checkout and PATH launcher](#shared-checkout-and-launcher) when possible.
   Verify `vargus --help` through the launcher.
2. Run `vargus install codex` for the user's Codex home, or pass
   `--home /absolute/path` for another home. Report the checkout, launcher
   and hook file used.
3. Have the user select **Thread ID** in the `/statusline` picker, review and trust
   the callbacks through Codex, then send a normal prompt. See
   [Automatic startup in Codex](#automatic-startup-in-codex).
   Confirm activation with `!vargus status` in the intended TUI.

### Set up Codex

Use the [shared checkout and PATH launcher](#shared-checkout-and-launcher).

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
`bin\vargus.cmd` through the [shared Windows PATH launcher](#put-vargus-on-path).
A forwarding file keeps the repository-relative entry intact and needs no
symlink privileges.

Run `vargus install codex` and follow [Automatic startup in Codex](#automatic-startup-in-codex)
inside psmux. The setup command writes PowerShell callbacks on Windows.

Windows background child processes use hidden windows. Windows process lookup
uses CIM rather than Unix `ps`. With psmux's built-in bar, VArgus appears above
the original session/window/right-side information. The bar stays at its saved
top/bottom position, and disabling VArgus restores the original scalar settings.
Windows without VArgus keep their original height (one line by default).
Selecting or creating a window adjusts the height automatically through a local
background callback. All panes in the selected window count toward ownership;
an unwrapped pane beside an owner keeps that window's row with a blank header.
Routine updates publish differences together and use psmux's automatic
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
bar uses two rows in VArgus windows and stays hidden in other windows.
User hooks and later status-height changes are preserved. This behavior is
enabled by default. After upgrading an already shared attachment, stop every
VArgus helper in that session and turn it on again, or restart the session.
Windows verification covers automatic
startup, token display, `on/status/reload/off`, preserving a custom first row and
sharing the added row between two owners. Attached-client checks cover keyboard
window switching and creating a new window; native regressions cover custom
heights, hidden bars, user hooks and restoration. Windows subagent navigation and draft
scenarios and shared-daemon mode need their own live verification. The native
TUI rig uses `--no-daemon`; an independent real-TUI probe also verified `!` shell
controls and that a normal prompt after manual off leaves the row off.

### Readings and view changes

The helper follows the displayed parent or subagent through Alt+Left/Right and
`/subagents`. Each view shows its own recorded readings; child totals are not
aggregated. VArgus matches Codex's contextual agent label to saved session metadata.
If a popup, clipped label or ambiguous agent path prevents identification, the row
blanks until the view can be identified again, except for the last-confirmed draft
snapshot described below. At an empty composer, blank content also releases this
pane's extra tmux row. The last pane to release it restores the original bar height,
so `/new` can show the native Codex footer without an empty extra row. Content
returning brings VArgus back. On Linux/macOS, another pane using VArgus keeps the
extra row in its window; windows without VArgus keep the original height. `status` reports the current view or pause.
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

To remove an abandoned row without restoring Codex's footer, run
`vargus tmux-reset` inside the affected tmux session. It refuses while a VArgus
helper still owns a row; use `!vargus off` to restore the footer too.

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
layouts still blank the row. Releasing the extra row at an empty composer also
discards its snapshot, so typing in a new conversation cannot revive old readings.
Reloading discards the snapshot until a view is recognized again.
See [Narrow terminals and SSH](#narrow-terminals-and-ssh) for
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

With the [PATH launcher](#put-vargus-on-path) in place, run:

```sh
vargus install codex
```

The command prepares `vargus/autostart` and adds the VArgus **SessionStart** and
**UserPromptSubmit** callbacks to `hooks.json`, preserving existing callbacks,
including direct VArgus callbacks and their options. It uses `CODEX_HOME` or `~/.codex`
(`%USERPROFILE%\.codex` on Windows). Pass `--home /absolute/path` to prepare
another home, then launch Codex with that home.

1. Open or reopen Codex in tmux (psmux on Windows) and review and trust the
   VArgus callbacks through the startup dialog or `/hooks`.
2. Run `/statusline` with no arguments and select **Thread ID** in the picker.
   Confirm the selection and keep the whole ID visible. In a narrow terminal,
   [put Thread ID first](#narrow-terminals-and-ssh).
3. Send a normal prompt to start the row, then run `!vargus status`.

`codexAutoStart` defaults to true. To use a custom tmux socket, restrict activation
to a pane, or supply a VArgus options file, add `--socket PATH`, `--pane %ID`
or `--config FILE` to both VArgus commands in `hooks.json`. After moving the checkout, repoint the
[PATH launcher](#put-vargus-on-path). If a callback names the old checkout
directly, update its executable path in `hooks.json` and keep its arguments.
Reopen Codex and review any changed callbacks.

Automatic startup looks for one visible matching thread with a saved log.
The saved footer selection should match the one on screen. If the ID is clipped,
the composer has a draft, or more than one pane matches, use `!vargus on` when
ready. A resumed thread already loaded in a shared daemon may activate on a
prompt through the UserPromptSubmit fallback.

`!vargus off` restores the saved footer and suppresses startup callbacks for
the displayed thread in that TUI process. `!vargus on` clears suppression.
The state directory lets off take effect before the first prompt as well.
Disable automatic startup through `/hooks`, by setting `codexAutoStart` to false
in the options file used by both callbacks, or by [removing the callbacks](#uninstall-codex).

### Configure Codex

Defaults work without an options file. For a different theme or fragment switches,
pass `--theme NAME` or `--config /absolute/path/to/vargus.json` on first activation.
To change a running helper's options, use `reload` with those flags:

```text
!vargus on --theme ember
!vargus reload --theme graphite
```

An optional JSON config uses the [shared defaults](src/options.ts) and
[Codex defaults](src/hosts/codex/options.ts). For example:

```json
{
  "theme": "ember",
  "session": false
}
```

Pass it with `!vargus on --config /absolute/path/to/vargus.json`, or with
`!vargus reload --config /absolute/path/to/vargus.json` for an existing helper.
`NO_COLOR` disables colours in the environment that starts the helper.
Setting `repo`, `branch` and `status` all to `false` stops the row's Git polling.
Set `detachedHead` to `true` to show detached tags or commits and Git operations.

Codex always displays known model families as `astra`, `sol`, `terra` or `luna`, for example
`sol:xhigh`. Both `gpt-6-sol` and `gpt-6.1-sol` display `sol`; unfamiliar IDs remain
whole. The former `codexShortModel` option is ignored in existing options files.
Subagent counts and skill counts default to on for Codex; set `codexAgentCounts`
or `codexSkillCounts` to `false` in a JSON options file passed with `--config` to
disable either. `model` and `callCounts` control their whole fragments.

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

1. If you installed automatic startup, run `vargus remove codex` with the
   same Codex home. If VArgus uses a custom shell wrapper or appears before
   another callback in its group, remove the VArgus callbacks from `hooks.json`
   by hand. Keep the other callbacks and review the affected groups in
   `/hooks` after reopening Codex.
2. In each Codex TUI using VArgus, run `!vargus off`, then `!vargus status` while
   the clone and PATH entry still exist. If restoration is pending, visit the
   affected conversations with an empty composer and follow the
   [restoration notes](#footer-restoration-and-typing). Finish those restores, or
   exit Codex before removing the helper's source.
3. If you removed startup hooks, close the affected Codex TUIs before removing the
   PATH entry or clone. In checked Codex 0.167.0, reopening the TUI loads the updated
   hook definitions; reopening only `/hooks` inside a running TUI keeps the removed
   entries in its cached inventory.
4. Follow [Remove shared files](#remove-shared-files).

The saved footer selection from hook setup is yours to keep or edit. `off` restores
that saved layout; it does not remove your `thread-id` preference.

## Claude Code

The plugin uses Claude's native status-line row. Start `claude` normally after setup.

### Inline requirements

- Claude Code 2.1.299 or later, in a terminal. The status line is not shown in the VS Code chat
  panel or under `claude -p`.
- Linux or macOS: the status-line command is POSIX `sh`.
- Windows requires Git for Windows. Claude Code runs the reader in Git Bash. Before setup, run
  `command -v cat find` in Git Bash and check that it finds both commands. Running `bash` from
  PowerShell can open WSL instead. If Git Bash is missing, install Git for Windows and restart
  Claude Code. Tested on one Windows 11 machine (Git 2.56.0, Claude Code 2.1.300).
  [Git for Windows](https://git-scm.com/downloads/win)

### Set up Claude

With `vargus` on your PATH:

```sh
vargus install claude
```

From the [shared checkout](#shared-checkout-and-launcher), use
`./bin/vargus install claude`. On Windows use `bin\vargus.cmd install claude` with
`claude.exe` on your PATH. The installer uses Node.js 24.12 or later, like the
other `vargus` commands.

The command installs the plugin at user scope and configures the inline reader in
`~/.claude/settings.json` or in `CLAUDE_CONFIG_DIR/settings.json` if you use an absolute
custom config directory. It registers the checkout as a directory marketplace for
a fresh install and reuses an existing `vargus` marketplace. If your user settings
contain a different status line, the installer stops before installing the plugin.
Back up that entry and remove it before retrying if you want to switch. A project
or project-local status line takes precedence within that project.

Run `/reload-plugins` in an open session or start a new Claude Code session.

From a VArgus checkout, you can ask your coding agent to set it up.

> Read the Claude Code section of this repository's README.md and set up VArgus for Claude Code.

#### Manual setup without Node.js

Use this path for a marketplace install without Node.js or for an install scoped to one project.
If the plugin is already installed, continue to [Set up the status line](#set-up-the-status-line).

##### Install the plugin

For a fresh marketplace install, run this in Claude Code.

```
/plugin install vargus --marketplace zhoufanscut/VArgus
```

Answer `y` to add the marketplace. Pick **user** to show the line in every project, or
**project** or **local** for a single project. From a shell you can run
`claude plugin install vargus --marketplace zhoufanscut/VArgus`, which defaults to user scope.

##### Or from a clone, updated with `git pull`

Use the [shared checkout](#shared-checkout-and-launcher) and substitute its path below.

```sh
claude plugin marketplace add "$HOME/.local/share/VArgus"
claude plugin install vargus@vargus
```

For a single project, run the install command from that project with `--scope project` or
`--scope local`.

Claude Code reads a plugin from a folder marketplace straight from that folder (`claude plugin
list` shows `Read from: <folder>`), so `git -C "$HOME/.local/share/VArgus" pull` updates it:
a new session runs the pulled code, also across a version change, and `/reload-plugins` brings it
into an open one. You then follow `main`, every commit as soon as you pull. To stay on a release
instead, fetch tags with `git -C "$HOME/.local/share/VArgus" fetch --tags` and check out the
release tag you want (`pull` doesn't update a checked-out tag). Add only one of
the two marketplaces: both are named `vargus`.

##### Set up the status line

The plugin writes the status line to a file. Configure Claude's `statusLine` command to read it.

1. From the target project, run `claude plugin list --json` and check the scope of the enabled
   `vargus@vargus` entry. The reader uses the data folder for VArgus's own marketplace. If the
   plugin came from another marketplace, use one of the install methods above.
2. Find your Claude config directory. Use the absolute `CLAUDE_CONFIG_DIR` if set. The defaults are
   `~/.claude` on Linux and macOS and `%USERPROFILE%\.claude` on Windows. For a user-scope install,
   edit `settings.json` in that directory. For a project- or local-scope install, use the entry's
   `projectPath` and edit `<projectPath>/.claude/settings.local.json`.
3. Update an existing VArgus reader in place. Its `statusLine` command points to
   `vargus-vargus/$CLAUDE_CODE_SESSION_ID/line`. If you are switching to VArgus from another
   status line, save the original entry beside the settings file as
   `statusLine.before-vargus.json`. Pick an unused filename if a backup exists. An agent
   following these steps should ask before replacing another status line.

Add the `statusLine` entry to the settings object. If the file is new, wrap the entry in `{}`.
For a custom config directory or Windows, replace `$HOME/.claude` in `command` with the absolute
config directory from step 2. Use forward slashes on Windows, for example `C:/Users/you/.claude`.
In a literal path, escape backslashes, double quotes, dollar signs and backticks with a
backslash for the shell, then JSON-escape the command. For example, a literal dollar sign in
the path appears as `\\$` in JSON. Leave `$CLAUDE_CODE_SESSION_ID` and `$f` as written.

```json
"statusLine": {
  "type": "command",
  "command": "cat \"$HOME/.claude/plugins/data/vargus-vargus/$CLAUDE_CODE_SESSION_ID/line\" 2>/dev/null",
  "refreshInterval": 1
}
```

Use this entry when **Blank a stopped line** is enabled. The option is stored in
`pluginConfigs["vargus@vargus"].options.blankStopped` in the user settings.

```json
"statusLine": {
  "type": "command",
  "command": "f=\"$HOME/.claude/plugins/data/vargus-vargus/$CLAUDE_CODE_SESSION_ID/line\"; [ -n \"$(find \"$f\" -mmin -2 2>/dev/null)\" ] && cat \"$f\"",
  "refreshInterval": 1
}
```

Run `/reload-plugins` or start a new session. If you moved from a user-wide install to a
project-only install, remove any leftover VArgus `statusLine` from your user settings or restore
the entry you backed up before switching to VArgus.

### Verify Claude works

Start a session and send one prompt. The line shows under the prompt within about two seconds
of the reply. If the row stays empty:

- Check that the plugin is enabled in `/plugin`.
- Accept the workspace trust dialog if this folder is awaiting trust.
- Check the project's `.claude/settings.json` and `.claude/settings.local.json`. A `statusLine`
  in either file can override the user setting.

### Configure Claude

Options are shown in `/config` under the plugin. Existing option defaults are
documented below. The Codex model/counter defaults are described [above](#configure-codex);
their switches have no effect on the Claude line.

Rate-limit API reads stop when `rateLimits` is off. Git/svn polling stops when
`repo`, `branch` and `status` are all off.

The spend limit (`spendLimit`), other models' weekly limits (`otherModelWeekly`),
workflow runs (`workflowRuns`) and detached-HEAD naming (`detachedHead`) default
to off. Sonnet's weekly `sn:` appears from 80% used; Opus's `op:` appears when
reported. Other models' weekly limits use the same threshold when enabled.

- **Theme**: one of five bundled palettes, `graphite` by default (near-monochrome; only the usage
  colours carry hue). All but `daylight` assume a dark terminal.
- **Blank a stopped line** (off by default): if the plugin stops mid-session (its module fails
  to load at `/reload-plugins`; turning it off is expected to do the same, not tested), the row
  goes blank within about two minutes instead of showing frozen numbers. After turning it on or
  off in `/config`, rerun `vargus install claude` for a user-scope install or use the matching
  entry in [Set up the status line](#set-up-the-status-line). The plugin rewrites the line every
  30 s while it is on. If that reader stays configured after you turn the option off, the row
  goes blank whenever the line has not changed for two minutes.
- **Colours off**: set `NO_COLOR` (to any non-empty value) in the environment you start Claude Code from.
  Other programs Claude Code starts see it too.

### Update Claude

```
/plugin update vargus
```

Then run `/reload-plugins`. Your `statusLine` entry doesn't change between versions. Installed
from a clone: `git -C <clone> pull` (or check out the newer tag), then `/reload-plugins`.

### Uninstall Claude

1. Run `claude plugin list --json` from the project to check the installed scopes. Before
   uninstalling, check `settings.json` in your Claude config directory and the affected project's
   `.claude/settings.local.json` and `.claude/settings.json`. Remove the VArgus `statusLine` entry
   that applies to the install you're removing. A VArgus reader points to
   `vargus-vargus/$CLAUDE_CODE_SESSION_ID/line`. Confirm before editing shared project settings.
   If you saved a status line before switching to VArgus, restore that entry. Uninstalling deletes
   the plugin's data folder, so a VArgus reader left in settings shows a blank row.
2. Run `claude plugin uninstall vargus@vargus --scope <scope>` from a shell, or remove it in
   `/plugin` under **Installed**. If removing the directory marketplace too, run
   `claude plugin marketplace remove vargus`.
   Reload plugins or close affected sessions.
3. For a directory install, follow [Remove shared files](#remove-shared-files).

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

## Development

- [DESIGN.md](DESIGN.md): how VArgus works, every rule with its reason, and what is still to be
  checked.
- [AGENTS.md](AGENTS.md): working rules for coding agents in this repo.
- Run `npm ci` for development tools. `npm run test:fixtures` type-checks the
  Node source and runs local fixtures with Node and Git. `npm test` adds native
  Codex and tmux checks, or Codex and psmux checks on Windows.
- Claude checks: `npm run test:claude` runs plugin validation, type-checking, engine
  tests, and the reader/manifest checks. DESIGN.md "Tests" has the details.

### Add a host

Use [Antigravity's stdin command](src/cli/antigravity.ts) as a starting point for
a command-based host, or [OmO's native registration](src/hosts/omo/register.ts)
for an in-process extension.

- Add one adapter under `src/hosts/<host>` for readings and host lifecycle.
- Wire it to the shared renderer and output at a CLI or native entry point.
  Register any native entry's output import explicitly in the boundary test.
- Add a fixture that exercises the entry with a representative payload or
  session. Run `npm run test:fixtures`.
- Document setup and removal, including any shared checkout or launcher it uses.
  Keep user installs source-only.
