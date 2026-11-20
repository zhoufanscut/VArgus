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
- `src/node` holds reusable Node I/O such as the Git reader. It depends on
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

Hosts produce ordered [quota readings](src/core/limits.ts), including labels
and error badges. The [limits fragment](src/render/fragments/limits.ts) rounds
and colours percentages, formats amounts and reset times, skips expired
windows, and keeps windows without a known reset. Host-marked spend windows
can exceed 100%. Each host decides which readings are current, stale or absent.

### Config

[Shared defaults](src/options.ts) and the Claude manifest agree on picker keys
and defaults. Both follow the shared key order in [the sample](vargus.sample.jsonc).
The spend and stopped-line options default off.
The shared `callCounts` setting controls the tool, agent and skill counts together.
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
values as “defaults filled in.” Its `config.set` declaration says
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

The displayed context percentage is rounded. Colour changes at 70% and 85%,
with `COMPRESS?` from 80% through 84% and `CRITICAL` from 85%. WSL uses text
call-count marks. Hosts choose the context supplied to the renderer, including
whether an unknown reading is omitted or starts at `ctx:0%`.

### Colours

[Themes](src/theme/index.ts) use 24-bit SGR styles and default to `graphite`.
The palette registry uses own-property lookup and falls back for unknown
names. When a host enables `NO_COLOR`, the theme returns plain text. External
text passes through [control-character sanitization](src/render/text.ts) before
styling. The tmux output translates the renderer's styles without recursively
expanding content from paths or branches.

Effort uses Calm at or above the model's default and Alert below it. An absent
default uses `high`. An exact match to the baseline is Calm even for an
unfamiliar named level. Unranked or numeric values that cannot be compared use
Alert. The host supplies the baseline separately from the model's display name.
[Model fragment and comparison](src/render/fragments/model.ts)

### Languages

[English labels](src/i18n/en.ts) define the keys used by fragments. Register a
complete label table in [src/i18n/index.ts](src/i18n/index.ts) to add a language.
The null-prototype registry and own-property lookup fall back to English for
unknown names. The [labels test](tests/shared/labels.test.mts) checks for
display text written directly into fragments.

### Repository readings

[Node Git I/O](src/node/git.ts) is shared by Codex, OmO and Antigravity. Claude
uses its own [Git and SVN collector](src/hosts/claude/collect/vcs.ts) through the
mod API. Both Git readers use porcelain status with `GIT_OPTIONAL_LOCKS=0` and
`core.fsmonitor=false` to avoid rewriting the user's index or invoking its
filesystem monitor. When porcelain reports `# branch.head (detached)`, the
branch fragment uses the actual worktree's metadata to name the checkout and
show any in-progress operation. The `branch` switch controls this fragment
for both attached and detached checkouts. Older `detachedHead` settings are
ignored. The folder fragment keeps the session's working directory.

Hosts gate polling on the repository, branch and status switches. They poll
on a five-second baseline and hold off a slow walk by ten times its duration.
Claude, OmO and Antigravity can request earlier work after relevant tools
subject to that hold. A directory or worktree change invalidates old readings.
Claude falls back to local SVN XML in a working copy outside Git, counting
property as well as item status. The SVN branch label shows the name from
the repository URL, for example `branch:trunk`.

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
private token in its command line. Attachment ends through `off` or when the
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
the last confirmed snapshot. The snapshot freezes readings and time while
fitting to the current width. The current view remains unknown and
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
paginated reader with a valid boundary stops if a later ordinal is invalid.
Unsupported mixed histories can yield an identity error and lose attributed
agent and skill counts. The row only replays data the engine saved.

[The collector](src/hosts/codex/collect.ts) takes cumulative uncached input
plus output from token counts. The context gauge uses the last context
reading with Codex's baseline allowance, and compaction clears that reading.
Quota selection prefers the active model's exact recorded slug, then the
general Codex bucket. Labels follow the recorded window duration.

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
`SKILL.md` files, deduplicated by path and turn. Parent and child counts stay
separate.

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
uncached input and output. Tool counts use outer calls, and agent counts use
distinct task IDs from accepted spawns. Skills lack a canonical load receipt.
For a native assistant edit that copies usage,
registration writes a receipt naming the new entry. Older unobserved copies
remain in the total, and equal usage amounts alone do not identify copies.

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

## Antigravity CLI native statusLine

The [command](src/cli/antigravity.ts) runs once per host refresh. It reads
stdin JSON and emits one ANSI line with two leading spaces, included in the
width budget. Empty or invalid input can exit successfully with no row.
Lazy dispatch keeps this path independent of the Codex and tmux modules.
The `agy` 1.5.8 Linux probe on 2026-11-14 observed roughly 300 ms streaming
refreshes, which is why transcript and Git state are cached across invocations.

[Payload collection](src/hosts/antigravity/collect.ts) uses host context,
model, terminal width and quota. The model label can supply effort before the
explicit field arrives. Gemini and Orchestrator models use the Gemini quota
group. Claude and GPT models use the third-party group. An unknown model uses
a suffix fallback only if the matching bucket is unique. Switching groups changes
the displayed five-hour and weekly windows.

