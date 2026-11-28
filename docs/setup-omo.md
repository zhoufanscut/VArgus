# VArgus for OmO Native

VArgus adds a widget below the editor in the OmO Native TUI. The installer uses
Node.js 24.12 or later. Linux TUI checks used OmO 5.1.61 on 2026-11-14. See the
[verification details](../DESIGN.md#live-evidence-and-limits) for what they cover.

## Install

From the [shared checkout](../README.md#shared-checkout-and-launcher), install the loader.

```sh
./bin/vargus install omo
```

On Windows use `bin\vargus.cmd install omo`. The command asks
`omo config agent-dir --json` for the active agent directory and creates only
`extensions/vargus.ts` there. Use `--dir EXTENSIONS_DIRECTORY` to choose an explicit
extension directory. Record the loader path printed by the installer. If you
use `--dir`, pass that same directory when configuring, updating or removing
the loader.
The installer refuses to overwrite an unrelated or modified loader.
The loader imports `src/hosts/omo/register.ts` in this checkout; do not move or
delete the checkout while installed.
No SDK package, npm install or build is needed.

## Verify

Run `/reload` in OmO or start a new native session. Run `/vargus status` and
look for `VArgus is on` and the widget below the editor. New sessions default on.
Use `/vargus on` to turn it back on in a session where you had turned it off.
The row starts with two spaces, included in its terminal width budget.
It hides the **entire native footer, including lifecycle and extension statuses**,
as requested for this initial integration. Separate task/todo widgets, question
dialogs and the working indicator remain owned by OmO. Other footer-replacing
extensions can compete with VArgus; disabling VArgus restores OmO's built-in footer,
not an earlier custom footer.

The widget checks the time of the last successful collection when it draws.
After five seconds without one, it adds `| ⌛stale` (`| !:stale` on WSL) to the last readings.
The next successful update clears it. A frozen OmO UI can show a change only
after drawing resumes.

## Configure

The extension reads `vargus.jsonc` from the VArgus checkout when it loads and
polls it every second while active, so hand edits apply automatically to any key
not overridden by an install-time `--config` file or session `/vargus config`.
Run `/reload` after editing an explicit `--config` file or updating VArgus code. [Shared configuration](../README.md#shared-configuration)

For a separate JSON or JSONC file, create it before running the installer, or reuse the one you pass
to Codex or Antigravity CLI. For example, save this JSON as `~/.config/vargus.json`.
See the [shared option keys](../src/options.ts).

```json
{"theme":"omo-violet","session":false}
```

For a loader in the active agent directory, run the following command from the
checkout, substituting your file's path if it differs.

```sh
./bin/vargus install omo --config "$HOME/.config/vargus.json"
```

For a custom loader or a loader outside the active agent directory, pass the
exact directory containing the recorded loader.

```sh
./bin/vargus install omo --dir "/absolute/path/to/extensions" --config "$HOME/.config/vargus.json"
```

The loader saves the absolute path and VArgus reads the file when OmO loads the
extension. Run `/reload` after editing the file. To change its path, rerun the
command for that loader with the new file. Reinstalling without `--config` keeps
the saved path. To stop using the file, [remove the loader](#remove) and
reinstall without `--config` in the same directory.

```text
/vargus off
/vargus on
/vargus status
/vargus config {"theme":"graphite","folder":true,"folderFoldThreshold":16,"rateLimits":true}
```

VArgus saves your on/off choice and `/vargus config` overrides with the current
session. Saved options take precedence over the install-time file, then the
checkout file, then built-in defaults. Sessions configured with an older VArgus may
have saved a full set of options. An explicit `off` survives reload and resume.
New sessions default on.

## Update

After updating this checkout, run `/reload` in OmO. If the checkout moved or your
loader still points to the former top-level extension entry, rerun
`./bin/vargus install omo` from the intended checkout first. Pass the original
`--dir` for a custom loader.

## Remove

Check the recorded loader path before running removal. If it is in the active
agent directory, run this from the checkout.

```sh
./bin/vargus remove omo
```

For a custom loader or a different agent directory, pass the exact directory
containing the installed loader.

```sh
./bin/vargus remove omo --dir "/absolute/path/to/extensions"
```

On Windows, use `bin\vargus.cmd` for either command. Check the printed path
against the install path and confirm the corresponding `vargus.ts` is gone.
Then `/reload` or quit each affected OmO session before
[removing shared files](../README.md#remove-shared-files).
Removal touches only the owned loader. The separate experimental
`vargus-preview.ts`, if installed, is left untouched.

## Readings and limits

On a detached Git HEAD, the branch label shows the checkout ref or short commit ID.
During a rebase it shows the branch being rebased when available.

Main-session tokens count persisted assistant input plus output across the whole
session history, including earlier branches and compaction history. Cache reads,
cache writes and embedded tool-result usage are excluded. Native assistant edits made
while this extension is loaded are recorded as non-billable copies, so editing a
response does not increase its token total. OmO does not persist edit provenance
itself: copies made before installation or through another client without VArgus
cannot be distinguished reliably and remain in the recorded total.
The cache-hit percentage and output decode speed (`t/s`) in parentheses follow the
latest main-session assistant request. Output speed times live streamed assistant
deltas from the first thinking, text or tool-call stream event to the last (so
TTFT is excluded) when at least 0.5 s elapsed; shorter bursts and aborted,
errored or deferred replies preserve the previous rate, while completed replies
without output usage, model switches, compaction or branch navigation clear it.
Because persisted OmO sessions do not record stream-start
times for text or tool blocks, `t/s` starts hidden after `/reload` or `/resume`
until the next streamed reply. An edit identified by VArgus preserves the
preceding request's cache hit and speed.
Tools count persisted outer
assistant tool calls; calls hidden inside `eval` are not added. Agents count distinct
task IDs from accepted spawn results. Main-session skill counts are omitted because a
`SKILL.md` read alone does not establish a skill load.

By default (`includeSubagents: true`), VArgus asynchronously reads OmO's on-disk
`senpi-task` store and folds subagent tokens, tools, deduplicated agent counts and
explicitly resolved child task skills (`skills.resolved` on accepted spawn receipts,
excluding missing skills) into the main-session totals across direct children, nested
descendants, revived runs and DAG/team/workpool tasks, excluding confirmed
pre-launch refusals (including fallback-chain admission refusals and provisional
spawn receipts whose store record later confirms refusal for that run) from both
agent and skill counts. Setting `includeSubagents: false` (in `vargus.jsonc`, your
`--config` file, or `/vargus config {"includeSubagents":false}`) keeps tokens,
tools and agents on the main session with no task-store disk I/O (skills stay
omitted). An open widget remembers a confirmed refusal in memory
after OmO expires the task record (cleared on `/reload`, `/resume`, or
reconfiguring `/vargus`). Cache-hit percentage, output
speed (`t/s`), context, model, effort, session time, quotas and VCS always remain on
the main session. Other skill-loading paths (such as `SKILL.md` reads) remain
uncounted, expunged tasks' tokens, tools and nested child skill receipts drop once
removed from disk (while accepted spawn IDs and resolved task skills already recorded
in surviving transcripts remain counted), and background memory sidecars outside
`senpi-task` are excluded.

OmO shortens known models to labels such as `opus`, `sol`, `sol-pro`,
and `nova-pro`. For example, `deepseek-v4-flash` displays `deepseek`
and `deepseek-v4-pro` displays `deepseek-pro`. Unfamiliar IDs are shown in full.
Speed appears after effort, as in `sol:high(fast)` and `sol:high(ultrafast)`.
Kimi highspeed variants and Venice's Kimi K3 Fast use `(fast)`.

Context defaults to `ctx:0%` until OmO supplies a reading. Quotas follow the selected
provider: Claude and ChatGPT subscription windows come from OmO's subscription-limit
service. Kimi Coding uses its regional usage endpoint for five-hour (`5h`) and monthly (`1mo`)
windows, enabled by default. OmO resolves its existing Kimi credential and region;
VArgus does not read credential files. Usage refreshes every 90 seconds while Kimi
is selected, with a 30-second request timeout and longer waits after errors; on
failure, Kimi keeps its last readings for up to 15 minutes before showing an error badge.
Switching to another provider clears Kimi readings and cancels pending requests.
Other API providers do not inherit unrelated subscription windows.
Only window labels, percentages and reset
countdowns are shown; provider/account names are hidden. Multiple accounts' windows
remain separate, without implying which account is active. Unknown durations keep their host labels.
Errored subscription reports keep their last readings for at most 15 minutes; older
readings and expired windows disappear. An existing `kimi-coding-status.js` extension remains independent
and may also poll Kimi; VArgus does not consume its hidden footer status.

Support targets the native TUI. RPC, JSON and print modes are not modified.
See [DESIGN.md](../DESIGN.md#omo-native) for counting and lifecycle contracts.
