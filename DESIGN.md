# VArgus design

VArgus collects readings from four hosts and renders one status row. This document
describes the current contracts and the reasons for them. Use the
[setup guides](README.md#choose-your-setup) for commands and
[CHANGELOG.md](CHANGELOG.md) for release history.

- [Architecture and setup ownership](#hosts-and-outputs)
- [Shared rendering, options and repository readings](#fragments)
- [Codex](#codex-cli), [OmO Native](#omo-native),
  [Antigravity CLI](#antigravity-cli-native-statusline), [Claude Code](#claude-code)
- [VantageHUD rules](#rules-carried-over-from-vantagehud),
  [unsettled behavior](#unsettled), [tests and live evidence](#tests)

## Hosts and outputs

### How it works

| Host | Collection and wiring | Output |
|---|---|---|
| Claude Code | [Mod registration](src/hosts/claude/register.ts) observes engine events and reads usage. | The mod writes a line file. The native `statusLine` command reads it. |
| Codex CLI | [CLI controls and worker](src/cli/codex/) follow the displayed thread's saved session log. | A pane-owned row in tmux or native Windows psmux. |
| OmO Native | [Extension registration](src/hosts/omo/register.ts) reads session history, active model and subscription limits. | A widget below the editor that replaces the built-in footer. |
| Antigravity CLI | [Command entry](src/cli/antigravity.ts) reads the host's JSON payload and the active conversation's transcript. | One ANSI row on stdout for the native `statusLine` surface. |

Hosts own collection and the lifetime of readings. They pass
[shared values](src/core/types.ts) and display inputs to the renderer. Model
names, speed markers and count visibility are prepared per host, with the
original identifiers retained for lookup. Options, fragment ordering, text
formatting and themes live in shared code.

- `src/core`, `src/render`, `src/theme`, `src/i18n` and `src/options.ts` stay
  independent of hosts, outputs, CLI and Node APIs.
- Hosts collect independently. CLI entries wire Node hosts to outputs. OmO's
  registration module is the only host entry that imports an output adapter.
  Output adapters stay independent of collectors and CLI wiring.
- `src/node` holds reusable Node I/O such as the Git and SVN readers. It depends on
  Node and shared code. The Claude mod graph uses local modules and the
  `claude-code` API.
- The Node launcher runs the checkout's TypeScript directly on Node 24.12 or
  later. Its explicit `.ts` imports and erasable syntax are checked by
  [tsconfig.node.json](tsconfig.node.json). npm packages are development and
  test dependencies.

[Boundary tests](tests/shared/boundaries.test.mts) resolve literal imports
before checking ownership, including the reachable Claude mod graph.

### User-facing setup paths

The [shared checkout and launcher](README.md#shared-checkout-and-launcher)
can serve several hosts. Setup ownership follows the artifact it writes.

- [Claude](docs/setup-claude.md) and [Antigravity](docs/setup-antigravity.md)
  manage their own `statusLine` entries. Both installers refuse a different custom
  configured reader. [Settings I/O](src/cli/settings.ts) follows symlinks,
  locks the target, checks for intervening edits and replaces it atomically.
- [Codex](docs/setup-codex.md) installs callbacks in the selected Codex home.
  Hook review and the saved Thread ID selection happen in Codex.
- The [OmO loader](docs/setup-omo.md) imports its checkout by file URL. Loader
  changes require a match to VArgus's generated format.

Finish host-specific removal and restoration before removing a launcher or
checkout that those integrations still use.

## Fragments

[The renderer](src/render/index.ts) starts with the folder, model and effort,
limits, context, tokens, session age and call counts. Repository, branch and
working-tree status come last. Empty or failed fragments are omitted.
The renderer drops whole trailing fragments to fit the terminal, keeping the
first if it is the only one left. Width counts terminal columns. A host output
can fit the result further, as OmO does at grapheme boundaries.

The [folder fragment](src/render/fragments/folder.ts) measures the sanitized,
home-shortened path before styling. Above `folderFoldThreshold` it folds to
`.../` and the last two components in full only when that drops at least one
ancestor and is strictly shorter than the home-shortened path. The folded label
can still exceed the threshold. At 16 columns `~/projects/payments/api` folds.
The 24-column default keeps that 23-column path intact.

The [token fragment](src/render/fragments/tokens.ts) keeps the session's token
total and appends a `detail` parenthesized suffix with the latest request's
cache-read share of prompt input and its output speed (`t/s`), separated by `, `
when both are present.
Cache-hit share rounds to one decimal place with trailing zeros omitted, and a
partial hit displays at most `99.9%` so `100%` means every input token was
cached. Zero cache reads in the host's usage show `(0%)` (or `(0%, 48t/s)`).
Output speed divides `output_tokens` (including thinking/reasoning tokens) by
the streamed decode duration from first output token to last, requiring a
minimum 500 ms window (`outputTokensPerSecond` in
[session.ts](src/core/session.ts)) to filter single-chunk bursts and tiny
replies; rates under `10` show up to one decimal place (`4.3t/s`), rates from
`10` up round to whole integers (`48t/s`), and values rounding to `0` are
omitted. Either value is omitted when unavailable, and the existing `tokens`
switch governs the whole fragment.

Hosts produce ordered [quota readings](src/core/limits.ts), including labels
and error badges. The [limits fragment](src/render/fragments/limits.ts) rounds
and colours percentages, formats reset times, skips expired
windows, and keeps windows without a known reset. Each host decides which
readings are current or absent.

The [context fragment](src/render/fragments/context.ts) rounds the percentage
with no text suffixes and defaults unknown context readings to `ctx:0%` across
all hosts.

A whole-row freshness warning appends ` | ⌛stale` (` | !:stale` on WSL) to the
last available readings, using `sep` for the divider and `label` for the marker and text. The [formatter](src/render/freshness.ts) drops trailing
readings when needed to fit the warning; its structured entry (`renderParts` / `staleParts`) operates directly on rendered fragments so literal ` | ` inside external names is never split even under `NO_COLOR`. Missing individual metrics retain their
own display rules.

### Config

[Shared defaults](src/options.ts) and the Claude manifest agree on picker keys
and defaults. Both follow the shared key order in [the sample](vargus.sample.jsonc).
The shared `callCounts` setting controls the tool, agent and skill counts together.
The shared `includeSubagents` setting defaults to `true`, folding attributable
subagent tokens and call counts into session totals; setting it to `false` keeps
counts on the active conversation only.
Codex's [startup hook option](src/hosts/codex/options.ts) defaults on.
Explicit activation or hook installation enables its tmux integration.

The recommended install runs from one checkout. Its optional
[`vargus.jsonc`](README.md#shared-configuration) supplies shared values, with
only the keys present overriding built-in defaults. The Node reader resolves
the path from its own module. Looking in the session's working directory
would select a different file when the user changes projects. Explicit option
files use the same comment-aware parser. Flags keep their argument order, and
OmO's saved session overrides remain the top layer for that session.

The Claude Code 2.1.323 `PluginOptions` declaration describes registration
values as “defaults filled in.” Its `ConfigKind` includes `'number'` for
settings such as the folder fold threshold. Its `config.set` declaration says
“`next(e)` resolves to `{ value }` once written.” In the 2.1.323 TUI,
overriding `config.list` changed the API result while the native panel still
displayed the saved choice. The built-in `config` and `reload-plugins`
commands both raised `command.run` in a throwaway plugin. VArgus synchronizes
unlocked file choices through `$.config.set` before opening the native panel.
It records prior native choices by checkout and key in `picker-backups.json`
in Claude's VArgus plugin data directory. Updates compare the original bytes
before publishing so sessions editing different keys preserve each other's choices.
The shell writer preserves literal backslashes in POSIX paths and converts
Windows drive separators for Git Bash. A Linux profile named `profile\west`
kept its backup and restored the previous theme after the shared key was removed.
Removing that key restores the fallback. A deliberate picker edit replaces
the fallback. The renderer reads the file at startup and on the reload command,
including when Claude keeps the loaded module. A picker edit stages a change beside
the destination, passes the event to Claude, and publishes the accepted value
after checking the original bytes. It changes one top-level value and preserves
unrelated settings and comments. A file edit from another session between
staging and publication requires a fresh read and merge. The native settings
supply the fallback for omitted keys. [Claude mod reference](https://code.claude.com/docs/en/plugins/mods/reference)

In a 2.1.323 throwaway directory plugin the native save reloaded the mod while
the setting hook was still running. The pending key in `$.state` lets the new
copy use Claude's accepted value during that handoff. Saving a value already
stored in Claude can also change the shared file without reloading the mod.
The running copy then updates its renderer and affected collectors directly.

Removing the VArgus marketplace in Claude Code 2.1.323 erased the plugin
data directory and native options while a `$.store` entry survived. With the
backup in the data directory, reinstalling the same checkout without the shared
file left the default Graphite theme in the picker. In a live two-plugin check,
a second plugin rewrote a shared Ember request to Daylight. The picker and row
used Daylight through a reload. VArgus remembers a rewrite with the shared value
that requested it and retires that association when the file value changes.

### Visual grammar

The row uses one compact layout across all four hosts:

```
~/proj/VArgus | opus:high(fast) | 5h:4%(4h37m) 7d:39%(5d6h) | ctx:20% | token:69.5k(99.4%, 48t/s) | session:24m | 🔧73 🤖2 ⚡1 | repo:VArgus | branch:main(wt:x) | ✗1 +2 !3 ?4 ⇡1 ⇣2 | ⌛stale
```

- **Dividers and spacing**: ` | ` (`sep`) separates fragments; a single space
  separates peer items inside one fragment (`5h:… 7d:…`, `🔧73 🤖2 ⚡1`,
  `+2 !3 ?4`).
- **Weight**: only `folder` is bold (`bold text`); every other fragment is
  regular weight.
- **Parentheticals**: attach directly to their value with no leading space
  (`opus:high(fast)`, `orchestrator(carbon)`, `5h:4%(4h37m)`,
  `token:69.5k(99.4%, 48t/s)`, `branch:main(wt:x)`,
  `branch:feat(rebase 2/3)(wt:w)`). Multiple `detail` items in one suffix join
  with `, ` (`(99.4%, 48t/s)`, `(carbon, fast)`).

| Pattern | Form | Tokens | Examples |
|---|---|---|---|
| Location anchor | path | bold `text` | `~/proj/VArgus`, `.../parent/leaf` |
| Key : identity | `key:value` | `label` prefix + plain `text` (detached `@` in `label`) | `repo:VArgus`, `branch:main`, `branch:@v1.0` |
| Key : reading | `key:value` | `label` prefix + `calm` or `alert` | `opus:high`, `5h:4%`, `ctx:20%`, `token:69.5k`, `session:24m` |
| Model without effort | `name` | `label` | `opus`, `orchestrator` |
| Secondary parenthetical | `(info)` attached | `detail` | `(carbon)`, `(argon)`, `(fast)`, `(ultrafast)`, `(4h37m)`, `(99.4%, 48t/s)`, `(wt:x)` |
| Git operation parenthetical | `(op)` attached | `alert` | `(rebase 2/3)`, `(merge)`, `(bisect)` |
| Icon prefix | `<icon><text>` (WSL `<char>:<text>`, see below) | `label` | `🔧73 🤖2 ⚡1` / `T:73 A:2 S:1`, `⌛stale` / `!:stale` |
| API error badge | `[API CODE]` | `alert` (in the rate-limit slot) | `[API 429]`, `[API AUTH]`, `[API ERR]` |
| VCS status | `<mark><count>` | `add` (`+`, `⇡`), `del` (`✗`, `!`, `⇣`), `track` (`?`) | `✗1 +2 !3 ?4 ⇡1 ⇣2` |

All hosts select the WSL text fallback (`T:`, `A:`, `S:`, `!:stale`) only on WSL and ignore `WSLENV`: native Windows processes launched from Windows Terminal inherit `WSLENV` (such as `WT_SESSION:WT_PROFILE_ID:`) to forward variables into `wsl.exe`, which previously forced false text fallback on native Windows (`win32`) with PowerShell and `psmux` (clearing only `WSLENV` in the same native Windows process switched the preview from `T:73` to `🔧73`). The Node hosts ([`detectWsl`](src/node/wsl.ts), shared by Codex, OmO, Antigravity and `vargus themes`) require Linux (`process.platform === 'linux'`) plus `WSL_DISTRO_NAME`, `WSL_INTEROP`, or a `/microsoft/i` `os.release()` kernel string. The Claude mod ([`isWsl`](src/hosts/claude/register.ts)), which has no `process.platform` API, returns `false` on drive-path Windows environments (`USERPROFILE` a drive path without a `/` `HOME`, or a drive-path working directory) and otherwise checks `WSL_DISTRO_NAME`, `WSL_INTEROP`, or `/proc/version` matching `/microsoft/i`.

### Colours

[Themes](src/theme/index.ts) use 24-bit SGR styles and default to `graphite`.
Each palette in [palettes.ts](src/theme/palettes.ts) defines 9 tokens: `text`,
`label`, `detail`, `sep`, `calm`, `alert`, `add`, `del` and `track`, and
`PALETTE_POLARITY` (surfaced via `resolvePalette`) tags each bundled palette as
`dark` or `light`.
Every bundled palette follows the same 3-group data-first OKLCH rules, checked in
[theme.test.mts](tests/shared/theme.test.mts) across dark (`#181818`–`#282828`)
and light (`#ffffff`–`#f6f8fa`) background ranges:

- **5-step data-first tonal ramp (`text > calm > label > detail > sep`)**:
  strictly ordered by contrast against the worst-case background and sharing one
  theme hue family (hue spread `≤ 35°`; achromatic `C = 0` in `graphite`). In
  the four coloured themes, `text` and `sep` stay near-neutral (`OKLCH C ≤ 0.03`),
  `calm` and `detail` carry a light highlight / soft shadow tint (`C ≤ 0.06`),
  and `label` carries the signature theme colour (`0.08 ≤ C ≤ 0.11`).
- **Contrast floors & polarity**: every dark-theme token is brighter than
  `#282828` and every `daylight` token is darker than `#f6f8fa`; on the
  worst-case background, every readable token (`text`, `calm`, `label`, `detail`,
  `add`, `del`, `track`) `≥ 4.5:1`, `alert ≥ 5.0:1` (and contrast `≥ del`), and
  `sep` stays between `1.4:1` (worst-case) and `2.5:1` (typical).
- **Alarm isolation**: `alert` is vivid red and the highest-chroma token on
  the row, with OKLCH chroma at least `2×` `del` and `1.5×` `label`.
- **Balanced VCS triad**: `add` (green), `del` (muted red) and `track` (distinct
  3rd hue) sit between `label` and `detail` in lightness and worst-case contrast
  with matched lightness (`spread ≤ 0.03`) and chroma (`spread ≤ 0.015`);
  conflicts (`✗`) stay on `del` ([vcs.test.mts](tests/shared/vcs.test.mts)).
- **Adjacent-pair separation**: 14 side-by-side token pairs (`text`–`calm`,
  `text`–`label`, `label`–`calm`, `calm`–`detail`, `label`–`detail`,
  `text`–`detail`, `label`–`alert`, `calm`–`alert`, `alert`–`detail`,
  `text`–`alert`, `del`–`alert`, `add`–`del`, `add`–`track`, `del`–`track`) meet
  `OKLab ΔE ≥ 0.08`.
The palette registry uses own-property lookup and falls back for unknown
names. When a host sees a non-empty `NO_COLOR`, the theme returns plain text. Run
`vargus themes [NAME]` ([themes.ts](src/cli/themes.ts)) to preview bundled palettes
in the terminal through the shared renderer; it separates palettes into dark and
light sections, forces each polarity's typical reference background (`#181818` for
dark, `#ffffff` for light) on swatch and sample rows with per-line SGR resets
when colour is enabled, and omits all escapes and padding under `NO_COLOR`. External
text passes through [control-character sanitization](src/render/text.ts) before
styling. The tmux output translates the renderer's styles without recursively
expanding content from paths or branches.

Element-to-token mappings follow the [visual grammar](#visual-grammar).
Readings with a threshold use two flat tiers (`calm` / `alert`):

- `ctx` and rate-limit percentages flip at 80%.
- `tokens` flips at `4.00M` (3,995,000 tokens, matching two-decimal `M` rounding
  from `3.99M` to `4.00M`) by default (`includeSubagents: true`) and at `1.00M`
  (999,950 tokens, matching its `k`/`M` switch) when `includeSubagents` is `false`.
- `session` age flips at 12 hours.
- Effort uses `calm` at or above the model's default and `alert` below it. An
  absent default uses `high`. An exact match to the baseline is `calm` even for
  an unfamiliar named level. Unranked or numeric values that cannot be compared
  use `alert`. The host supplies the baseline separately from the model's
  display name. [Model fragment and comparison](src/render/fragments/model.ts)

### Languages

[English labels](src/i18n/en.ts) define the keys used by fragments. Register a
complete label table in [src/i18n/index.ts](src/i18n/index.ts) to add a language.
The null-prototype registry and own-property lookup fall back to English for
unknown names. The [labels test](tests/shared/labels.test.mts) checks for
display text written directly into fragments.

### Repository readings

[Node VCS I/O](src/node/vcs.ts) ([Git](src/node/git.ts) and [SVN](src/node/svn.ts))
is shared by Codex, OmO and Antigravity. Claude uses its own
[Git and SVN collector](src/hosts/claude/collect/vcs.ts) through the mod API.
Pure Git porcelain and SVN XML/URL parsers live in [src/core/vcs.ts](src/core/vcs.ts).
Both Git readers use porcelain status with `GIT_OPTIONAL_LOCKS=0` and
`core.fsmonitor=false` to avoid rewriting the user's index or invoking its
filesystem monitor. The Node reader runs status, directory and remote checks in
parallel and waits for each before returning, even when status fails outside
Git. A Windows regression checks that the non-repository working directory can
then be removed immediately. When porcelain reports `# branch.head (detached)`, the
branch fragment uses the actual worktree's metadata to name the checkout and
show any in-progress operation. The `branch` switch controls this fragment
for both attached and detached checkouts. Older `detachedHead` settings are
ignored. The folder fragment keeps the session's working directory.

Hosts gate polling on the repository, branch and status switches. They poll
on a five-second baseline and hold off a slow walk by ten times its duration.
Claude, OmO and Antigravity can request earlier work after relevant tools
subject to that hold. A directory or worktree change invalidates old readings.
All four hosts fall back to local SVN XML in a working copy outside Git (Git
wins ties when nested), counting property as well as item status across the
four local marks (`✗`, `+`, `!`, `?`):

- `conflicted` (`✗`): `conflicted` and `obstructed` items, `props="conflicted"`,
  and `tree-conflicted="true"`.
- `staged` (`+`): `added` items only (SVN has no index, so `deleted` and
  `replaced` do not show in green `+`).
- `modified` (`!`): `modified`, `deleted`, `replaced`, `merged`, `missing`, and
  `incomplete` items, and property-only modifications (`props="modified"`),
  counted once per path.
- `untracked` (`?`): `unversioned` items.

The SVN branch label shows the name from the repository URL without a revision
suffix, for example `branch:trunk`.

## Codex CLI

- [Controls](#standalone-controls-in-official-codex)
- [Transcripts, views and drafts](#codex-transcripts-views-and-drafts)
- [Startup hooks](#codex-startup-hooks) and [footer control](#native-footer-control)
- [tmux ownership](#opt-in-tmux-row) and [Windows psmux](#native-windows-codex-and-psmux)

### Standalone controls in official Codex

Codex's shell-mode `!vargus` commands run the launcher against the stock TUI.
[Controls](src/cli/codex/control.ts) bind the shell's `CODEX_THREAD_ID` and a
specific Codex TUI to a background [worker](src/cli/codex/worker.ts). The
[pane resolver](src/outputs/tmux/target.ts) checks the process tree and
foreground application. A shared daemon can inherit another terminal's
environment, so `TMUX_PANE` alone is insufficient. Ambiguous manual targets
require `--pane`, and a non-default server requires `--socket`.

A per-pane lock serializes controls. [State records](src/cli/codex/state.ts)
hold the target, worker identity and recovery data under the OS temporary
directory. Before signalling a worker, the control checks its PID and the
private token in its command line. Stopping a worker sends `SIGTERM`, waits up
to 6 s, and — after rechecking the same PID and token — escalates to `SIGKILL`
(waiting up to 2 s) if it does not exit. Attachment ends through `off` or when the
bound TUI exits.

`reload` validates and replays the root transcript before replacing the worker.
A recovery record retains the root, options and mode. Flags override retained
options in command order, and the original footer backups remain separate.
Workers also record which option keys were explicit. Reload rereads the
checkout defaults for the remaining keys. Older snapshots retain their
effective values because they contain no record of which keys were explicit.
An interrupted manual `off` still suppresses reactivation. A worker without
reload metadata needs an `off` and `on` with the original options.

### Codex transcripts, views and drafts

[Transcript resolution](src/hosts/codex/rollout.ts) prefers the path reported
by read-only `thread/read`. It checks the real path under the selected home's
`sessions` directory and the first record's thread ID. Filename lookup is a
fallback when the RPC fails and exactly one candidate matches. This handles
opaque suffixes without picking an older same-thread file by name or mtime.
A reported path that fails validation fails activation.

[View selection](src/hosts/codex/views.ts) considers the bound root and its
known children. An exact visible UUID can select a known log. The first-field
exception for clipped footers requires a saved Thread ID in that position and
a complete ID. Other positions require an unclipped footer with one UUID.
`session-id` is the legacy alias of `thread-id`. Otherwise selection uses the
complete contextual Main or agent-path label, with an empty primary composer
as the root fallback. Labels in titles, ambiguous agent paths and clipped or
foreign identifiers cannot establish a different thread.

An unidentified ordinary draft or a side chat (`/btw` or `/side`) may hold
the last confirmed snapshot. Readings and time stay frozen while the row reflows
using the normal width rules.
An ordinary draft shows the normal row unless the last read of its source failed.
A side chat marks the held readings stale because they belong to another view.
The current view remains unknown and
`status` identifies the source of the held readings. An unrecognized popup,
foreign ID or clipped ordinary draft blanks the row. At an empty composer,
a blank row releases ownership and discards the snapshot. Reload also needs
a new confirmed view. View selection for display and admission for changing
the footer are separate checks.

### Codex saved-log collector

Each visible thread has a JSONL reader and collector. The reader keeps partial
UTF-8 and incomplete records between polls. It uses the saved
`subagent_history_start_ordinal` in paginated child histories to skip inherited
activity while retaining inherited skill catalogs for later reads. A
paginated reader with a valid boundary stops if a later ordinal is invalid, and
a replaced transcript (`size < offset`) or a corrupt or malformed complete
JSONL record latches its error so later polls or file growth cannot resume past
broken framing. Unsupported mixed histories can yield an identity error and lose
attributed agent and skill counts; later polls still drain any complete buffered
records even when file size has not changed. The row only replays data the
engine saved.

With `includeSubagents: false`, or when both `tokens` and `callCounts`
are `false`, the worker polls only the displayed thread and skips `.jsonl.zst`
discovery so background compressed children are not decompressed. With
`includeSubagents: true` (default) and `tokens` or `callCounts` enabled, the worker also
discovers and polls saved descendant threads of the viewed thread
(`Views.descendants`), including zstd-compressed `.jsonl.zst` rollouts produced
by Codex compression, without creating per-descendant VCS pollers or resolving
descendant model defaults. `Views.refresh` treats `<stem>.jsonl` and
`<stem>.jsonl.zst` as one logical history (preferring `.jsonl` while both
coexist and switching to `.jsonl.zst` once the plain file disappears, without
marking it ambiguous) while still rejecting genuinely distinct stems for the
same thread ID. `RolloutReader` validates RFC 8878 frame, block and checksum spans on the
open descriptor and streams each validated data frame through
`zlib.createZstdDecompress` into the existing JSONL and paginated ordinal parser
(covering multi-frame and skippable-frame files and catching premature EOF and
trailing non-zstd bytes that Node 24's single-frame `node:zlib` zstd stream
otherwise stops on or ignores), caches completed replay by `(ino, mtimeMs, size)` so
unchanged cold children are not re-decompressed on later polls, preserves
remaining decompressed records after a foreign `session_meta` so a directly
viewed mixed `.jsonl.zst` drains them on the next poll without re-decompressing
(matching plain JSONL while keeping `attributable: false` for descendant folding),
and latches replacement or decompression/JSONL errors. The worker's `RolloutReaderCache` replaces a cached
reader (and its view line closure) when `view.file` changes across a
storage-format transition. Each attributable descendant's tokens, tools, agents
and skills fold into the rendered row and paused draft snapshot without mutating
the viewed collector. Ephemeral, ambiguous, unreadable, corrupt, replaced and
unpaginated mixed-history descendants are skipped so inherited parent activity
is never double-counted. Context, cache hit %, output speed (`t/s`), model,
effort, Fast mode, session age, rate limits and VCS remain on the viewed thread.

[The collector](src/hosts/codex/collect.ts) takes cumulative uncached input
plus output from token counts. For the cache percentage it divides
`last_token_usage.cached_input_tokens` by `last_token_usage.input_tokens`
in the selected log. A Codex 0.170.0 localhost probe recorded zero for
missing cache details and repeated the preceding counters when a response
omitted usage entirely. After new model output, a repeated cumulative input
count cannot establish a fresh cache reading. For output decode speed (`t/s`),
a Codex 0.171.0 localhost probe verified that `item_completed` records for
`Reasoning` and `AgentMessage` carry millisecond `started_at_ms` and
`completed_at_ms` excluding TTFT, while `token_usage_record` carries
per-response `usage.output_tokens` (including `reasoning_output_tokens`) before
tool execution. [The rollout reader](src/hosts/codex/rollout.ts) spans
`Reasoning`, `AgentMessage` and `Plan` `item_completed` timestamps, extends the
end to any trailing client tool-call `response_item` timestamp
(`function_call`, `custom_tool_call`, `local_shell_call`) when an earlier item
established the stream start, and pairs that window with `token_usage_record`
(falling back to fresh cumulative `token_count` output when no
`token_usage_record` appears). Pure tool-call-only steps have no recorded
stream-start timestamp and single-chunk bursts record 0 ms, so both preserve
the previous rate; responses without usage, compaction, model switches and Fast
tier toggles clear it. The context gauge uses the last context
reading with Codex's baseline allowance, and compaction clears that reading.
Quota selection prefers the active model's exact recorded slug, then the
general Codex bucket. Labels follow the recorded window duration, falling back
to `1st`/`2nd` when missing or non-positive.

### Codex startup hooks

[Setup](src/cli/codex/setup.ts) adds `SessionStart` and `UserPromptSubmit`
callbacks in `hooks.json`. It retains existing callbacks and their arguments.
Removal preserves retained callbacks' positions and refuses a mixed group
when removal would shift one. Codex 0.169.1 marked an unchanged command as
modified after such a shift. Trust belongs to Codex's review UI.

The [hook](src/cli/codex/hooks.ts) requires an event transcript that matches
the engine's current path and one matching footer below an empty composer.
`SessionStart` retries within a fixed deadline.
`UserPromptSubmit` covers loaded-thread resumes and skips early for a hidden ID
or a manual-off marker. Admission rechecks the footer and TUI identity under
the pane lock. The callback captures control stdout so it stays out of model
context. In the checked TUI, activation occurs after the first normal prompt.

Manual `off` records suppression per thread and TUI, including before a
first callback. `on` clears it. The [startup state directory](src/cli/codex/startup.ts)
enables this coordination. The callback owns the bounded scan.

### Native footer control

[Saved footer settings](src/hosts/codex/footer.ts) come from the effective
workspace config through read-only `config/read`. The worker preloads known
workspaces and retains each thread's original selection before clearing its
footer. Unset settings restore the built-in layout. Explicit empty settings
stay empty. Restoration uses saved settings because session-only changes
and startup overrides cannot be read back reliably.

The worker uses session-only `/statusline` commands. It requires a recognized
empty composer, checks the bound view and TUI process, and verifies the exact
command and cursor before Enter. A command that would wrap is refused before
keys are sent. A visible native error makes delivery inconclusive and keeps
the backup. The [input adapter](src/outputs/tmux/input.ts) sends neither
navigation nor erase keys. Concurrent typing and navigation can race the
observations. Saved `config.toml` stays outside this path.

`off` detaches the row immediately. The worker restores backed-up views as
they are visited with an empty composer, including earlier roots in the same
TUI. It exits when the backups are done or the TUI closes. A crash can leave
backups. If the transcript becomes unreadable, `off` can clean up abandoned
row ownership while leaving footer restoration pending.

### Codex model names and call counts

Known GPT families use [short labels](src/hosts/codex/display.ts). The
[model default lookup](src/hosts/codex/model-defaults.ts) matches the raw
slug for OpenAI threads using the workspace's configured model catalog, or
the home cache when no catalog is configured. Fast is the saved thread's
`priority` or legacy `fast` tier, displayed after effort. This describes
the saved selection.

Tools count completed visible items and exclude user-shell controls. Agents
count recorded starts. [Skill counting](src/hosts/codex/skills.ts) uses marked
instruction injections or successful recognised reads of catalogued
`SKILL.md` files, deduplicated by path and turn. Replay interprets `file://`
paths on the current platform, including UNC paths on Windows. By default
(`includeSubagents: true`), the viewed thread sums attributable descendants
(Main shows the whole saved family; a child view shows its own subtree);
`includeSubagents: false` keeps parent and child counts separate.

### Opt-in tmux row

[The tmux adapter](src/outputs/tmux/client.ts) stores a row per pane and uses
the active pane for content. Ownership includes every pane in the selected
window. On POSIX, the adapter adds a row ahead of the original status rows,
preserves the status position, and switches the height on window and pane
changes. Unowned windows use their original layout. Nonempty rows reserve
two leading spaces in the width budget.

A session lock serializes owner changes and remembers original overrides,
including inherited settings. Cleanup restores settings still owned by
VArgus and preserves later user changes. The last owner releases the added
layout. Dead-owner pruning on subsequent controls recovers abandoned rows.
The adapter refuses to overwrite a full status bar or reset a live owner.

Each successful row update publishes a pane-local deadline five seconds ahead,
rounded up to the next Unix second, and a width-fitted stale row. The status
format compares that deadline with the multiplexer’s clock on redraw. Held
draft readings renew the deadline. A read error for the same identified view
leaves its existing deadline to expire. Empty rows clear it. The bar keeps its
existing redraw interval. The Windows scalar header and appended layout have
separate deadline fields so only the VArgus row can select the stale text.

### Native Windows Codex and psmux

Windows uses CIM process ancestry and psmux `dump-state` for pane and cursor
observations. The built-in bar supports VArgus as a scalar header with
native information below. Existing custom rows, window-local styles and
asynchronous formatters keep their native layout with VArgus appended.

psmux 3.4.0 cannot read back every raw status format. The adapter validates
its own slot before reuse and keeps unknown slots intact. It restores only
owned scalar values and row heights. Native window callbacks and the render
tick reconcile height under the lifecycle lock. This preserves user hooks
and handles window changes that bypass a callback. The platform-independent
[psmux contract tests](tests/codex/native-tmux.test.mts) exercise these
branches through fixtures. [Windows tests](tests/codex/windows.test.mts)
exercise the real adapter when native tools are available.

## OmO Native

[Registration](src/hosts/omo/register.ts) mounts only in the native TUI.
[Output](src/outputs/omo.ts) owns the below-editor widget and replaces the
entire native footer, including extension statuses. Disabling or disposing
the extension restores the built-in footer and stops its timers and
subscriptions. Other native widgets and dialogs still belong to OmO.

[History reducers](src/hosts/omo/collect.ts) fold persisted main-session
assistant entries across branches and compaction history. Tokens sum
uncached input and output. The latest assistant request supplies cache reads
divided by the sum of input, cache reads and cache writes. Removing an observed
edit copy also removes its cache reading. For output decode speed (`t/s`),
[registration](src/hosts/omo/register.ts) observes live `message_start`,
`message_update` and `message_end` events with `performance.now()`, timing from
the first content stream event (`thinking_start`/`thinking_delta`,
`text_start`/`text_delta`, `toolcall_start`/`toolcall_delta`) to the last
(`*_delta`/`*_end`) so pre-TTFT time after `message_start` is excluded. A
2026-11-22 localhost probe on OmO 5.1.61 verified that `message_start` precedes
TTFT on `openai-responses`, that both `anthropic-messages` and
`openai-responses` bracket the decode window accurately through
`message_update`, and that `usage.output` already includes `usage.reasoning`
(matching `totalTokens`). Because persisted JSONL records only
`ThinkingContent` start/end times and not text or tool stream starts, `t/s` is
live-only and starts omitted after `/reload` or `/resume` until the next
streamed reply. Observed assistant edits keep the prior rate; model switches,
compaction and non-edit tree navigation clear it. Tool counts use outer calls, and
agent counts use distinct task IDs from accepted spawns, excluding confirmed
pre-launch refusals (`status: "error"` with a pre-launch `failure_kind` such as
`model_unavailable`, `tools_unavailable`, `depth-exceeded`,
`session-create-failed`, `host_unavailable`, `session_unavailable` or
`isolation_unavailable`, or `model_chain_exhausted` carrying an explicit
model-admission `failure_reason` from `MODEL_START_FAILURE_REASONS` —
`model_not_in_child_profile`, `catalog_probe_timed_out` or
`catalog_probe_failed` — and no `child_session_id`, `run_stats`,
`effective_model`, `host_session`, `pid` or positive `prior_runs_cost_usd`)
while preserving tasks that ran and later failed (bare `status: "error"`,
`child-unresponsive`, mid-turn `model_chain_exhausted` without an admission
`failure_reason`, or an earlier accepted run under a reused task ID).
Main-session skills lack a canonical load receipt (`SKILL.md`
reads and skill catalogs do not establish a skill load); accepted `task` spawn
receipts carrying `skills.resolved` (single `details.skills.resolved` or
per-item `details.items[].skills.resolved`) are attributed to the accepted child
in `subagentSkills` and `spawnReceipts` (keyed by `(task_id, skill_name)` so
replayed receipts or repeated names on the same child cannot increment twice,
separating provisional receipts without launch facts — `status: "pending"`,
`"running"`, `"paused"`, or bare `"error"` without `failure_kind` — by
`run_epoch` from confirmed runs while failing closed on malformed `run_epoch`,
excluding `skills.missing`, `skills.rejected`, confirmed pre-launch refusals
and older receipts without `skills`) and folded only when
`includeSubagents` is enabled.
For a native assistant edit that copies usage,
registration writes a receipt naming the new entry. Older unobserved copies
remain in the total, and equal usage amounts alone do not identify copies.

With `includeSubagents: false`, or when both `tokens` and `callCounts`
are `false`, OmO performs no task-store disk I/O and keeps tokens, tools and
agents on the main session. With `includeSubagents: true` (default) and `tokens` or
`callCounts` enabled, [subagents.ts](src/hosts/omo/subagents.ts) asynchronously
reads OmO's on-disk `senpi-task` store (`tasks/*.json` for session-tree links and
`children/<taskId>/sessions/<taskId>/*.jsonl` across live and revived runs).
Store resolution mirrors OmO's config and state-directory rules: it reads user
(`$HOME/.omo`) and farthest-to-nearest non-symlinked project `.omo`
`omo.jsonc`/`omo.json` layers up to the home and account-home boundaries (with a
self-contained comment and trailing-comma JSONC parser, per-layer `[senpi]` to
`[native]` canonicalization, and `profiles` overlays from `OMO_PROFILE`,
`OCX_PROFILE` or `OPENCODE_CONFIG_DIR`) for an explicit `task.state_dir`;
otherwise it adopts a populated legacy `<cwd>/.omo/senpi-task` read-only without
writing `.in-project`, or falls back to
`<agentDir>/projects/<projectStateKey(cwd)>/senpi-task` (`OMO_CODING_AGENT_DIR`,
`SENPI_CODING_AGENT_DIR` or `PI_CODING_AGENT_DIR`, else `~/.omo/agent`).
Task records are cached by `(ino, mtimeMs, size)`, skipping `*.json.expunging`
tombstones and invalid `task_id` values; fixed-point session-tree closure admits
direct children, nested descendants, DAG nodes, team members and workpool tasks
matching `parent_session_id` or `root_session_id`, excluding confirmed
pre-launch refused task records from `taskIds` unless recorded child work
exists (matching the same narrow predicate used for spawn receipts) and
carrying each confirmed refusal's `[run_start_epoch, notification.run_epoch]`
fence in `SubagentSnapshot.refusedTasks` so provisional spawn receipts without
launch facts (queued `pending`, slow-admission `running`, held `paused`, or
bare foreground-batch `error` without `failure_kind`, in parent history or
nested child JSONLs) for the same task and
run are reconciled away along with their provisional skills while retaining
previously launched runs under a reused task ID. The collector remembers observed
refusal ranges in memory for the current mounted widget, session, working
directory and task store (clearing them on `/reload`, `/resume`, or `/vargus`
remounts). When OmO expires a record, its provisional receipts stay excluded. A
new record for the same task ID can revise the counts for its own run.
Child JSONLs are read
incrementally with raw-`Buffer` line carry so multi-byte UTF-8 and partial lines
are never split, resetting from offset 0 on inode change or shrink and pruning
removed/expunged caches. Polling uses a 1-second floor when any matched task is
non-terminal (`pending`, `running` or `paused`) or forced (`message_end`,
`tool_execution_end`), a 5-second idle floor when all matched children are
terminal, and a 10x slow-scan holdoff. At render time, registration reconciles
main provisional spawn receipts against `refusedTasks`, folds
subagent tokens, tools and explicitly resolved child task skills (set union of
`(task_id, skill_name)` pairs across reconciled main-session and child-JSONL
spawn receipts) and computes agent count as the set union of reconciled main
`task_id`s and subagent `task_id`s without mutating main counts,
`history.agents`, `history.subagentSkills` or `history.spawnReceipts`. Cache-hit percentage, output speed (`t/s`), context,
model, effort, session age, quotas and VCS stay on the main session. Other
skill-loading paths outside `skills.resolved` on accepted spawn receipts remain
uncounted, expunged tasks' tokens, tools and nested child-JSONL skill receipts
drop once removed from disk (while accepted spawn `task_id`s and resolved task
skills already recorded in surviving transcripts remain counted), and background
memory sidecars outside `senpi-task` are excluded.

Model, effective effort, default effort and context come from the current
OmO context. Known [model aliases](src/hosts/omo/display.ts) preserve
significant family and speed distinctions. Subscription readings follow the
selected provider. Account windows remain separate and omit account names,
as the account list does not establish which account served a request.

Kimi Coding uses a [separate collector](src/hosts/omo/kimi.ts) with credentials
and region resolved by OmO. It restricts requests to its regional HTTPS
endpoint, rejects gateway overrides and redirects, and cancels the request
and clears readings on provider switch or dispose. Its cache and backoff
belong to the mounted extension instance.

[The loader](src/cli/omo.ts) can store an absolute JSON options path. The
extension resolves saved session overrides over file values and defaults.
It persists enabled state and explicit overrides, so changes to other file
keys still apply after reload. Legacy full snapshots retain their saved
values.

The OmO widget compares its last successful collection time on each draw. A
failed collection retains the readings and requests a redraw, including on the
one-second timer. A blocked UI needs a later host redraw to show the marker.

## Antigravity CLI native statusLine

The [command](src/cli/antigravity.ts) runs once per host refresh. It reads
stdin JSON and emits one ANSI line with two leading spaces, included in the
width budget. Empty or invalid input can exit successfully with no row.
Successful rendered fragment parts (cache version 2, with legacy string fallback) for identified conversations are cached alongside the transcript
and VCS caches so stale trimming on collection failure preserves whole fragments under `NO_COLOR`. A collection exception can reuse that conversation’s row for
the same workspace, profile, options and colour mode. With no further invocation
there is no observer to draw a warning. Lazy dispatch keeps this path
independent of the Codex and tmux modules.
The `agy` 1.5.8 Linux probe on 2026-11-14 observed roughly 300 ms streaming
refreshes, which is why transcript and VCS state are cached across invocations.

[Payload collection](src/hosts/antigravity/collect.ts) uses host context,
model, terminal width and quota. The model label can supply effort before the
explicit field arrives. Gemini and Orchestrator models use the Gemini quota
group. Claude and GPT models use the third-party group. An unknown model uses
a suffix fallback only if the matching bucket is unique. Switching groups changes
the displayed five-hour and weekly windows.

[Transcript lookup](src/hosts/antigravity/transcript.ts) scopes supplied paths
to a normalized `brain/<id>` segment and has a CLI-directory fallback for
paths reported under the IDE directory. Replay tracks a byte offset (cache
version 5) together with a normalized workspace/skill-context fingerprint
(`skillContextKey`), upgrading older v3/v4 caches on read and replaying when
evaluated under a different workspace so a child transcript cached under one
workspace cannot poison another while preserving `epoch` when underlying bytes
have not changed. It restarts from byte 0 with a new `epoch` when the file
shrinks or the first-line or trailing digest changes, dropping any rewound
subagent links alongside counts.
Session age, uncached tokens and call counts come from the active log.
Context's input tokens measure the live window. Skill counts require known
skill roots and deduplicate within a turn.

[transcript.ts](src/hosts/antigravity/transcript.ts) tracks `invoke_subagent`
spawn batches and records validated `{ id, workspaceDirs? }` entries in cache
v5 on root reads so toggling `includeSubagents` takes effect immediately on a
cache hit: it inspects subsequent `GENERIC` tool results only after stripping
leading `Created At:` / `Completed At:` wrapper lines, requiring an anchored
`Created the following subagent:\n{` header (verified against `agy` 1.5.14 on
2026-11-23, with isolated-worktree `workspaceUris` receipts checked on `agy`
1.5.15 on 2026-11-23), and scanning
the leading balanced JSON object so trailing prose and parallel standard tool
outputs (such as `read_file` and `run_command`, which emit their own headers)
do not produce false positives. Local `file://` `workspaceUris` entries are
converted via `fileURLToPath` (capped at 16 unique local directories; non-file
or malformed URIs are ignored without dropping `conversationId`).
With `includeSubagents: false`, or when both `tokens` and `callCounts`
are `false`, Antigravity performs no child transcript I/O. With
`includeSubagents: true` (default) and `tokens` or `callCounts` enabled,
[subagents.ts](src/hosts/antigravity/subagents.ts) extracts the normalized
`brain` directory directly containing the parent's
`<id>/.system_generated/logs/transcript.jsonl`, resolves declared skill roots
lazily at most once per unique workspace context (sharing the parent promise for
same-workspace children and skipping manifest reads on cache hits), carries each
child's verified `workspaceDirs` (or inherits its spawning parent's workspace
when `workspaceUris` is absent) into child skill resolution and cache reuse, and
performs cycle-safe breadth-first traversal over sibling
`<brainDir>/<childId>/.system_generated/logs/transcript.jsonl` files verified
through `resolveContainedTranscriptCandidate` (never following raw `file://`
log URIs from tool text), isolating per-child read/cache errors so a damaged
child cache cannot trigger `| ⌛stale` on the parent row. Traversal is capped at
depth 8, 64 child transcripts, and a 400 ms budget to stay within `agy`'s
refresh and command-timeout limits. Tokens, tools, agents and skills fold
recursively across `invoke_subagent` trees; context, cache hit %, output speed
(`t/s`), session age, model, effort, quotas and VCS/mutating-tool triggers stay
strictly on the root conversation. `swarm` and `run_workflow` child transcripts
are excluded (their transcript link formats are not yet verified).

The status-line payload supplies the cache reading in `context_window.current_usage`.
A saved Linux 1.5.8 payload reported 2,669 uncached input tokens, 8,113 cache
reads and zero cache writes for the request. Its enclosing `total_input_tokens`
was 15,295, so that field would give a different denominator. Output decode
speed (`t/s`) is inferred live in [rate.ts](src/hosts/antigravity/rate.ts) from
`statusLine` refresh timing and `transcript.jsonl`: two 2026-11-22 live Linux
`agy` 1.5.14 PTY probes (with `--settings` and `--log-file`) confirmed zero
timing/duration keys in the payload (`cost` was `null`), `agent_state` staying
`"working"` through both fast and 5 s tool runs, `transcript.jsonl` flushing
`PLANNER_RESPONSE` immediately on model completion before tools execute (with
only 1-second `created_at` and no duration field), and `statusLine` staying
silent through 3.5–8.6 s of pre-TTFT wait before firing 23–24 ms after the first
`streamGenerateContent` SSE chunk. While `agent_state` is `"working"` and
transcript step counts show a model call in flight (not pending tool results),
[rate.ts](src/hosts/antigravity/rate.ts) hashes payload fields excluding
`quota.*.reset_in_seconds` countdowns, skips state/transcript transitions and
any trailing 300 ms throttle refresh within 450 ms, latches the first remaining
no-op refresh as stream start using the estimated invocation time
(`Date.now() - Math.round(process.uptime() * 1000)` to remove ~160 ms of Node
startup latency), and pairs `PLANNER_RESPONSE.output_tokens` with
`transcript.jsonl`'s `mtimeMs` (requiring `lastPlanner.stepCount === prev.stepCount + 1`
so an intervening prompt or aborted turn cannot reuse an earlier stream start,
and failing closed on trailing steps unless every trailing step is a tool result
with a valid `created_at` within 2 s of `mtimeMs`). A durable transcript replay
`epoch` in the transcript cache invalidates the rate cache across mid-transcript
`/rewind` rewrites even when `tokens` is temporarily disabled. Across the five probed
steps this matched `--log-file` ground truth within 24 ms (`123t/s` vs `123t/s`,
`117t/s` vs `116t/s`) and filtered three single-chunk bursts (`0`–`39 ms`) under
the 500 ms floor; a live two-turn check running `./bin/vargus statusline` inside
`agy` 1.5.14 rendered `token:17.7k(0%, 106t/s)` on a 2,244-token first-turn
reply (where the new conversation's one-time background title request triggered
an earlier no-op refresh ~4 s before the main stream's `132t/s` decode) and
preserved `106t/s` across a 22-token follow-up burst (`token:20.1k(87%, 106t/s)`).
Typing in the composer during pre-TTFT wait also triggers a no-op refresh (~25 ms
later), pulling that step toward end-to-end speed; very fast TTFT (<450 ms) after
a transition can skip one ~300 ms tick; and a future `agy` build that adds a
periodic pre-TTFT status timer would degrade toward end-to-end speed. Like OmO
Native, `t/s` is live-only (omitted on a cold-start resume until the next
streamed reply); bursts and aborted/errored turns preserve the previous rate,
while model switches (ignoring effort changes), compaction (`CHECKPOINT`),
`/rewind` and zero-output steps clear it.
[Google status-line payload](https://antigravity.google/docs/cli/statusline)

[VCS cache](src/hosts/antigravity/vcs.ts) is scoped to the working directory.
Mutating tools can trigger a refresh after the slow-walk hold. Git and any SVN
fallback share a four-second timeout budget to leave room inside the host's
status command budget.

Setup in the agent sandbox hands the final change to the user. The Linux
`agy` 1.5.8 probe was denied a read of the protected settings file. The host's
own `/statusline` command applied the row in the running TUI. See
[live evidence](#live-evidence-and-limits) for platform coverage.

## Claude Code

### Scope

VArgus uses Claude Code's terminal `statusLine` row. The interactive mod
observes engine events and maintains a line file per session. A shell command
reads the file. The [setup guide](docs/setup-claude.md) covers scope, settings
precedence, Windows Git Bash, and platform-specific paths.

The line reports what the mod collects from engine events and supported usage
sources. Teammates in their own panes, PR state, lines changed and prompt-cache
lifetime are outside that collection.

### The host

The [marketplace](.claude-plugin/marketplace.json) points to this repository.
The [manifest](.claude-plugin/plugin.json) names the
[hook descriptor](src/hosts/claude/hooks.json) and the
[state contract](src/hosts/claude/state.d.ts). The descriptor loads
[register.ts](src/hosts/claude/register.ts) directly. Hooks observe events and
pass on the original input with `next(e)`. `turn.step` is a streaming hook.
Keep shared event wiring in that entry point.

The bundled Claude Code 2.1.323 declarations mark the API “EARLY ACCESS.”
They describe `$.state` as data that “survives a hot reload of the plugin's
code” and `$.process.run` as taking an “argument vector (no shell).”
On reload, module state is recreated and the mod restores its counts from
`$.state`. `$.store` keeps the usage cache across sessions. Check the
installed build's `plugin-authoring` types when changing hooks or their
state shapes. [Mod reference](https://code.claude.com/docs/en/plugins/mods/reference)

### Data sources

- [Session collector](src/hosts/claude/collect/session.ts) sums uncached
  input plus output from `turn.step` usage and counts `tool.call` starts (with
  `Agent` and `Skill` also incrementing their own totals), storing main-loop
  (`e.agentId` absent) and in-process subagent (`e.agentId` present) counts
  separately in memory and in `$.state` (top-level main fields plus optional
  nested `subagents` inside `counts`, omitted when all four subagent counts are
  zero). With `includeSubagents: true` (default),
  [register.ts](src/hosts/claude/register.ts) adds the recorded subagent counts
  at render time; with `includeSubagents: false`, the row displays main-loop
  counts only, so toggling the option reflects prior session activity
  immediately without mutating main counts.
  The cache reading follows completed main-loop requests. Claude Code 2.1.323's
  `ModelUsage` describes `input_tokens` as “the part of the
  prompt neither read from nor written to the prompt cache.” The denominator
  therefore includes uncached input, cache reads and cache creation. In
  `ModelUsage`, “a count the response left out reads as zero.”
  For output decode speed (`t/s`), [register.ts](src/hosts/claude/register.ts)
  iterates main-loop `turn.step` chunks transparently, stamping `$.clock.now()`
  once on the first output chunk (`thinking`, `text`, `tool`, `input`) and once
  on `stop` (or completion), subtracting merged `serverToolUses` execution
  intervals (`startedAt`–`endedAt`) and requiring at least two output chunks
  over 500 ms. Opaque `engine` chunks do not distinguish a mid-step retry
  marker, which is an accepted API limit. Subagent steps keep direct
  `yield* next(e)` and do not replace the main rate or cache reading. The
  latest rate persists in `$.state` across hot reloads and clears on model
  switch, compaction, `/clear`, resume and usage-less responses.
  Claude Code 2.1.323 describes `AgentLoop.agentId` as “absent on the main loop.”
- `session.measure` supplies live context and engine limits. The collector
  reads `$.session.usage()` after main-loop steps for context. Main-thread
  compaction clears the old context until the next step. Clear and in-session
  resume reset counts and session readings, and a generation check discards
  earlier asynchronous session-read results.
- Displayed model and working directory are read from the session.
  Effective effort and its model-specific baseline come from the main step.
  The 2.1.323 `TurnStepInput.model` declaration describes the model “as the
  engine resolved it for this step,” which can differ from the display model.
- [Claude quota assembly](src/hosts/claude/quota.ts) combines engine windows
  with direct provider results. The engine's five-hour and seven-day
  windows take precedence; gateway `spend_limit` windows are omitted. Claude
  Code 2.1.323 describes `SessionRateLimit.kind` as “`five_hour`, `seven_day`,
  or a Claude gateway's `spend_limit`.” Direct Kimi usage supplies five-hour
  and monthly (`1mo`) windows. Shared formatting consumes those readings while
  the persisted cache keeps its host-specific shape.

### Usage cache and staleness

[The usage collector](src/hosts/claude/collect/limits.ts) polls only matched
direct third-party usage providers; Anthropic OAuth usage is not polled and
`$.session.authorize()` is not called. Engine `five_hour` and `seven_day`
windows are separate.

[Direct Kimi usage](src/hosts/claude/collect/usage-providers.ts) requires a
matching normalized coding base URL and keys its cache in `$.store` by provider
and Claude config directory. It uses the existing environment credential for
the fixed HTTPS destination, independently of
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`; the credential stays out of the
cache. The collector checks the store every 15 seconds and refreshes after 90
seconds on success. Failures back off and honour bounded numeric `Retry-After`
on 429. Recent cached windows stay displayed without a stale mark on failure,
then switch to an error badge (`[API 429]`, `[API AUTH]`, or `[API ERR]`) after
15 minutes without a successful reading.

### When the line is written

Interactive sessions start the writer, enabled collectors and a one-second
render timer. The first render starts without blocking prompt startup.
A `PromptHint` hook observes the viewport width. Identical text for the
same session ID skips rewriting the line. A completed refresh renews a
companion `line.live` file on text or width changes and every two seconds
during healthy idle ticks.
It holds the deadline and width-fitted stale text on separate terminated lines.

### The line file

[The writer](src/hosts/claude/write.ts) publishes
`<config>/plugins/data/vargus-vargus/<session-id>/line`. The config path is
resolved by [paths.ts](src/hosts/claude/paths.ts), with Windows drive paths
normalized. The writer re-reads the ID for each write because clear and resume
can replace it within a running process.

Each loaded copy serializes and coalesces writes. It writes a sibling
temporary file and moves it into place so readers get a whole line. A refused
move or unsafe Windows path falls back to an in-place write, which can be
read partway through. On Windows the mod uses `cmd /d /c` with guarded paths
because Git Bash's utilities may be missing from the engine's PATH.

Session end waits for in-flight writes and removes its safe session folder.
Interactive startup prunes old folders after 14 idle days, preserving the
current ID and skipping symlinks. Two processes using the same session ID
share the file and can overwrite or remove each other's row.

### The reader

The reader prints the per-session file with `cat` until the deadline expires,
then prints the complete stale row from `line.live`. An absent or incomplete
check-in falls back to the ordinary line. The
`CLAUDE_CODE_SESSION_ID` supplied to the reader matches the writer's ID in
the Claude Code 2.1.300 probe. Reinstalling upgrades the earlier plain and
age-check VArgus readers. The
[setup guide](docs/setup-claude.md#set-up-the-status-line) owns the commands.
[Reader tests](tests/claude/reader.test.sh) cover a present, missing and stale
file and an empty session ID.

### Setup

[The Claude installer](src/cli/claude-setup.ts) delegates user-scope plugin
registration to Claude Code, reads the settings back, and configures the
matching reader. It reuses the registered VArgus marketplace. In the
2.1.323 installer probe, setting `NPM_CONFIG_OMIT=dev` for the Claude
subprocess let the plugin cache from a checkout with its development-only
lockfile and an empty npm cache. The [Claude guide](docs/setup-claude.md)
covers manual scopes and preserving the reader that preceded VArgus.

## Rules carried over from VantageHUD

VantageHUD 0.6.0 is the read-only reference for these rules.

| Rule | Why it matters in VArgus |
|---|---|
| Preserve fragment order, label text and terminal-column fitting. | A narrow row keeps the higher-priority fragments and handles wide characters. See [Fragments](#fragments) and [Languages](#languages). |
| Use a palette registry with safe lookup and flat status tiers. | Unexpected names fall back to a known palette; VArgus uses two flat tiers (`calm` and `alert`). See [Colours](#colours). |
| Omit expired quota readings and keep Claude's usage cache separate by provider and config directory. | After an account switch in the same directory, the previous account's cached reading can still appear. See [Usage cache and staleness](#usage-cache-and-staleness). |
| Pace repository status, resolve the actual worktree and count SVN item and property changes. | Reading status stays bounded and the branch reflects the session's repository. See [Repository readings](#repository-readings). |

The [shared renderer tests](tests/shared/render.test.mts) and
[Claude collector tests](tests/claude/) exercise the carried-over rules.
Preserve each rule and its coverage when extending VArgus. Keep the
implementations independent.

## Unsettled

Whether Claude's `$.state` survives a lost worker as it does on a hot reload.
Verify with a disposable mod before relying on it.

## Tests

Use the [maintenance guide](docs/maintenance.md#development-checks) for
commands and [process cleanup](docs/maintenance.md#test-process-cleanup).

- `npm run test:local` type-checks the Node graph and exercises shared rendering,
  import boundaries, installers and local fixtures. The Codex replay fixtures
  check which counters belong to each thread, attribution gating (`attributable`),
  replaced-file and corrupt/malformed JSONL error latching, malformed skill URLs
  without loss of attribution, Windows UNC reads, unchanged-size
  buffered draining, `Views.descendants` subtree closure, `.jsonl.zst`
  compressed rollout discovery/replay/stat-caching/transition handling and
  multi-level descendant folding. Display fixtures cover legacy
  counter settings, the shared `callCounts` switch, folded paths on a working
  directory change, folded descendant counts and counts held while typing.
  The collector fixture distinguishes per-request cache reads from cumulative
  usage, an explicit miss and a context-only estimate.
  A separate Codex row test checks
  out a tag in a real linked worktree and renders it with defaults and with
  the former `detachedHead: false` setting. A POSIX Antigravity fixture awaits
  the Git reading and fits a stale row from a worktree whose name contains the
  literal fragment separator.
  A controlled Git test holds each sibling probe open after `status` fails,
  independently of the native Windows directory-removal check. The suite also checks the psmux
  command contract, and [wsl.test.mts](tests/shared/wsl.test.mts) covers
  `detectWsl` and the Node entry points (`vargus themes`, Antigravity, OmO) for
  native Windows with `WSLENV` set and for real WSL signals.
- `npm test` adds native Codex and multiplexer integration tests through the
  [platform-aware runner](tests/run-node.mjs). Codex tests with a localhost
  provider exercise the stock engine, saved events and TUI. The supplied
  responses test handling of provider data and tool calls. On Linux with Codex
  0.171.0, the Fast-mode fixture supplied 285 cached tokens in a 1,000-token
  prompt, verified a 700 ms streamed reply rendered `(28.5%, <rate>t/s)` on both
  live polling and fresh rollout replay, preserved both suffixes across a
  subsequent 0 ms fast burst, and cleared both suffixes when a response omitted
  usage. The standalone
  fixture observed `token:3.2k(94.3%)` in the tmux row. On Linux it also checked
  ordinary, multiline and shell drafts with an unmarked row, a `/btw` prompt
  and draft with the stale badge, and a draft entered after a transcript read failure.
  The native skill
  test checks a child thread's token, tool, agent and skill totals. The native
  `views-engine` `includeSubagents` fixture (Linux, Codex 0.171.0, tmux 3.5a)
  exercised a parent spawning both a paginated forked child (`fork_turns: "all"`)
  and a mid child spawning a tool/skill-running grandchild, verifying subtree
  folding under default `includeSubagents: true` on Main (`token:28.8k(94.3%)`,
  `🔧1 🤖3 ⚡1`), `/root/mid` (`token:14.4k(0%)`, `🔧1 🤖1 ⚡1`), and `/root/forked`
  (`token:10.2k(0%)`), plus reload to `includeSubagents: false` (`token:4.2k(94.3%)`
  / `🤖2` on Main and `token:8.2k(0%)` / `🤖1` on `/root/mid`), and a separate stdio
  `rollout/compress` fixture (Linux, Codex 0.171.0) verified that a 15-day-old
  child compressed to `.jsonl.zst` preserves the 9,000-token total across both
  live reader transition and fresh discovery while keeping folding-off at 2,000
  without decompressing compressed children. A later run in the `includeSubagents`
  fixture (Linux, Codex 0.172.0, tmux 3.5a) also reloaded the Codex worker under
  `WSLENV` vs `WSL_DISTRO_NAME` to check icons/text counts and stale markers in
  tmux. Model choice,
  billing and different provider timing need their own evidence.
- `npm run test:claude` type-checks against generated types. The
  [runner](tests/run-claude.mjs) stages the plugin manifests, sources, README,
  launchers, Claude engine fixtures and reader guide in a temporary directory.
  This keeps the checkout's `tmp/` out of engine discovery; Node-only `.test.mts`
  files stay in the Node suite. On Windows with Claude
  Code 2.1.332, normal validation listed both launchers and still warned about
  `.ts` import extensions; passing the separate type-check is not strict validation.
  Pointing Claude Code 2.1.332 at `tests/claude` directly reports “no hooks module to load,”
  so the stage keeps the plugin manifest. The engine fixtures mock filesystem
  hooks; the shell checks exercise the documented reader and manifest separately.
  Each staged command runs with a 120 s timeout (`claude` via `ComSpec` and the
  shell checks via Git for Windows on Windows; directly on POSIX), stops its
  child tree on timeout or `SIGINT`/`SIGTERM` (`taskkill.exe /PID <pid> /T /F`
  on Windows, `process.kill(-pid, 'SIGKILL')` on POSIX), and removes the staged
  directory in `finally` (reporting the path and exiting non-zero if removal
  fails).

### Live evidence and limits

On Linux, an attached tmux client with `status-interval 1` displayed
`⚠ stale` after the writer stopped checking in. The probe supplied no keys
or redraw commands while waiting. Publishing the identical reading again
cleared the marker in the expanded status format. The reported Windows
psmux 3.4.0 test observed automatic expiry and recovery in the appended row;
with `status-interval 0`, expiry became visible on manual redraw. A 2026-11-26
detached Windows smoke test with psmux 3.4.0 covered the scalar header:
`dump-state` showed the stale row after setting an expired deadline, and
detach restored the original bar height and `status-left`. That smoke test
did not start Codex.

Separately, on 2026-11-26 the [native Windows fixture](tests/codex/windows.test.mts)
ran Codex 0.172.0 with a localhost provider and its executable first on `PATH`.
Hook activation, row rendering, reload and restoration passed under an isolated
profile. This was a targeted TUI check, not a full psmux suite pass.

On Linux on 2026-11-20, a checkout installed with `vargus install claude`
ran in Claude Code 2.1.323 with a saved native `model: true` and a shared
`model: false`. Both the Claude line and the Antigravity status-line command
omitted the model initially, showed it after `/config vargus.model=true`,
and omitted it after `/config vargus.model=false`. The probe used the native
Claude TUI and supplied Antigravity's stdin payload. The checkout-file case
in the Linux Codex standalone suite used the stock TUI, removed a checkout
setting, and observed the built-in value on reload.
The native Claude panel and open-session reload were also exercised with
conflicting native and checkout values, including a case in which Claude
reported a successful plugin reload while keeping the current module.
The OmO Native 5.1.61 TUI with Senpi 2026.11.3-3 and the older
Senpi 2026.10.25-2 TUI loaded checkout settings, applied an OmO session
override, and reread a hand edit on `/reload`. The older loader supplied
`import.meta.url` and failed checkout path resolution using `import.meta.dirname`.

| Surface | Recorded evidence | Coverage boundary |
|---|---|---|
| Claude | Linux installer and rendered row with a mock reply on 2.1.323, 2026-11-18. Windows reader and writer checks on Windows 11 with Claude Code 2.1.300 and Git 2.56.0, 2026-10-17. | Engine fixtures cover later logic separately from those host probes. |
| Codex on tmux | Linux 0.167.0 engine and TUI probes with a localhost mock covered hook trust, footer restore and recorded usage. Linux 0.169.1 with tmux 3.5a covered side chats, aligned footer labels and abandoned row recovery on 2026-11-18. | Host layout and transcript formats are version-sensitive. No billed turns or macOS TUI checks in these probes. |
| Codex on psmux | Native Windows Codex 0.167.0 with psmux 3.4.0 and Node 24.21.0 checked row and footer lifecycle with `--no-daemon` on 2026-11-10. Follow-up attached-client checks exercised window switching and a new window on 2026-11-13. | Shared-daemon mode and native draft and sibling navigation need their own live evidence. |
| OmO | OmO 5.1.61 on Linux on 2026-11-14 covered widget lifecycle, model and quota selection, and assistant-edit accounting. A localhost provider supplied usage for the counting probe. | File-option reload was checked with the Senpi 2026.10.25-2 TUI. Live history compaction and account failover remain fixture or source-level coverage. |
| Antigravity | Linux `agy` 1.5.8 on 2026-11-14 checked native rendering and transcript and quota readings. macOS `agy` 1.5.9 on 2026-11-16 checked the sandbox's setup and launcher access. Linux `agy` 1.5.14 on 2026-11-22 probed `statusLine` refresh cadence and ran `./bin/vargus statusline` live for two turns to verify `t/s` rendering and burst preservation. | Live macOS rendering and Windows TUI rendering need their own checks. |

Keep evidence with its host build, platform and scope when revising these
contracts.
