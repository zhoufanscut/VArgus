# VArgus for Claude Code

The plugin uses Claude's native status-line row. Start `claude` normally after setup.

## Install

### Requirements

- Claude Code 2.1.299 or later, in a terminal. The status line is not shown in the VS Code chat
  panel or under `claude -p`.
- Linux or macOS: the status-line command is POSIX `sh`.
- Windows requires Git for Windows. Claude Code runs the reader in Git Bash. Before setup, run
  `command -v cat find` in Git Bash and check that it finds both commands. Running `bash` from
  PowerShell can open WSL instead. If Git Bash is missing, install Git for Windows and restart
  Claude Code. Tested on one Windows 11 machine (Git 2.56.0, Claude Code 2.1.300).
  [Git for Windows](https://git-scm.com/downloads/win)

### User-scope installer

Set up the [shared checkout and launcher](../README.md#shared-checkout-and-launcher)
for the version you intend to use, then run the installer from a terminal.

```sh
vargus install claude
```

From the [shared checkout](../README.md#shared-checkout-and-launcher), use
`./bin/vargus install claude`. On Windows use `bin\vargus.cmd install claude` with
`claude.exe` on your PATH. The installer uses Node.js 24.12 or later, like the
other `vargus` commands.

The command installs the plugin at user scope and configures the inline reader in
`~/.claude/settings.json` or in `CLAUDE_CONFIG_DIR/settings.json` if you use an absolute
custom config directory. It registers the checkout as a directory marketplace for
a fresh install and reuses an existing `vargus` marketplace. If your user settings
contain a different status line, the installer stops before installing the plugin.
To replace that reader, follow the [backup step](#set-up-the-status-line) before
removing the old entry and retrying. A project or project-local status line
takes precedence within that project.

Run `/reload-plugins` in an open session or start a new Claude Code session.

### Manual setup without Node.js

Use this path for a marketplace install without Node.js or for an install scoped to one project.
If the plugin is already installed, continue to [Set up the status line](#set-up-the-status-line).

#### Install the plugin

For a fresh marketplace install, run this in Claude Code.

```
/plugin install vargus --marketplace zhoufanscut/VArgus
```

Answer `y` to add the marketplace. Pick **user** to show the line in every project, or
**project** or **local** for a single project. From a shell you can run
`claude plugin install vargus --marketplace zhoufanscut/VArgus`, which defaults to user scope.

#### Or from a clone, updated with `git pull`

Use the [shared checkout](../README.md#shared-checkout-and-launcher) and substitute its path below.

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

#### Set up the status line

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
the path appears as `\\$` in JSON. Leave `$CLAUDE_CODE_SESSION_ID` as written.

```json
"statusLine": {
  "type": "command",
  "command": "f=\"$HOME/.claude/plugins/data/vargus-vargus/$CLAUDE_CODE_SESSION_ID/line\"; if [ -s \"$f\" ] && { IFS= read -r d && [ \"$(date +%s)\" -ge \"$d\" ] && IFS= read -r row; } 2>/dev/null < \"$f.live\"; then printf %s \"$row\"; else cat \"$f\" 2>/dev/null; fi",
  "refreshInterval": 1
}
```

Run `/reload-plugins` or start a new session. If you moved from a user-wide install to a
project-only install, remove any leftover VArgus `statusLine` from your user settings or restore
the entry you backed up before switching to VArgus.

## Verify

From the target project, run `claude plugin list --json` and check the enabled
`vargus@vargus` entry and scope. In the terminal TUI, look for the VArgus row under
the prompt. To verify that readings update, check the line after a prompt and reply.
It can take about two seconds for the row to catch up.

If the row stays empty, check the effective reader and plugin in that session.

- Check that the plugin is enabled in `/plugin`.
- Accept the workspace trust dialog if this folder is awaiting trust.
- Check the project's `.claude/settings.json` and `.claude/settings.local.json`. A `statusLine`
  in either file can override the user setting.

## Configure

Open the VArgus options in `/config`. With a shared checkout, a change here
updates that key in the checkout's `vargus.jsonc`, creating the file on the
first change. The other hosts using this checkout pick it up on their next
load or refresh. You can also edit the file by hand and run `/reload-plugins`
or open a new session. [Shared configuration](../README.md#shared-configuration)

Opening `/config` copies shared choices into the native picker. When a key is
removed from the file, the row and picker use the previous native value again.
Claude saves that value when the picker restores it, even if it originally came from a default.
Removing the VArgus marketplace and its plugin data clears those saved fallbacks.
If another plugin adjusts a shared choice as Claude imports it, Claude’s picker
and status line use the accepted value until the shared choice changes.
The checkout file keeps the value you selected for the other hosts.
A change you make in the picker becomes the new native choice as well as the
shared value. Unspecified keys keep Claude's plugin settings and manifest defaults.
Managed settings keep their locked values. A downloaded marketplace install
without a shared checkout or options file uses Claude's own plugin settings.

Set **Folder fold threshold** to `16` in the VArgus options to fold paths over 16 columns.

Rate-limit API reads stop when `rateLimits` is off. Git/svn polling stops when
`repo`, `branch` and `status` are all off.

On a detached Git HEAD, the branch label shows the checkout ref or short commit ID.
During a rebase it shows the branch being rebased when available.
The spend limit (`spendLimit`) defaults to off.
Claude shows the account-wide five-hour and seven-day limits when available.

- **Theme**: one of five bundled palettes, `graphite` by default (near-monochrome; only the usage
  colours carry hue). All but `daylight` assume a dark terminal.
- **Colours off**: set `NO_COLOR` (to any non-empty value) in the environment you start Claude Code from.
  Other programs Claude Code starts see it too.

## Update

```
/plugin update vargus
```

Then run `/reload-plugins`. Your `statusLine` entry doesn't change between versions. Installed
from a clone: `git -C <clone> pull` (or check out the newer tag), then `/reload-plugins`.
If your VArgus reader command does not reference `$f.live`, rerun `vargus install claude` for a user-scope
install or replace the command in the original scope using the manual setup above.

## Remove

1. Run `claude plugin list --json` from the project to check the installed scopes. Before
   uninstalling, check `settings.json` in your Claude config directory and the affected project's
   `.claude/settings.local.json` and `.claude/settings.json`. Remove the VArgus `statusLine` entry
   for the scope you're removing if no remaining installation uses that reader. A VArgus reader
   points to `vargus-vargus/$CLAUDE_CODE_SESSION_ID/line`. Confirm before editing shared project
   settings. If you backed up a previous status line, restore it to the settings file you just edited.
   A reader left behind after the last uninstall can show a blank row.
2. Run `claude plugin uninstall vargus@vargus --scope <scope>` from a shell, or remove it in
   `/plugin` under **Installed**.
3. If you also want to remove the directory marketplace, check `extraKnownMarketplaces` in
   the settings files from step 1. Keep any declaration another installation needs. For example,
   if both user and project settings declare `vargus`, remove just the project declaration with
   `claude plugin marketplace remove vargus --scope project` from that project.
   Use `claude plugin marketplace remove vargus` only for a full removal across scopes.
   It also uninstalls remaining plugins from that marketplace.
4. Reload plugins or close affected sessions. For a directory install, follow
   [Remove shared files](../README.md#remove-shared-files).

## Limits

- Teammates that run in their own tmux pane are not seen.
- The row omits lines changed, PR state, session name and prompt-cache lifetime.
- A session that ends without its end event (a crash, `kill -9`) leaves its small folder in the
  plugin's data folder until a later session removes it, 14 days after its last write. Where an
  organization refuses the mod's processes, every session's folder stays.
- Labels are English only for now.
- On Windows the mod moves and removes files with `cmd.exe` (`move`, `rmdir`). When the config
  folder's path holds a character cmd acts on (`&`, `,`, `;`, `=`, `^`, `%`, `!`, `(`, `)` and
  others), it hands cmd nothing: the line is written in place (a refresh can catch it
  half-written) and session folders are not removed.
- A line can lag the session by up to about two seconds. If the mod stops checking in,
  the reader shows the last readings with `| ⚠ stale` after their deadline expires.
  A fresh check-in clears the marker. Old readers need the reader upgrade above.

## Readings

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
writes are excluded. The cache-hit percentage and output decode speed (`t/s`)
in parentheses follow the latest main-conversation request. Claude Code counts
missing provider cache counters as zero. Output speed divides `output_tokens`
by the streamed generation span (first thinking, text or tool chunk to stop,
excluding server-side tool execution spans) when at least 0.5 s elapsed across
multiple chunks; shorter steps keep the previous rate, and model switches,
compaction, `/clear`, resume and usage-less responses clear it.
Subagent replies contribute only to the token total. Tool, agent and
skill counts come from main-loop tool starts. Separate teammates in their own
panes are outside that collector.

See the [Claude design](../DESIGN.md#scope) for data sources and verification
limits, and [VantageHUD's presentation rules](../DESIGN.md#rules-carried-over-from-vantagehud)
for the carried-over behavior.
