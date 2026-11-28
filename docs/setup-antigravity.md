# VArgus for Antigravity CLI

VArgus runs as `agy`'s native `statusLine` beneath the prompt. Use `agy` in a
terminal and Node.js 24.12 or later. The launcher needs no npm install or build.

## Install

Use the [shared checkout and PATH launcher](../README.md#shared-checkout-and-launcher).

### From a terminal

Run this from a terminal on Linux, macOS or Windows.

```sh
vargus install antigravity
```

The installer adds `vargus statusline` to `~/.gemini/antigravity-cli/settings.json`
and preserves your other settings. It keeps an existing VArgus command and its options,
and stops if a different status line command is configured. Open or reopen `agy` to
load the settings. The launcher's directory must be on `agy`'s PATH.

### In an open agy session

After setting up the launcher, run this inside `agy` on Linux or macOS to save the
setting and show the row immediately. If you use another launcher location,
substitute the verified path. Save any status line you want to restore later.

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

### On Windows

Set up the [Windows PATH launcher](../README.md#put-vargus-on-path). To save and
apply the setting in an open `agy` session, run the following command.

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

### Agent setup inside agy

In the checked `agy` builds, the agent's sandbox protects
`~/.gemini/antigravity-cli/settings.json`. Prepare and verify the launcher, then
give the user the [in-session command](#in-an-open-agy-session) or the
[Windows command](#on-windows) to apply it. Report the checkout and launcher path
you verified. Outside `agy`, use the [terminal installer](#from-a-terminal) and
report any existing command it refuses to replace.

The checked Linux sandbox mounts `~/.local/bin` read-only with only `agy` visible.
On macOS, `ls -ld` and `readlink -f` on `~/.local/bin/vargus` worked even when listing
the directory was blocked. Get approval to run checkout or launcher operations
outside the sandbox when it blocks them. You can test `./bin/vargus` from the
active workspace as well. See the [setup boundary evidence](../DESIGN.md#antigravity-cli-native-statusline).

## Verify

From a POSIX terminal, send a sample model reading through the launcher.

```sh
printf '%s\n' '{"model":{"display_name":"Gemini 4 Carbon (High)"}}' | NO_COLOR=1 vargus statusline
```

In PowerShell, use the same input with the Windows launcher.

```powershell
'{"model":{"display_name":"Gemini 4 Carbon (High)"}}' | vargus statusline
```

Look for `carbon:high` in the output. This checks the launcher and renderer with
sample data. To verify activation, look for the row under the prompt in `agy`
after applying the setting or reopening the session. If an existing VArgus
command was disabled, run `/statusline on` in `agy`.

If collection fails during a refresh, VArgus can show the last row for that
conversation and configuration with `| ⌛stale` (`| !:stale` on WSL). A successful invocation clears
the marker. If agy stops invoking the status command, the row cannot update.

## Configure

Antigravity reads the checkout's `vargus.jsonc` on every status-line invocation.
Set `"folderFoldThreshold": 16` to fold paths over 16 columns. An edit takes effect on the next refresh. [Shared configuration](../README.md#shared-configuration)

To override shared options with `--config FILE` or `--theme NAME`,
append the flags to your existing `statusLine.command`. With `vargus` on PATH,
use the JSON string for your platform as the `command` value. Substitute the path
to your options file.

**Linux or macOS**

```json
"vargus statusline --config \"$HOME/.config/vargus.json\" --theme agy-tokyonight"
```

**Windows**

```json
"vargus statusline --config \"C:\\Users\\Pat Lee\\.config\\vargus.json\" --theme agy-tokyonight"
```

The explicit file accepts JSON or JSONC and uses the keys and defaults in
[`src/options.ts`](../src/options.ts).

- **Model names**: Gemini and Claude display labels shorten to their family with effort
  (`Gemini 4 Carbon (High)` → `carbon:high`, `Gemini 4 Hydrogen (XHigh)` → `hydrogen:xhigh`,
  `Gemini 3.8 Flash (Low)` → `flash:low`, `Claude Opus 5.5 (High)` → `opus:high`);
  Orchestrator models keep their variant (`orchestrator(carbon)`, `orchestrator(argon)`);
  other provider names stay whole (`GPT-OSS 120B (Medium)` → `gpt-oss-120b:medium`).
- **Quota groups**: Gemini and Orchestrator models show the `"Gemini Models"` `5h:` and `7d:`
  buckets; Claude and GPT models show the `"Claude and GPT models"` `5h:` and `7d:` buckets.
  Switch to a model in the other group to see its limits.
- **Call counts** show `🔧` for `tool_calls`, `🤖` for `invoke_subagent` and `swarm` `add`
  spawns, and `⚡` for Antigravity `SKILL.md` reads once per skill path per user turn.
- On a detached Git HEAD, the branch label shows the checkout ref or short commit ID
  and any detected Git operation. During a rebase it shows the branch being rebased
  when available. Setting `repo`, `branch` and `status` all to `false` disables
  Git/SVN checks. Setting `NO_COLOR` in the shell environment disables ANSI colours.

## Update

Update your clone with `git -C "$HOME/.local/share/VArgus" pull` (or fetch tags and check
out a release tag). Because `agy` runs `vargus statusline` on each refresh, updated code
takes effect immediately on the next status-line update with no restart.

## Remove

1. Outside `agy` (with `vargus` on PATH, or `./bin/vargus` from the checkout),
   run `vargus remove antigravity` to remove the VArgus `statusLine` entry from
   `~/.gemini/antigravity-cli/settings.json` while preserving your other settings
   (it stops if a different status line command is configured), then reopen `agy`.
2. Inside an open `agy` session (where the agent sandbox protects `settings.json`),
   check the current `statusLine.command` first to preserve any unrelated
   integration, then run `/statusline delete` in `agy` to restore the built-in row.
   Restore any previous status-line entry you saved before installing VArgus.
3. Follow [Remove shared files](../README.md#remove-shared-files).

## Readings

Antigravity CLI reads live model, context and quota fields from `agy`'s `statusLine`
JSON input and incrementally replays the active conversation's `transcript.jsonl`
for session age, uncached input plus output tokens, and tool, subagent (`invoke_subagent`,
`swarm` `add`) and skill (`SKILL.md` reads) counts. By default (`includeSubagents: true`),
VArgus recursively folds `invoke_subagent` child and nested descendant transcripts' tokens,
tools, agents and skills (resolving isolated-worktree children's custom skills against their
own recorded workspaces, bounded at depth 8, 64 child transcripts and 400 ms per refresh);
`swarm` and `run_workflow` child transcripts are excluded. Setting `includeSubagents: false`
(in `vargus.jsonc` or your `--config` file) keeps tokens and call counts on the active
conversation only with no child transcript I/O. Context, cache-hit percentage, output
decode speed (`t/s`), session age, model, effort, quotas and VCS always remain on the
active conversation.
The cache-hit percentage in parentheses comes from the active conversation’s latest request in
the status-line payload’s `context_window.current_usage`. Output decode speed (`t/s`)
is timed live from the first mid-stream `statusLine` refresh (while a model call is
in flight and no payload field changed other than quota reset countdowns) to the
`transcript.jsonl` completion flush when at least 0.5 s elapsed; shorter bursts
and aborted/errored turns preserve the previous rate, while model switches,
compaction, `/rewind` and zero-output replies clear it. Because `transcript.jsonl`
records no response durations, `t/s` starts hidden on a freshly resumed
conversation until the next streamed reply; on a new conversation's first turn
the background title request can trigger an early refresh, and typing in the
composer while waiting for the first token can pull that step's reading toward
end-to-end speed.

Live rendering checks used `agy` 1.5.8 on Linux on 2026-11-14 and `agy` 1.5.14 on
Linux on 2026-11-22 (for live `t/s` rendering and burst preservation). The macOS
`agy` 1.5.9 checks on 2026-11-16 covered setup access. See
[DESIGN.md](../DESIGN.md#antigravity-cli-native-statusline) for platform and
verification details.