[Transcript lookup](src/hosts/antigravity/transcript.ts) scopes supplied paths
to a normalized `brain/<id>` segment and has a CLI-directory fallback for
paths reported under the IDE directory. Replay tracks a byte offset. It
restarts when the file shrinks or the first-line or trailing digest changes.
Session age, uncached tokens and call counts come from the active log.
Context's input tokens measure the live window. Skill counts require known
skill roots and deduplicate within a turn.

[Git cache](src/hosts/antigravity/vcs.ts) is scoped to the working directory.
Mutating tools can trigger a refresh after the slow-walk hold. Each Git subprocess
has a four-second timeout to leave room inside the host's status command budget.

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
sources. Teammates in their own panes and payload-only fields such as PR state,
lines changed and prompt-cache lifetime are outside that collection.

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
  input plus output from `turn.step` usage, including observed subagents.
  Each main-loop `tool.call` increments the tool total. Calls to `Agent` and
  `Skill` also increment their own totals. Claude Code 2.1.323 describes
  `AgentLoop.agentId` as “absent on the main loop.”
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
  with provider-specific results. The engine's five-hour and seven-day
  windows take precedence. Claude Code 2.1.323 describes `SessionRateLimit.kind`
  as “`five_hour`, `seven_day`, or a Claude gateway's `spend_limit`.” OAuth supplies extra
  usage. Kimi can supply five-hour and monthly windows. Shared formatting consumes
  those readings while the persisted cache keeps its host-specific shape.

### Usage cache and staleness

[The usage collector](src/hosts/claude/collect/limits.ts) keys its cache by
provider and Claude config directory. It checks the store every 15 seconds
and refreshes after 90 seconds on success. Failures back off and honour
bounded numeric `Retry-After` on 429. Recent cached windows are marked
stale on failure, then replaced by an error badge after 15 minutes without
a successful reading. Engine windows are separate.

Anthropic usage borrows a bearer handle from `$.session.authorize()`.
It skips non-Anthropic provider setups and
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. Refresh tokens stay with the
host. [Direct Kimi usage](src/hosts/claude/collect/usage-providers.ts) requires a
matching normalized coding base URL. It uses the existing environment
credential for the fixed HTTPS destination, independently of the Anthropic
traffic flag. The credential stays out of the cache.

### When the line is written

Interactive sessions start the writer, enabled collectors and a one-second
render timer. The first render starts without blocking prompt startup.
A `PromptHint` hook observes the viewport width. Identical text for the
same session ID skips a write, except for the optional stopped-line heartbeat.

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

The normal reader prints the per-session file with `cat`. The
`CLAUDE_CODE_SESSION_ID` supplied to the reader matches the writer's ID in
the Claude Code 2.1.300 probe. The writer records its effective `blankStopped`
in the session's `line.blank` when the session or setting changes. A nonempty
marker pairs a 30-second heartbeat with the reader's mtime check. An empty
marker keeps an unchanged row visible even when a checkout and managed setting
disagree. For a session from an older writer with no marker, the installer
retains the age-check behavior selected by the user's native setting. The
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
| Use a palette registry with safe lookup and shared percentage tiers. | Unexpected names fall back to a known palette. See [Colours](#colours). |
| Omit expired quota readings and keep Claude's usage cache separate by provider and config directory. | After an account switch in the same directory, the previous account's cached reading can still appear. See [Usage cache and staleness](#usage-cache-and-staleness). |
| Use the host's OAuth handle without refreshing its credential. | The usage read leaves the login lifecycle with the host. See [Claude data sources](#data-sources). |
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
  check which counters belong to each thread. Display fixtures cover legacy
  counter settings, the shared `callCounts` switch and counts held while typing.
  A separate Codex row test checks
  out a tag in a real linked worktree and renders it with defaults and with
  the former `detachedHead: false` setting. The suite also checks the psmux
  command contract.
- `npm test` adds native Codex and multiplexer integration tests through the
  [platform-aware runner](tests/run-node.mjs). Codex tests with a localhost
  provider exercise the stock engine, saved events and TUI. The supplied
  responses test handling of provider data and tool calls. The native skill
  test checks a child thread's token, tool, agent and skill totals. Model choice,
  billing and different provider timing need their own evidence.
- `npm run test:claude` validates the plugin, type-checks against generated
  types, runs Claude engine fixtures and checks the documented reader and
  manifest. The Claude Code 2.1.323 validator also scans Node tests and warns
  about their TypeScript imports, even when the separate Node type check
  passes. The 2026-11-19 probe saw normal validation exit 0 and strict
  validation exit 1 for those warnings.

### Live evidence and limits

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
| Antigravity | Linux `agy` 1.5.8 on 2026-11-14 checked native rendering and transcript and quota readings. macOS `agy` 1.5.9 on 2026-11-16 checked the sandbox's setup and launcher access. | Live macOS rendering and Windows TUI rendering need their own checks. |

Keep evidence with its host build, platform and scope when revising these
contracts.
