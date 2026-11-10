# VArgus — design

VArgus supports Claude Code through its mod and Codex CLI through a standalone saved-log reader.
Codex uses a tmux row. The existing Claude inline status line has two parts. A mod (a plugin hooks module that stays
loaded for the whole session) hears the engine's events, keeps the numbers in memory, renders the
line and writes it to a file. The `statusLine` command is a shell one-liner that prints that file.
The line stays where VantageHUD's was, under the prompt. VArgus replaces VantageHUD and shares no
code with it.

This file is how VArgus works: each rule, with the reason for it. It is edited in place when a
rule changes, in the same commit as the code. It holds no history: what shipped in which version
goes in CHANGELOG.md, why one change was made in its commit message.

A point that a live session still has to settle is marked **Unsettled** and listed in
[Unsettled](#unsettled). The Claude mod API is early access: each fact about it here was read from the
types and docs, or measured, on the Claude Code version named in [Scope](#scope) or beside the fact,
and is re-checked on each new release.

Code comments cite this file by section name: `(DESIGN, "The line file")`.

## Contents

- [Hosts and outputs](#hosts-and-outputs), [Scope](#scope), [Decisions](#decisions), [Terms](#terms)
- [How it works](#how-it-works): layout, data sources, when the line is written
- [Fragments](#fragments), [Languages](#languages), [The detail view](#the-detail-view)
- [The line file](#the-line-file), [The reader](#the-reader), [Setup](#setup)
- [The host](#the-host): what the mod API gives and what it holds VArgus to
- [Config](#config), [Colours](#colours)
- [Rules carried over from VantageHUD](#rules-carried-over-from-vantagehud)
- [What VArgus cannot show](#what-vargus-cannot-show), [Unsettled](#unsettled)
- [Tests](#tests), [Rules for the code](#rules-for-the-code),
  [Not in this version](#not-in-this-version)

## Hosts and outputs

The boundaries are enforced by `tests/node/boundaries.test.mts`:

- `core`, `render`, `theme`, `i18n` and `options` import no host API or output adapter.
  Shared readings use VArgus types, including `RateLimit`, rather than Claude's engine types.
- Claude and Codex collectors do not import each other or an output adapter.
- Output adapters import no host code. `src/cli.ts` and `src/cli` wire collection to display.
- The Claude mod imports no Node code. The manifest points directly to its register module:
  Claude Code 2.1.319 validation rejects a re-exported `register` entry point.
- The Claude plugin and standalone Codex helper need no npm
  install or `node_modules` folder. npm supplies development/test tools only; `ws` is used
  by the hook regression rig to inspect Codex's daemon. `.test.mts` keeps Node tests outside
  the Claude engine's `.test.ts` runner.

### User-facing setup paths

README.md documents each host separately: Claude's inline plugin install and
`vargus-setup` skill, and Codex's clone/PATH entry and optional startup hooks.
Plugin installation and `/config` belong to Claude. Codex
reads CLI options resolved against `src/options.ts`; installing the Claude plugin
does not install Codex hooks. The tmux commands run from the clone, so removal
finishes footer restoration or exits the TUI before removing shared source.
For Codex startup hooks, removal edits only VArgus's callback entries, including
untrusted or modified entries without a trust step, then closes affected TUIs.
In the isolated 0.167.0 check, reopening `/hooks` after the file edit retained the
removed callbacks, while closing and reopening the same thread's TUI showed only
the preserved unrelated hook. The `config.toml` bytes were unchanged by that reopen.

Token totals use uncached input plus output in both collectors, with different
scope: Claude includes main and subagent requests in its loaded session; each
Codex reader owns the displayed log's readings. Claude reads git or svn; the
Codex Node reader reads git. README.md keeps those scopes explicit in the shared
fragment descriptions instead of applying the Claude-only rules to both hosts.

### Opt-in tmux row

Codex uses the standalone `on`/`off` controls inside ordinary Codex. Saved Codex
and tmux configuration files are not edited.

On POSIX tmux the output prepends a row to the session's existing status rows and shifts their effective
formats down. It stores the original local overrides, so exit restores inheritance as well as
explicit settings. At tmux's five-row limit it refuses to overwrite a row. The existing
`status-position` is retained: at the bottom, VArgus is above the original bar.
Native Windows psmux places VArgus above its built-in bar through the scalar
layout; existing custom format arrays retain their order. The limits are below.

Each helper owns a pane's `@vargus_line`. The row's `#{@vargus_line}` lookup follows
that client's active pane. It does not use `E:` or a shell `#()` formatter: repository text
cannot become a format command through recursive expansion. The encoder converts VArgus's
SGR colours and bold to tmux styles and escapes literal hashes. Nonempty rows begin
with two spaces; the Node renderer's width budget excludes that padding. Empty rows
stay blank. Tests use a dedicated server, not the person's current tmux server.

A short lock serializes session setup and cleanup across helpers. A prepared nonempty owner
directory is published atomically; owner filenames are unique, so stale cleanup cannot remove
a replacement owner's record. Disappearing lock paths are retried. The last owner restores the
bar. If status/status-format changed while running, the newer options are kept instead.
SIGTERM and SIGHUP stop the helper through its cleanup path; an uncatchable exit can leave
the row. A later attachment
or `bin/vargus tmux-reset` prunes dead owners. Reset refuses while an owner is still running.
State is under the OS temporary directory, keyed by tmux socket and session; credentials and
conversation messages are not persisted there. PID reuse and loss of the OS temporary files
while a helper is alive are not recovered automatically.

### Standalone controls in official Codex

`!vargus on|off|status` is a local user-shell command, not a native slash extension.
In the checked Codex source (`c2bd770ca7`), `chatwidget/input_submission.rs` says
`"!cmd" executes a local shell command instead of sending to the model`.
`core/src/tasks/user_shell.rs` passes the thread id into `create_env`, whose contract
injects `CODEX_THREAD_ID` even with an allowlist. A real 0.167.0 probe, with a scratch
daemon started outside tmux, received that exact thread id but neither `TMUX` nor
`TMUX_PANE`. Its shell probe made no model POST; a subsequent user prompt reached
the same local mock provider. These facts rule out inherited pane variables as the
sole binding and rule out needing an LLM to activate the row.

`bin/vargus` is a Bash entry that resolves its own symlink and runs `src/cli.ts`
with Node.js 24.12 or later. One PATH symlink exposes it; source stays in the clone.
Node's [TypeScript documentation](https://nodejs.org/docs/latest-v24.x/api/typescript.html)
marks type stripping stable from 24.12 and says "file extensions are mandatory".
The Node graph uses explicit `.ts` imports and ordinary class fields instead of
constructor parameter properties. Its typecheck enforces erasable syntax and
explicit type imports. Hooks and background workers start the same source entry;
no bundle, TypeScript loader or build step is used. Supported runtime entry points
use Node built-ins and local source modules; npm packages are development/test dependencies.
The row starts when explicit `on` or installed startup hooks start its helper.
The Claude mod graph does not reach this script or Node code.

`outputs/tmux/target.ts` discovers a named foreground application through tmux and
`ps` on POSIX, or a pane-rooted Windows CIM process tree on Windows. The outermost matching application process identifies the frontend; nested
same-command servers are excluded by ancestry, without inspecting positional prompt
text. Process lookups use unlimited width so `COLUMNS` cannot truncate worker tokens.
Selection is scoped to the default server, or an explicit `--socket`. One
matching pane may be selected automatically; ambiguous targets require `--pane`.
An inherited environment does not prove which terminal invoked a shared-daemon
command. Custom servers therefore require their socket explicitly. The CLI stores
a pane/TUI binding, root thread and worker PID/token under the temporary control directory.
It checks the token in the worker command line before signalling it, so a stale PID
record cannot stop an unrelated process after PID reuse. The existing tmux owner
lock arbitrates concurrent attachment. Each pane gets one owner and existing bar
options retain the same cleanup/restore rules. The helper watches the resolved TUI
process, not the persistent app-server daemon; `off` and TUI exit detach the row.

### Native Windows Codex and psmux

`bin/vargus.cmd` runs the same source with Windows Node. A user PATH forwarding
`.cmd` invokes that checkout entry, so no Bash entry, symlink privileges or build
is required. Windows hooks use the PowerShell call operator and the Windows
Codex home. Native background tmux, CIM, Git, metadata and worker processes use
`windowsHide: true`; the row worker is detached and hidden.

The actual attached-client probe on 2026-11-10 found another psmux 3.4.0
difference: `list-clients` returned `/dev/pts/7532`, but both
`refresh-client -S -t /dev/pts/7532` and `refresh-client -t /dev/pts/7532`
failed with `no server running` while unqualified refresh, with or without
`-S`, succeeded against the same live socket. This killed the helper on its
first rendered update and left the native-footer backup pending. psmux's
`main.rs` treats the tty-valued `-t` as a session route; its server
`connection.rs` handles unqualified refresh with `CtrlReq::RefreshClient`.
Windows therefore refreshes the selected server without a client target.
POSIX keeps its per-client refresh. The regression seeds only client enumeration
with the measured tty name and sends updates/redraws to real isolated psmux;
live verification also exercises the actual attached user client.
Routine Windows updates now publish only changed values in one command batch.
`SetOption` already marks psmux's state and metadata dirty; the extra forced
refresh on every poll was redundant. Explicit redraw remains for confirmed
view transitions. A fifteen-second live content sample retained its header
through the sampled updates; attached-client verification checks the actual
terminal stream in addition to stored values.

The Windows probe on 2026-11-10 used Codex 0.167.0, Node 24.21.0 and psmux 3.4.0
(`20aa1d7`). Unchanged process discovery reported `spawn ps ENOENT`; Git Bash's
`ps -ww -axo` reported `unknown option -- w`. Windows therefore reads process
IDs, parents and names through `Win32_Process`, normalizing `.exe` names, and
reads an individual worker's command line for the existing PID/token check.
Windows CreateProcess quoting escapes the JSON token's double quotes; the
worker check removes those escapes before matching the same token field.
POSIX keeps its original `ps` queries and foreground-command requirement.

In the native TUI rig, psmux's `pane_current_command` returned
`git-remote-https` while CIM showed `pwsh -> node -> codex` under that pane's PID.
Windows target selection therefore uses the unique outermost named descendant,
and snapshots carry that bound application name. Multiple independent matching
descendants remain ambiguous. Full thread identity and composer checks still
gate hook admission and key delivery.

psmux 3.4.0's own source
[`format.rs`](https://github.com/marlocarlo/psmux/blob/20aa1d7254ee93f64dafa059ef89341d9767470a/src/format.rs)
has `"cursor_flag" => "0".into()`. Its `dump-state` layout instead supplies
`hide_cursor`, cursor coordinates, copy/scroll mode and styled `rows_v2` cells.
Windows snapshots read that layout, retain bold/dim/inverse modifiers and remove
the layout's trailing cell padding. An inactive window returns an unavailable
snapshot and waits for a visit. Pane-list fields use a pipe delimiter on Windows:
the native probe returned literal `\t` from the original tab-delimited format.

Native probes set `status-format[0]` to a custom row, but both single-value
`show-options` forms returned an empty string and the full dump omitted that
array. The row renderer did retain the custom format. Windows therefore appends
a new row without shifting or reconstructing existing formats from expanded
text. For psmux's built-in single row, a layout probe confirmed that its scalar
`status-left` renders on row zero, and `status-format[1]` renders below it. Windows
uses a padded `@vargus_header` as the full-width left section, temporarily setting
`status-left` and its length and hiding the right section on that row. The
appended owned slot receives the original left expression, live window list
and current right expression, with window ranges and clock expansion. The
probe preserved session name, window name and right-hand clock beneath the header.
No raw row-zero format is assigned. Original left/length/right-length values and
the private left alias are restored individually only when their applied values
still match; newer user changes are retained. Padded headers use the window width;
psmux's `cols: u16` permits a scalar length cap of 65535 without per-window
changes to shared settings. Custom first-row formats and multi-row layouts keep
the earlier append behavior because their raw expressions cannot be moved safely.
The immutable `NativeBase` is captured under the lifecycle lock and cached on
each output. Rendering never reads the shared state file during another owner's
truncating write. Session-level original-info and blank-header fallbacks retain
the original bar when an unwrapped pane becomes active. Style-only ownership
marks let cleanup restore preexisting global values while preserving newer edits;
pane-local values inherited from those fallbacks are removed on owner cleanup.
The session/user-option listing and the explicit global window table
(`show-options -w -g`) are checked for `#()` commands. The latter includes the
separator and bell/last styles omitted by psmux 3.4.0's plain session listing.
Its [`render_window_options_for`](https://github.com/marlocarlo/psmux/blob/20aa1d7254ee93f64dafa059ef89341d9767470a/src/server/options.rs#L622)
uses `get_option_value(app, name)` for the global table; the local listing skips
inherited values. Any window-local bar format, separator or style keeps the
append layout too. From the pinned
[`lookup_option`](https://github.com/marlocarlo/psmux/blob/20aa1d7254ee93f64dafa059ef89341d9767470a/src/format.rs#L1303),
`window-status-format` returns `Some(app.window_status_format.clone())`, while
the built-in renderer in
[`list_windows_json_with_tabs`](https://github.com/marlocarlo/psmux/blob/20aa1d7254ee93f64dafa059ef89341d9767470a/src/server/helpers.rs#L429)
reads each window's local override. Rebuilding those windows through `E:` would
lose their own labels and styles.
The graph mirrors psmux's unprefixed-name lookup fallback to `@name` as well.
These keep the append layout so psmux evaluates commands through its cached async
render path. Adding such a formatter or a window-local bar override while active
restores the original scalar layout and makes other owners leave the header mode too.
This avoids one-shot `display-message` evaluation, which a live probe measured
as synchronous and capable of timing out on a valid slow formatter.
It reads the status count separately, retains the original count and
preserves the status position. Removal restores the
count only while the applied count and owned row still match; newer
settings are kept. An existing inactive slot blocks attachment even when its
expanded text is empty. A new raw slot is written only beyond the existing
array, after publishing its VArgus index marker. The assigned expression includes
a VArgus probe field. Reuse and removal validate that field with a style-only
witness in the expanded snapshot; reuse never assigns the existing raw format.
Shutdown retains the owned raw slot, restoring only the original row count, so
repeat activation can identify the slot without clearing an unknown expression.
An attachment error rolls back scalar changes and row count under the lifecycle
lock and removes only that attempt's owner. An existing owner's row remains in
use. The owned hidden raw slot can still be reused on retry; if restoration
itself fails, the saved ownerless record remains for a later recovery attempt.
With an originally hidden bar, native activation uses the implicit base row
plus VArgus (two rows), then restores `off`; index zero is preserved.
The five-row limit and shared owner lifecycle remain enforced.

Windows directory-rename contention can return `EPERM` instead of POSIX's
`EEXIST`/`ENOTEMPTY`. Locks inspect the existing owner record before deciding
whether to reject or reap the contention. Codex metadata reads launch its npm
shim through `cmd.exe`; stdin EOF and a bounded close wait release its native
child's SQLite handles. The timeout stops only that owned process tree.

The isolated official-Codex/local-mock Windows rig verifies native lifecycle
hooks, token display, `on/status/reload/off`, preserving a custom first row and
sharing the extra row between owners. The ordinary prompt is the positive
control for model requests; the controls leave that request count unchanged.
Hook trust bypass is confined to the isolated fixture home and its vetted hooks;
user setup leaves trust to Codex's UI. The rig uses `--no-daemon`. An independent
native TUI probe also ran a `!` shell control without adding a model request and
sent a normal prompt after manual off: that prompt added a request while the row
remained off. Windows shared-daemon mode, sibling navigation, draft races,
other psmux versions and non-mock model behavior remain unverified.
Portable command-contract tests exercise failed writes before and after their
application, retry, a failed join beside a live owner, inherited shell formatters,
and window-local overrides added before or during shared ownership. They model
psmux option listings and do not establish native rendering behavior. Native
regressions for the global separator, interrupted scalar restoration and local
formats/styles are included in `windows.test.mts`; the follow-up checks on Linux
skip those native cases.

`hosts/codex/rollout.ts` resolves the current path through Codex's read-only
`thread/read` metadata and validates the file's first session metadata and location
under CODEX_HOME's `sessions`. If the metadata request fails, exactly one recognized
canonical/session-suffixed filename is a compatibility fallback. Multiple candidates
never choose by directory order or modification time. The reader then consumes JSONL
incrementally.
It retains incomplete records and UTF-8 bytes between polls. It normalizes records
into the existing Codex collector: session metadata for creation time and cwd,
`turn_context` / `thread_settings_applied` for recorded model and effort,
`token_count` for cumulative usage, native context-window gauge and quota snapshots,
and completed visible items for tools. The quota translation retains `normal_model_slug`
as `normalModelSlug`, so the shared collector can prefer the active model's named
bucket before the general `codex` bucket. User-shell controls are excluded from tool
counts. Explicitly attributed settings/items for another thread are ignored.
Compaction drops the old context reading until new usage arrives. Token totals
remain within the selected thread; child histories are not aggregated into the
parent. Subagent starts and observed skill loads are replayed as described below;
workflow counts are not reconstructed.
Paginated child logs can contain a copied parent prefix. In checked source
`c2bd770ca7`, `protocol/src/protocol.rs` defines
`subagent_history_start_ordinal` as "First rollout ordinal that belongs to this
subagent's own projected history." The reader selects the child's initial metadata
and skips records before that ordinal. Inherited developer skill catalogs remain
available for recognizing later local reads, but inherited skill injections,
settings, usage, compaction and tool/agent items do not update the child's readings.
This uses the recorded ordinal, not a line count, timestamp or guessed user-message
boundary. Polling an incomplete inherited prefix leaves activity empty; later
appends and a cold replay use the same boundary. A missing/invalid ordinal in this
mode stops that reader persistently instead of resuming unattributed records.

The boundary is used only with paginated metadata and a positive safe integer.
Mixed histories without this supported boundary retain the earlier guard: foreign
`session_meta` throws `The transcript belongs to another Codex thread.` and clears
agent/skill counters for the reader lifetime. Later polls can advance past that
error, but other readings in those unsupported mixed logs remain unreliable.
Direct `thread/fork` and older transcript formats are not inferred to have a copied
prefix from `forked_from_id` alone.
The pane helper checks the view on a 250 ms loop. Readings refresh once per second
or when the recognized view changes; new saved sessions are discovered once per
second. It uses the existing git poll/hold-off rule.

The official [hooks documentation](https://learn.chatgpt.com/docs/hooks#common-input-fields)
says the transcript format "isn't a stable interface". No hook installation is
required for these controls: their environment supplies the exact thread identity.
Compatibility comes from the versioned log fixtures and the real official TUI
with a localhost mock provider. Ephemeral chats have no required saved log and
are refused. Changes not yet written to the log remain unknown. `hosts/codex/views.ts`
matches the contextual footer below the composer to `session_meta` child paths and
parent relationships. In checked source `tui/src/app/agent_navigation.rs`,
`active_agent_label` returns a backtick-wrapped `agent_path` for a child and
`Main [default]` for the primary thread. `bottom_pane/footer.rs` retains this label
when configurable items are cleared. For on-mode readings, the catalog rejects
ambiguous/reused paths within the bound family; unrelated families do not select a child. A full unambiguous UUID
field anywhere in the native footer selects an exact known family member before path
matching; a full foreign ID stops selection. This also recognizes a child when a
crowded footer clips its path. Without that ID, clipped paths, popups and other
unrecognized views blank the row and pause footer commands. Log
mtime is never a selection signal. The writable primary prompt uses the activation's
thread identity when its Main label is absent; empty parent-owned child views use
a dim placeholder even though their drafts remain editable. Without the optional startup hook, `/new` and `/resume` require `on` again; this is not a general
external frontend-selection API. Future host format changes must
be rechecked against these limits.

Contextual matching reads a complete final label, not arbitrary backtick spans
inside configured items. In checked source `8703d32bd0`,
`bottom_pane/footer.rs` builds the row with
`let suffix = passive_footer_suffix(props, status.is_some());`; that suffix appends
`active_agent_label` before `" for agents"`. A title such as
``Review `/root/first` details`` therefore cannot override the following
`Main [default]` or a different child's label. Without an agent-navigation hint,
a lone quoted configured item in the empty primary composer does not establish
a child identity.

For native ID matching, a known first-item `thread-id` (or legacy `session-id`) layout needs the full ID
prefix to remain visible; later fields may be clipped. Other item orders require
an untruncated footer with one full UUID field. `views.ts` rejects an ellipsis in
those fields rather than treating a UUID-valued branch or title as the thread.
This makes terminal column width relevant when moving between terminals or SSH
clients. Putting the ID first is a clipping workaround, not a requirement when
the whole footer fits.

Display recognition is separate from permission to send footer commands. On
0.167.0, parent-owned children also keep drafts editable; only submission is
blocked. Their contextual labels disappear while typing, so a bold live arrow is
not evidence that the primary thread is displayed. The observer leaves such a
view unknown instead of assigning its readings to the root.

Standalone Codex preserves last-confirmed readings while typing by default,
without a separate option. Once a view has rendered, the Node renderer keeps a deep copy
of its values, options and render time. An unidentified editable draft can show
that snapshot without an added label, as requested by the maintainer. Readings/time
stay frozen; only fitting to the current width is repeated. Runtime `selected`
remains unknown and separate paused
metadata identifies the historical view. This is last-confirmed information, not
proof of the currently displayed thread: source `8703d32bd0` gates Alt navigation
on empty input but allows other routes, including selection of a preserved draft,
and the observer can miss transitions between its polls. The user explicitly
chose last readings after the indistinguishable child-draft probe and later asked
to remove the visible paused marker.

The display-only draft frame requires a bold live arrow (or `!`) and a native
`% context left` hint (or `Shell mode` with a live `!`) below the textarea. It
locates the complete footer after wrapped/multiline input, keeping typed agent
paths and UUIDs outside that metadata. Native IDs retain ambiguity/clipping rules.
Codex can append a warning notice on the same hint row. Source `8703d32bd0`,
`bottom_pane/chat_composer/warning_notice.rs`, emits `format!("{count} warning{plural}")`
with a shortcut, then falls back to count-plus-shortcut or count-only notices.
Draft recognition removes these suffixes from the hint check only; the original
footer still supplies identity and clipping checks. A captured official 0.167.0
draft frame with `82% context left` followed by `⚠ 1 warning · f2 to view` was
rejected before the fix; removing only the notice restored recognition. Fixtures
cover context and shell hints with each notice form; compact forms are source-derived.
No paused snapshot is shown for explicit foreign/clipped metadata, dim history or
placeholders, reversed picker arrows, or other unrecognized screens. Existing
Main/path selection remains intact. Startup matching and footer delivery retain
their strict empty-editor guards. Off removes the row immediately. The snapshot
is local to one loaded helper; reload or a fresh activation needs a recognized
view before it can hold readings. Claude does not use this standalone holding behavior.

The official-TUI probes distinguished this from row allocation or helper exit:
ordinary parent text lost selection while clearing restored it; typing the exact
placeholder retained the old fallback. Child drafts hid their labels too. The
initial draft-to-root proposal displayed parent totals for a child; the corrected
behavior preserves unknown identity and retains a frozen historical snapshot.

#### Codex startup hooks

`codexAutoStart` defaults to true in shared options and userConfig. Installed,
trusted SessionStart and UserPromptSubmit commands use those defaults without
an options file. Hook installation is still required; this changes no Claude behavior.
The [official hook documentation](https://learn.chatgpt.com/docs/hooks#sessionstart)
provides stdin JSON and startup/resume/clear/fork source matching. The shipped
example excludes compact: ordinary turns and compaction must not undo manual off.
A UserPromptSubmit fallback handles loaded-thread resumes. No Stop, SubagentStart
or SessionEnd handler is installed; existing view polling and TUI-process cleanup
remain responsible for those cases.

In checked source `c2bd770ca7`, `core/src/session/session.rs` queues start sources;
`core/src/session/turn.rs` runs pending start hooks during the first turn. A real
0.167.0 embedded TUI trace confirmed no startup hook before the first prompt and a SessionStart
payload after it. That hook inherited a CODEX_THREAD_ID from another conversation.
The adapter reads the first record and verifies that its ID matches a saved file
inside this home. After prompt preflight, it compares that path with the current
path reported by Codex. Already-on/off prompt fast paths therefore avoid metadata
RPC as well as config/read. The verified path is passed privately to the normal on
control, and the worker pins its root catalog entry to that file. Old workers with
no reported path, or a different path for the same ID, are replaced by explicit on.
Ambiguous non-root catalog histories remain unknown instead of choosing one.

A read-only check of the maintainer's active thread found both a shorter canonical
filename and a larger file with an additional UUID suffix. Native thread/read
reported the suffixed file. The old filename-only resolver chose the canonical
file, and the hook validator rejected the reported current path. The captured
five-minute diagnostic window did not include the user's later test message;
this path failure was established separately from native metadata and a validator
control. The fixed reader replayed the reported current file successfully. The
engine regression creates that duplicate layout in its own scratch history/DB,
then checks genuine CLI hooks, the runtime path and subsequent activity. It does
not claim the CLI naturally created that fixture suffix.

`hosts/codex/read.ts` shares the initialized stdio metadata/config request lifecycle.
Its supported methods create no thread, resume no thread, write no configuration
and make no model request. The on control uses event cwd, not metadata's older cwd. Creation source/originator and shared hook session_id do not
identify the current frontend or concrete thread after a resume.

The hook broadcasts by scanning foreground Codex panes on the default tmux server
or an explicit socket. It uses an eight-second retry deadline, then exits. The
command callback owns this bounded scan; no persistent inbox daemon is needed. It first reads
effective saved footer settings and requires `thread-id` or its legacy alias
`session-id` somewhere in the selection. In checked source `8703d32bd0`,
`tui/src/bottom_pane/status_line_setup.rs` declares
`#[strum(to_string = "thread-id", serialize = "session-id")]` for `SessionId`.
The shared `footerIdentity` check preserves the saved spelling and item order for
hook admission, its locked recheck and the worker's view recognition.
`hosts/codex/views.ts` splits the first configurable footer line into native
separator-delimited fields below a recognizably empty composer, and requires one
complete UUID field. Middle/tail layouts require an untruncated line containing
one UUID field; substring matches, multiple UUID fields and clipped rows do not
establish identity. A saved first-item layout can use its complete first field
while later fields are clipped. This assumes the pane uses its saved footer
selection; invocation/private selection overrides are not read back reliably.
It never reads identities from chat text or clipped UUID prefixes. In checked `tui/src/chatwidget/status_surfaces.rs`,
`StatusLineItem::SessionId => self.thread_id.map(|id| id.to_string())` supplies that
value. One exact visible match is required across candidate panes; explicit pane
selection cannot bypass duplicate matches. This binds the displayed conversation,
not the frontend that emitted the event. A native UUID-named Git branch regression
showed why clipping must be rejected: a branch UUID stayed complete while the real
tail ID was shortened, and the previous shape-only parser selected the branch's
thread. Startup and follow-mode recognition now use the same clipping rule. The
prompt preflight sees only candidates for deciding whether to read configuration;
it cannot activate a row. The final target check reloads saved footer settings.
The worker uses first-item recognition only when every known view's saved/backup
layout proves that position; layouts without a configured ID retain the existing agent-path and primary
composer recognition instead. An event for another thread does not
select a pane. Inherited terminal variables and creation metadata do not substitute
for this binding.

`outputs/tmux/target.ts` exposes candidate enumeration separately from the existing
manual target resolver. Manual ancestry/unique-pane fallback is retained. Automatic
startup rechecks the footer ID, uniqueness and TUI PID under a pane control lock
before starting the normal helper. Once the hook has opted in and created its
state directory, manual on/off use the same lock; status stays available during
controls. Without that directory,
manual controls retain their existing path and require no new home writes. Off writes a
per-thread/TUI suppression marker under `CODEX_HOME/vargus/autostart`; a delayed
callback cannot reactivate it. Explicit on clears the marker. Another thread or TUI
PID has a separate key. Off before any binding exists resolves the displayed full
ID or uses the existing manual target resolver, then records suppression before
acknowledging off. Non-opt-in controls keep their old early return. Setup creates
the opt-in directory before the first callback; custom servers and ambiguous
unbound controls still need explicit targeting. The original early return was
reproduced with real trusted payloads delivered after an acknowledged unbound off:
the row activated without a new model request. A permanent wiring regression now
covers that entry path as well as a first callback after /new. Markers are small
files retained until removed by explicit on or local cleanup. Both handlers use
the `codexAutoStart` switch, enabled by default. The CLI captures normal on stdout
because hook stdout would become developer context.

A trusted official 0.167.0 daemon probe kept a thread loaded in one TUI and
resumed it in another. The second prompt emitted UserPromptSubmit without another
SessionStart. Restarting only the scratch daemon made the next resume emit both
hooks. In checked `app-server/src/request_processors/thread_processor.rs`,
`resume_running_thread` returns the existing engine; a new engine queues the start
source in `core/src/session/session.rs`. This selects UserPromptSubmit as a fallback
rather than assuming a frontend reconnect always starts an engine session.

An upgrade probe first loaded a thread with only SessionStart configured, then
added UserPromptSubmit. A second TUI trusted the added entry through the normal
startup dialog and resumed that loaded thread. The new prompt hook ran without
another SessionStart. This follows `tui/src/hooks_rpc.rs`: accepting hook trust
uses config/batchWrite with reload_user_config true, refreshing loaded hook
runtimes. Upgrade instructions therefore include trusting the new entry in a
reopened TUI; VArgus does not restart the shared daemon or write trust hashes.

Removing a retired hook `--config` argument must also refresh already-loaded
callbacks before deleting their options file. In checked source `8703d32bd0`,
`ConfigBatchWriteParams.reload_user_config` says "hot-reload updated runtime
settings into loaded threads after writing"; the config processor also accepts
empty edits for this refresh. The official 0.167.0 daemon regression sends empty
`config/batchWrite` edits with `reloadUserConfig:true`, checks unchanged saved
config bytes and the loaded thread's new commands through `hooks/list`, and then
deletes the retired file. Modified hooks skip until the normal TUI trust review;
after trust, both a resumed frontend and the originally loaded frontend run the
updated prompt hook without the file. Explicit missing user-supplied config files
still fail; there is no general missing-file fallback.

`vargus hook prompt` validates the same concrete transcript identity. It attempts
activation once, with the same final pane/PID check and off suppression. Missing or
hidden IDs and off markers return before config/read, avoiding a config subprocess
and a polling window on ordinary already-on/off turns. No prompt text is used by
the adapter. SessionStart retains bounded readiness retries. Two callbacks racing
on cold startup use the existing pane lock; a contender skips if another control
is pending. Neither handler makes a model request or creates a status card.

The earlier trusted official 0.167.0 daemon test ran the hook below the daemon,
with empty TMUX/TMUX_PANE and transcript source vscode despite a CLI originator.
Checked `hooks/src/registry.rs` captures process environment, so ancestry and these
variables cannot bind shared-daemon callbacks to the TUI. The test-only trust bypass
also excludes daemon startup (`tui/src/daemon_startup.rs`); current daemon fixtures
accept the actual isolated trust dialog and do not use that bypass. VArgus does not
change daemon policy.

A throwaway official 0.167.0 trusted-daemon/local-provider probe verified full footer
IDs against transcript metadata on startup, after /new and after resume. In that
probe /new emitted source startup. Two panes in the same directory had distinct
IDs; opening the same thread in another pane produced duplicate IDs. At 30 columns
the ID was clipped; clearing the configurable footer removed it. Resume initially
showed “Resuming session…” without an ID, selecting bounded readiness checks rather
than a guessed delay. The attempted separate exec control did not yield an observed
hook callback and is not live detached-hook evidence.

The official-engine/localhost regression uses a tail ID and verifies a loaded
resume through UserPromptSubmit while the SessionStart trace remains unchanged.
It also verifies first-turn shared-daemon activation despite a stale inherited thread ID, footer clearing, silent hook output
in later provider inputs, manual off with saved config unchanged, and replay of the
completed real callback after off. A separate trusted case without a saved full-ID
selection leaves the row absent and native footer visible. The engine regression
also activates a second pane independently and rebinds it after /new. Fixtures cover stale or detached IDs, duplicate matches, clipping,
drafts and the locked identity recheck. Adding session-id to the crowded saved
footer reproduced a first-child-visit failure: the full ID remained visible while
the path was clipped. Exact known-family ID selection cleared the native footer
and retained the row on first visits in the same controlled regression.
These are supplied mock responses, not model-chosen actions. macOS, real-provider
timing and general cross-frontend ownership remain unverified. Typing/navigation
still share the existing observation race; missing identity or an exhausted scan
requires explicit on or another matching SessionStart event. Saved footer backups,
row attachment and exit restoration use the normal controls.

#### Native footer control

The explicit standalone `on` control opts into native footer automation as well as
the row. This is the user's requested behavior for bare `on`; it introduces no
Claude option. `hosts/codex/footer.ts` reads effective saved layers through an
initialized `codex app-server --stdio` and `config/read` with the caller's cwd. It
creates no thread and writes no config. An unset `status_line` is retained as null,
an explicit empty list stays empty, and custom item order is preserved. For unset
settings, restoration uses `model-with-reasoning current-dir thread-name`, the
`DEFAULT_STATUS_LINE_ITEMS` in checked source `c2bd770ca7` and tested on 0.167.0.
Invocation overrides and private session-only footer selections are not read back.

`FooterSettings` preloads each known workspace's saved selection before pane
observation. Views in the same workspace share cached settings, while restore backups remain per
thread. Explicit `on` starts a fresh settings cache without replacing existing
backups; failed workspace reads can retry without discarding other cached values.
No config/read call sits between recognizing a new view and backing it up/clearing
its footer. Worker v7 replaces older on-mode workers while retaining their backups.
For a bound helper with reload metadata, bare `on` upgrades the helper and preserves
its root, home and effective custom options. The retired draft-hold setting is
dropped when resolving options. Explicit `on` can reuse the same-version helper;
updating source alone does not change code already loaded in Node. `off` can still talk
to earlier supported workers.

Standalone `reload` is an explicit opt-in to replacing only the pane helper with
the current `.ts` source. It does not restart Codex, its daemon or the conversation,
build packages or install a watcher.
The runtime record carries version-1 reload metadata: CODEX_HOME and effective
resolved options. Supplied flags merge over those retained options in command
order; omitted keys retain their previous values. Older workers without metadata
are refused before stopping: off followed by on with the original options enables
reload without guessing their custom configuration.

All standalone mutations share a pane admission lock, including when hooks are
disabled. The optional startup lock still guards hook identity and off suppression.
Reload checks the foreground TUI PID, resolves the bound root's current saved
transcript and replays it before stopping the helper; the worker PID/token is
checked again before signalling. It saves a versioned recovery handoff before
replacement, retaining root, target, mode, home and options. Original per-view
backups remain separate and are never replaced with an already-hidden layout.
The replacement rediscovers the displayed view and replays each view's own log.
Restore mode and manual-off markers remain off. The retained root's off marker
takes precedence even if an interrupted off left the old runtime in on mode.
A fully off pane has nothing to
reload. Successful startup removes the handoff; failure removes abandoned row
ownership but keeps backups and handoff for retry. Explicit on/off supersedes the
handoff. Unavailable history fails preflight without stopping a healthy helper.

A read-only trace on 2026-11-08 captured the first-visit failure with a populated
fullscreen footer: the full child path appeared, Git counts arrived and clipped it,
then the worker recorded unknown identity and blanked its row while tmux kept the
row allocated. A second visit cleared the footer before clipping. The controlled
engine regression uses the same footer item selection, a one-second config-read
delay and a delayed Git summary; it fails with the previous worker and passes with
preloading. The user's fresh first-switch retest also cleared the configurable
footer and retained the tmux row. This addresses the observed cold-read window;
it does not establish reliable identification when the path is already clipped.

The [official command documentation](https://learn.chatgpt.com/docs/developer-commands#configure-footer-items-with-statusline)
says to list items "for this session only" and documents `/statusline --clear`.
In checked source, `chatwidget/status_surface_commands.rs` changes frontend
`StatusSurfaceOverrides` and local settings; it does not persist the selection.
`SlashCommand::Statusline` is available during a task. A real 0.167.0 probe found
that editing the saved config did not change the displayed footer; native slash
commands did. These findings select tmux composer delivery rather than config
rewrites or a custom Codex binary.

The CLI backs up the saved selection before row startup and sends the clear command
only after successful attachment. Each recognized child gets a separate saved-layout
backup before its footer changes. A backup is keyed by socket, pane, TUI PID and
thread, separately from the worker record. Repeated `on` retains original backups.
Discovery reads only completed `.json` backups. The atomic writer's
`.json.<pid>.tmp` files are not bindings, including after an interrupted write.
Startup attachment failure removes a new backup without touching the footer;
uncertain delivery retains it. A versioned pane controller serializes footer work
and control requests. Request admission publishes a prepared PID-owned lock; a
later caller can reclaim it after cancellation, while live callers retain exclusion.
Re-enabling a pending restore reuses that controller. An old
pre-follow worker is stopped and replaced while its existing backups are retained.

In checked source, `StatusSurfaceOverrides` is retained in per-thread input state;
`select_agent_thread` restores that state into the replacement widget. The native
command changes the selected view only. A real engine-created child probe confirmed
that restoring the parent leaves a previously cleared child hidden, and the same
restore command in the child restores it. This rules out claiming immediate all-view
restoration from a single native command.

The user chose restoration on the next visit: `off` detaches the tmux row immediately
and changes the helper to restore mode. It restores each affected view when selected
and recognizably empty, then deletes that view's backup. The helper exits when no
backups remain or its TUI process exits. Drafts, unknown views and visible native
errors leave restoration pending; `status` reports the pending count and current
pause. This can keep a helper alive until Codex exits if a view is never revisited.
Restore mode considers backed-up views from earlier roots in the same TUI, while
on-mode readings remain limited to the bound family. A full native ID can identify
an earlier root on a later visit. Path labels remain limited to the bound family:
different roots can reuse the same agent path. Where that identity is unavailable,
explicit `off` in its primary conversation uses `CODEX_THREAD_ID` to replace a restore
helper bound to another root. This scope-only replacement retains the helper's
effective display options, with supplied flags merged over them. The empty-primary fallback applies to that bound
root only; it never guesses a different root from the pending backups.
If a restore helper finishes before acknowledging `on`, that control starts a
replacement under the same pane admission lock, retaining the previous options
and removing the abandoned request. An unresponsive live helper still times out.
No navigation keys are injected. After a worker crash, `off` prunes abandoned tmux
owners before resolving the transcript, retaining other live panes. If transcript
resolution fails, the row stays removed and backups stay pending; the control reports
that restoration needs `/statusline`, a Codex restart, or another `off` after the log
becomes available. It starts no restore helper against an unknown transcript. With
a readable log, `off` restarts restoration. A new TUI PID
does not inherit old backups; saved config needs no repair on TUI exit.

`outputs/tmux/input.ts` handles generic capture and key delivery without host
imports. The Codex host recognizes the cursor at the complete dimmed parent or
read-only child placeholder; a draft with those same words is rejected. The input
adapter rechecks before
insertion, verifies the entire command and cursor before Enter, and observes the
empty prompt again. View identity is checked with that empty prompt before and
after delivery; the contextual label can disappear while the command draft is
present, so the exact draft/cursor check guards Enter. Any visible native statusline
parse error makes completion
inconclusive and retains the backup, even when it predates the command. A finite
viewport cannot reliably distinguish repeated identical errors from old ones. The
user resolves the error and moves it out of view before retrying. The adapter sends
no erase keys. Unrecognized UI or a restore command that fails the width guard
gets a retry message. `PaneInput.submit` rejects `text.length + 2 >= screen.width`
before inserting any keys: the command plus the prompt prefix must fit with room
to spare. `restoreFooter` joins the full saved item names after `/statusline`, so
the command can exceed the width even when the rendered native footer fits.
The tmux row is already detached; the original backup remains pending. Widening
the pane and retrying `off` can restore it. Changing saved settings does not
rewrite an existing backup; a shorter saved layout applies to a later activation
after that backup has been restored. Existing drafts are preserved in
the live tests; simultaneous typing still races with terminal observations because
there is no atomic editor lock. Users must wait for a control to finish before
typing or navigating. Codex's shortcut/context hint row remains after clearing footer items.
A confirmed view transition requests one full tmux client redraw; ordinary updates
still use status-only refresh. The captured first-visit failure above involved
blanked row content after clipped identity. Necessity of a full client redraw is
not established by the row-visibility fixture.

Observed on 2026-11-09 in a 157-column Linux tmux pane, with the user reporting a
different terminal size through macOS SSH: the native footer ended in a clipped
session ID and the helper reported unknown identity. Replaying the captured frame
with the full matching ID selected the root; briefly widening the live window
let the existing helper recognize it and clear the footer. The row remained active
after the original width and sizing option were restored; saved config bytes were
unchanged. A later `off` reported the restore-command width guard. After the user
shortened the layout, its restore command passed that guard, and the user reported
successful `on`, `off` with no pending restoration, then `on` again. This distinguishes
displayed-footer clipping from command wrapping; neither required a code change.

The live local-mock suite exercises saved defaults, explicit empty/custom layouts,
repeated on after a saved setting change, two panes, blocked draft restoration,
row startup failure, restoration after a killed helper and repeated native restore
rejections without losing the backup. The sibling-view engine test creates two real
child threads through a localhost mock, assigns distinct token usage, navigates
between them, checks the attached tmux client, preserves a draft, and verifies
restore-on-visit ends the helper. An isolated probe also migrates the committed
pre-follow worker while retaining its backup. These are official engine/UI checks
with deliberately supplied tool calls, not evidence of a model choosing delegation.
In the fresh-chat runs, the provider POST counter stays at zero through controls and
increases after a
user prompt through the same provider as a positive control. This establishes the
checked 0.167.0 behavior; other composer layouts, macOS and billed endpoints remain
unverified.

### Codex saved-log collector

`protocol.ts` defines the normalized usage, quota and completed-item readings passed
from `rollout.ts` directly to the collector's typed methods. Each `RolloutReader`
owns one collector with one set of values and deduplication sets; `rowWorker`
owns the map of readers for displayed views. The reader checks transcript identity
and explicit settings/item attribution before updating its collector. Token totals
and counters belong to that saved log; child histories are not aggregated. View
recognition uses saved-session metadata. The collector does not route synthetic
RPC messages, track frontend requests or maintain a transport connection.

The read-only stdio requests for `thread/read` and `config/read` remain under
`hosts/codex/read.ts`: they resolve the current transcript and saved footer settings.
VArgus does not launch or proxy the user's Codex TUI. Ordinary Codex and standalone
controls are the supported Codex path. The live engine and footer limits above apply.

### Codex model names and call counts

The maintainer chose short family names without a full-name display switch, as
on Claude. The former `codexShortModel` userConfig key is removed; existing JSON
options containing it are ignored by `resolveOptions`. The separate
`codexAgentCounts` and `codexSkillCounts` userConfig switches default to true and
have no effect on Claude. The existing `model` and `callCounts` switches still
gate their whole fragments. Names shorten only GPT
version IDs ending in the checked families `astra`, `sol`, `terra` or `luna`;
unknown IDs remain whole. Both `gpt-6-sol` and `gpt-6.1-sol` become `sol`. This is
presentation only: the collector retains the full ID for quota matching and
recorded settings. The local model catalog checked on 2026-11-08 contains those
five IDs, and the official [GPT-6.1 Sol model page](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
gives `gpt-6.1-sol` as its ID.

Recorded Fast selection adds a faint `(fast)` suffix to the same fragment:
`sol:max(fast)`, or `sol(fast)` with effort hidden/unavailable. It has no separate
option and is visible by default. In checked Codex source `8703d32bd0`,
`protocol/src/protocol.rs` defines `ThreadSettingsSnapshot.service_tier` as
`pub service_tier: Option<String>`; the installed 0.167.0 engine saves Fast as
`"priority"` and off as `"default"` in `thread_settings_applied`. The reader also
accepts the legacy `"fast"` spelling. Other or missing tiers omit the suffix.
The snapshot belongs to its recorded thread, so another thread's settings and a
paginated child's inherited parent prefix cannot set its Fast reading.
`turn_context` carries no tier in this version: the reader keeps the last
selection for the same model and clears it when an unattributed model change
leaves that selection unknown. Global saved config is not used to infer this
per-thread reading. The suffix reports selection, not delivered provider speed.

The real 0.167.0 app-server/localhost-provider Fast test changes settings between
completed turns. Its row moves from `sol:max` to `sol:max(fast)` and back without
another provider request; a later same-model turn and cold replay retain Fast.
These are saved-setting checks, not verification of paid Fast routing, latency
or billing. Native Windows Fast transitions remain unverified.

The standalone reader maps completed `SubAgentActivity` records with
`kind:started` to the collector's existing agent-start path. Legacy completed
`CollabAgentToolCall` records use raw `tool:spawn_agent` (the app-server spelling
is `spawnAgent`). Canonical item IDs deduplicate starts. Interactions, completion
notifications and failed legacy spawns do not add starts. These mappings do not
add tools: the previous completed-visible-tool total is preserved. Counts belong
to the displayed log; child logs are not summed into a parent.

`hosts/codex/skills.ts` counts observed local skill loads, not successful execution
of a skill's instructions. In checked Codex source `c2bd770ca7`,
`ext/skills/src/fragments.rs` gives selected instructions the content kind
`"skills.selected_skill_instructions"` and markers `("<skill>", "</skill>")`;
`core/src/session/turn.rs` records these injected response items. A load comes
from that marked user instruction block, or a completed, exit-zero
`CommandExecution` with a parsed `read` of a catalogued `SKILL.md`. The latter
uses the recorded developer catalog (`host_skills.instructions` / `skills.catalog`)
and expands its host root aliases. Paths resolve against the recorded command cwd,
including file URIs. The deduplication key is the normalized recorded path and
turn ID. Injection and reads in one turn count once, and later turns can add
another load. Catalog discovery, ordinary text mentions, references, user-shell
commands and failed reads do not add loads. Polling/replaying the same history
does not add another copy of its count. The icon is shown directly (`⚡3`), by
maintainer choice. Unknown shell parses, cached reuse without a new load, cloud
and executor loaders, symlink aliases, and catalog formats outside the checked
version are outside this observed-load contract.

The real 0.167.0 app-server/localhost-provider skill test loads two scratch skills:
explicit alpha, automatic alpha read twice in the next turn, then explicit alpha
plus alpha/beta reads in a third turn. Its observed skill totals are 1, 2 and 4;
the four shell reads stay four tool calls, and a fresh reader reconstructs 4 from
the log without another provider request. It then spawns a real `fork_turns:all`
child whose inherited prefix includes those loads. The child performs a beta skill
read: its tool and skill totals reflect that local read, while the parent retains
its own skill total and records the spawn. These are engine-record checks with
deliberately supplied local tool calls, not proof of a model choosing skills.

## Scope

The existing inline/mod rules below describe Claude Code. Codex and the optional tmux
output are specified in [Hosts and outputs](#hosts-and-outputs).

- Claude Code 2.1.299 or later: mods are on by default from 2.1.287, and the facts below were
  checked on 2.1.299 and re-checked on 2.1.300 and 2.1.301; a measured fact names its version
  (older versions are untested).
- The line shows wherever Claude Code shows a `statusLine`: `claude` in a terminal, an editor's
  integrated terminal included. Where the status line is not drawn (the VS Code extension's chat
  panel, `claude -p`, the Agent SDK, cloud sessions) VArgus shows nothing, as VantageHUD did.
- Linux and macOS. Windows only with Git for Windows (tested on one Windows 11 machine, Git
  2.56.0, Claude Code 2.1.300, 2026-10-17): Claude
  Code "runs status line commands through Git Bash when Git Bash is installed, or through
  PowerShell when Git Bash is absent" (statusline docs, read 2026-10-17), so the POSIX `sh`
  reader runs there and fails under PowerShell. The setup skill checks for Git Bash before it
  writes the reader, and writes the data folder with `/`. The mod takes the home from
  `USERPROFILE` and treats `C:\...` or `C:/...` as absolute (written with `/`). `$.process.run`
  has no shell (types: "by its argument vector (no shell)"), so `mv` and `rm` run only when Git's
  `usr\bin` is on Claude Code's `PATH`. Measured on that machine: started from PowerShell it was
  not (the machine `PATH` has only `Git\cmd`), so the line was written in place with its `.tmp`
  left beside it, and session folders stayed after exit; started from Git Bash both worked. So
  on Windows the mod moves and removes through cmd.exe ([The line file](#the-line-file)).

Not in scope: the band above the prompt and other mod-drawn UI (the `/vargus` pane, opened only
when asked, aside), data that only the status-line
payload carries ([What VArgus cannot show](#what-vargus-cannot-show)), teammates running in their
own tmux pane, code shared with VantageHUD.

## Decisions

| decision | why |
|---|---|
| 0.1.0 shows VantageHUD's fragments in VantageHUD's order, each on or off by default as there ([Fragments](#fragments)); none is added or removed before 0.1.0, except `cache:` (off by default there), left out by the maintainer's choice ([What VArgus cannot show](#what-vargus-cannot-show)) | The first release replaces VantageHUD like for like, so the two can be compared fragment by fragment; which fragments to add or remove is decided after 0.1.0 |
| English only in 0.1.0, through one labels table per language ([Languages](#languages)) | One language to test; a second is then one file and one registry line, with no change to the fragments |
| The mod collects and renders; the `statusLine` command only prints | The status-line row is where the person wants the HUD, and no mod can draw there or set `statusLine`. A mod can do everything else: it stays loaded, hears each request's usage, keeps state in memory and runs a clock while the session is idle. So the work moves into the mod and the command shrinks to a `cat` |
| The reader is one `cat`, never Node | VantageHUD starts Node for every frame; a bare Node start alone costs 37 ms, against 2-3 ms for one `cat` as Claude Code runs it, in a shell (1.7 ms under dash, 2.7 ms under bash; measured 2026-10-14 on the dev machine). Cheap enough to run every second |
| The mod writes the line to a temp file and `mv`s it into place | `$.fs.write` is not atomic and `$.fs` has no rename; a rename is seen whole or not at all, so the reader needs no checks ([The line file](#the-line-file)) |
| `refreshInterval: 1` | The command still runs only on Claude Code's triggers; the interval makes it run while the session is idle and while subagents work, so countdowns (and, after 0.1.0, the agent rows) stay current. 1 s is the docs' minimum |
| Only what the mod's events give; payload-only data is dropped | Reading the payload means parsing JSON in the reader, which brings back a real program per frame ([What VArgus cannot show](#what-vargus-cannot-show)) |
| 24-bit colour always, `NO_COLOR` to turn it off; no 256/16-colour fallback | On the dev machine tmux 3.5a reports the outer terminal supports RGB, while Claude Code's env has `TERM=tmux-256color` and no `COLORTERM`, so VantageHUD's detection picked 256 colours there (from its source). On a terminal without truecolor the colours are expected to be converted by tmux or the terminal, keeping the text readable (unverified; macOS Terminal.app before macOS 26 is the usual such terminal) ([Colours](#colours)) |
| A new repo; no code shared with VantageHUD | VantageHUD has no outside users to keep. A mod can import only its own files and `claude-code`, so VantageHUD's code could not be imported anyway |
| Port VantageHUD's rules, not its code | Each rule came from a bug; the code around it was built for a process per frame. Each ported rule comes with a test |
| 0.1.0's options are the fragment switches and a theme picker (default `graphite`); VantageHUD's other options are built in at their defaults | The maintainer's own VantageHUD config changes only the theme; fewer options to build and test. Custom themes, bar gauges and label overrides come later ([Config](#config)) |
| Feature defaults follow AGENTS.md | The maintainer chose default-on feature work across hosts; existing option defaults are documented under Config |
| The mod only observes: a hook on an engine event passes it on unchanged with `next(e)` | A status line has no reason to change or block what the engine and other mods do |
| Setup is done by the agent: the plugin ships a `vargus-setup` skill; README.md has the manual steps | A plugin cannot set `statusLine`, so the person's settings must be edited once; the agent does it from the skill's steps |
| The mod sits at the repo root, and the repo is its own marketplace; plugin name `vargus` | One repo to install from |

## Terms

| term | meaning |
|---|---|
| mod | a plugin whose `hooks/hooks.json` names a hooks module: code that stays loaded for the session |
| the host | Claude Code as the mod sees it: the events it raises and the `$` interface it hands each hook |
| the line | what VArgus shows: one or more rows of text with ANSI colours |
| line file | the file the mod writes the line to, one per session, replaced whole on each write ([The line file](#the-line-file)) |
| reader | the `statusLine` command: prints the session's line file ([The reader](#the-reader)) |
| fragment | one piece of the line: context %, limits, git, token counts |
| label | a word or mark the line shows beside a value (`ctx`, `token`, `+`); one table per language ([Languages](#languages)) |
| collector | code that turns events into values the renderer reads |
| renderer | a pure function from those values, the options and the width to the line's text |
| main loop, subagent, teammate, workflow agent | the session's own model loop; an agent the Agent tool starts; an Agent-tool agent that lives on as a team member; an agent a workflow script's `agent()` starts. Events tell them apart by `e.agentId` (absent on the main loop) |
| `$.state`, `$.store` | the host's per-session values (they survive a reload), and its cross-session JSON store |
| theme, token | a named palette, and one of its 10 hex colours |

## How it works

```
.claude-plugin/plugin.json       Claude manifest, userConfig and state contract
hooks/hooks.json                 points directly to ../src/hosts/claude/register.ts
src/hosts/claude/register.ts      Claude mod lifecycle and wiring
src/hosts/claude/collect/         Claude collectors, authentication and polling
src/hosts/claude/write.ts         Claude native line file
src/hosts/claude/paths.ts         pure Claude config/data path rules
src/hosts/claude/view/            existing /vargus pane
src/hosts/codex/                 Codex saved-log collection, view recognition, footer policy
src/cli/                        Node-side host/output wiring and standalone controller
src/core/                       shared readings, defaults and pure git parsers
src/options.ts                  shared options (defaults match userConfig)
src/render/                     shared fragment composition, text and width
src/theme/                      palettes and ANSI colour encoding
src/i18n/                       labels
src/outputs/ansi.ts             decode the renderer's SGR vocabulary
src/outputs/tmux/                tmux encoding, pane ownership and row lifecycle
src/cli.ts                      CLI dispatch
bin/vargus                      Bash symlink entry for the TypeScript CLI
types/index.d.ts                self-contained Claude $.state contract
tests/*.test.ts                 Claude engine and shared rendering tests
tests/node/*.test.mts            Node boundaries, Codex and tmux integration
skills/vargus-setup/SKILL.md     existing Claude inline setup
```

Collectors hear events and update values; the renderer turns them into text; the writer puts the
text in the line file. The reader prints it on Claude Code's next status-line run.

### Data sources

| Data | Source | Basis |
|---|---|---|
| Tokens per request, per agent (subagents, in-process teammates and workflow agents), counted from when this process loaded the mod or from the last clear/resume; a resumed session's earlier history is not in them, while `$.session.usage()` counts from its first launch | `turn.step` result `usage` ("as the API reported it"), `e.agentId`; `token:` sums `input_tokens + output_tokens`, main loop and subagents, as VantageHUD did (cache reads and writes left out: `ctx:` is the cache-inclusive gauge; `input_tokens` is the part neither read from nor written to the cache, so nothing counts twice) | types; measured (2.1.300): a subagent's steps, and an in-process teammate's (`agent.spawn` `isTeammate`) on both its first turn and one after a `SendMessage`, the line's `token:` equal to the sum; a workflow agent's two steps (`agent.spawn` `workflow`), main loop 1,850 + agent 298 = the line's `token:2.1k` |
| Context %, cost, session start, `five_hour`/`seven_day`/`spend_limit` | `$.session.usage()`; pushed by `session.measure` after each main-thread turn and when a limit window moves a whole point, and read after every main-loop `turn.step` (`e.agentId` absent) to set the context, plus the session start when it is unknown. A subagent's step does not read the main window. `/clear` and an in-session resume clear the context and start; a compaction that stands (`session.compact` with no `skip`, the main conversation, not `precompute`) clears the context alone. Until the next main step, `compactPending` keeps `session.measure` from restoring the old fill: the interactive probes still returned the pre-compact tokens when the compact hook resolved. Without a reading the line shows `ctx:0%`; each main response then supplies the latest fill, and there is no usage read on the tick. The session-start read stays, so a long conversation resumed with `claude --resume <id>` in a new process has its context and start before the first message (an in-session `/resume` not measured). The step timing is measured on 2.1.312, 2026-11-02, with a throwaway probe: in interactive and `-p` runs, immediately after every main `next(e)` in two-response turns, `usage().context.tokens` equalled that result's uncached + cache-read + cache-written input tokens (interactive 24,134 → 24,569 before compaction; headless 19,740 → 19,904). The interactive `/compact` emitted no `turn.step`; the next step's pre-request read had the window alone, and its two responses gave 27,907 → 28,075 tokens. Other surfaces are unchecked. VantageHUD avoided `ctx:0%` on a resumed conversation by working the percent out from the transcript | types; measured (2.1.301, 2026-10-16): the person resumed a long session and found `ctx:`, `session:` and the detail view's Context card right before the first message |
| Folder, model, effort | `$.session.cwd()` and `$.session.model()` on each tick (a `/model` switch raises no event but the classic `PostModelSwitch`, and classic hooks don't run where an organization manages Claude Code), `effort` on the main loop's `turn.step` input, so none shows before a session's first request. Not filled in earlier from settings and the model's default: the engine's order (model-config docs) also takes `--effort`, a session-only `/effort`, an organization default and caps, which a mod can't read | types, docs |
| Tool / agent / skill / workflow counts | the main loop's `tool.call` (no `e.agentId`): every call, `Agent`, `Skill`, and `Workflow` other than a resume; counted when the call is asked for, a refused one included, as VantageHUD counted the transcript's tool_use blocks. Not `agent.spawn`: it fires for each workflow agent too | types |
| Per-model weekly (`sn:`/`op:`/others), `extra:` | OAuth usage API via `$.http.fetch` + `$.session.authorize()`, cached in `$.store` per config folder (`CLAUDE_CONFIG_DIR`, which picks the login); the store is checked every 15 s and the API read when the cache's retry time has passed (90 s after a success, 2 min after a network or auth failure, the larger of the backoff and `Retry-After` after a 429). No read, and no cached numbers shown, when `authorize()` gives null or an API key (the endpoint is OAuth-only; checked before the cache, so another login's numbers can't show), or with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` set (the engine refuses a plugin's request carrying `auth`). Another process's `$.store.set` is seen here on the next check. Each `authorize()` mints a new handle and only the newest few stay valid, so the 15 s calls pile nothing up; the handle is spent at once | measured: HTTP 200 on the dev machine, where the API answers only through `HTTPS_PROXY` (2.1.300); two sessions writing one key each to `$.store` every second and reading the other's: 52 of 52 writes seen, 0.33-0.75 s later, then after a hot reload 77 of 79 (0.79-0.95 s; the two missed were overwritten before the next read) and 78 of 78 (0.07-0.22 s); 70 `authorize()` calls gave 70 distinct handles, of which the newest 4 still worked and the 5th-newest and older were refused ("unknown auth handle"), and the process's `VmRSS` (`/proc`) moved 337 to 339 MB over a 100-call burst (2.1.301) |
| Kimi Code `5h:` and `1m:` | Exact normalized `ANTHROPIC_BASE_URL` matches for `https://api.kimi.com/coding/` and `https://api.kimi.ai/coding/` (trailing slashes ignored) select the direct provider; no gateway or lookalike host inherits it. `GET` the matched host's fixed `/coding/v1/usages` URL with the existing `ANTHROPIC_AUTH_TOKEN`, else `ANTHROPIC_API_KEY`, as Bearer; never call `session.authorize()` or cache the token. Parse `usages.limit_5h` and `limit_month_total` (`used_ratio` × 100, `reset_time`), with the 300-minute `limits[]` count window (`used`, else `limit` - `remaining`) as the 5h fallback. The shared 90 s read, 15 s store check, retry/backoff and 15 min stale rules are reused; the cache key includes provider and `CLAUDE_CONFIG_DIR`. Every direct third-party provider deliberately bypasses `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`; the Anthropic OAuth path keeps its existing skip | Kimi 2.5.2's [usage parser](https://github.com/MoonshotAI/kimi-code/blob/1c142a007c10e881602690def96057c23a2baa12/packages/oauth/src/managed-usage.ts#L118-L136) names the same fields; live probe on the dev machine, 2026-11-10: HTTP 200, `limit_5h` 0.2453 and `limit_month_total` 0.1109 with reset times. The direct endpoint is [experimental](https://forum.moonshot.ai/t/error-code-429-were-receiving-too-many-requests-at-the-moment/191/7), so the pinned client and live response are the compatibility evidence |
| git | `$.session.repo()` (in a repo or not, and the remote URL: the push URL when one is set, where VantageHUD read the fetch URL), then `git rev-parse --absolute-git-dir` and `git status --porcelain=v2 --branch` with `GIT_OPTIONAL_LOCKS=0` (no `index.lock` against the person's own git) and `-c core.fsmonitor=false` (a repo's config could start a hook program or a daemon); the host runs git with repo hooks off. Detached-HEAD naming and the operation are read from files, the naming only with the `detachedHead` option on. Read at session start, after a file-changing tool (`Bash`, `Edit`, `Write`, `NotebookEdit`, `EnterWorktree`, `ExitWorktree`) returns, and every 5 s otherwise; each walk holds off the next for 10× its length (VantageHUD did so for walks of 1 s or more). `git status` took a median 2.7 ms on this repo (17 files) and 75.9 ms on a 9,227-file repo (git 2.47.3, 2026-10-15), so the 5 s poll costs about 1.5 % of a core on the larger | types; timing measured |
| svn | `svn --non-interactive info --xml` and `status --xml` (no `-u`), only when the folder is not in a git worktree; the working copy found by `.svn` upward from the resolved folder. Same 5 s poll and hold-off as git, where VantageHUD kept a 30 s memo checked against `wc.db`: a 510 ms walk (VantageHUD's figure for a 96k-file checkout) would cost about 9 % of a core | types; no svn on the dev machine: the XML in the tests is written to svn's documented shape, never run |
| Clock-driven fragments (countdowns, session time) | `$.clock.every(1000)`, which keeps running between turns (mods/api: "keeps running between turns and doesn't start one") | docs |

### When the line is written

- Collectors update values as events arrive; the mod renders on each `$.clock.every(1000)` tick
  and writes the file only when the text or the session id differs from what it last wrote (the
  id because after a resume the id can change a moment after the text did), and never for a
  session that ended ([The line file](#the-line-file)). Why: the reader runs every second
  anyway, and most ticks change nothing. So the shown line can lag the mod's values by up to
  about two seconds: up to one for the tick, and up to one for the reader's next run.
- The first write is started, not awaited, in `session.start`: the engine awaits the first
  `session.start` before the first prompt, and a slow or refused write must not hold it.
- Only an interactive session writes (`session.start`'s `isInteractive`). Why: `claude -p` and
  SDK runs load plugins too, show no status line, and would each leave a folder behind.
- The width is `e.viewport.columns` read by a `ui.render` hook on `PromptHint` that only
  observes (it returns `next(e)`): the host gives a width only to `ui.render` hooks. Measured
  (2.1.300): the hook ran on each resize, and its width matched the reader's `COLUMNS` at 80 and
  133 columns (both in fullscreen mode; the main screen is not measured). Until the first width
  arrives nothing is dropped. Fragments are dropped from the end, whole,
  when the row is too narrow. The line is one row. Claude Code's own
  notifications share the right side of the row (statusline docs), so the usable width is less
  than the terminal's.
- A fragment that throws costs only that fragment: the renderer catches it and leaves it out.
  Why: VantageHUD's rule ("Rendering must never throw to the user"); one bad value must not blank
  the line.

## Fragments

0.1.0 shows VantageHUD 0.6.0's fragments in its order (`DEFAULT_ELEMENT_ORDER.main` in
`src/hud/types.js`), joined by ` | `, each on or off by default as there, except `cache:`
(row 5). Each fragment and each
sub-option is a `userConfig` boolean.

| # | fragment | example | default | sub-options (default) |
|---|---|---|---|---|
| 1 | folder | `~/proj/VArgus` | on | |
| 2 | model | `opus:high` | on | effort (on) |
| 3 | rate limits | `5h:4%(4h37m) 7d:39%(5d6h)`; Kimi also `1m:11%(28d12h)` | on | spend limit (off), other models' weekly (off) |
| 4 | context | `ctx:20%` | on | |
| 5 | prompt cache | `cache:warm(14:30)` | not in 0.1.0 | |
| 6 | tokens | `token:69.5k` | on | |
| 7 | session time | `session:24m` | on | |
| 8 | call counts | `🔧73 🤖2 ⚡1` | on | workflow runs (off) |
| 9 | repo | `repo:VArgus` | on | |
| 10 | branch | `branch:main` | on | detached HEAD named (off) |
| 11 | working-tree status | `?4` | on | |

- Where VantageHUD read a value from the status-line payload, VArgus takes it from the host
  ([Data sources](#data-sources)). The spend limit loses its dollars ([What VArgus cannot
  show](#what-vargus-cannot-show)). `cache:` is left out (off by default in VantageHUD, so the
  default line is unchanged).
- git or svn fills 9-11, as in VantageHUD.

## Languages

0.1.0 shows English only. Every word or mark the line shows comes from a labels table, so a new
language touches no fragment.

- `src/i18n/en.ts` holds the English labels, one key each, and the `Labels` type is taken from
  it. The words are VantageHUD's (`ctx`, `token`, `session`, `cache`, `warm`, `cold`, `spend`,
  `CRITICAL`, `COMPRESS?`, `T`/`A`/`S`/`W`, the git status marks, the git operation names) plus
  what VantageHUD wrote straight into its fragments: `repo`, `branch`, `(wt:`, `extra`, the
  window names (`5h`, `7d`, `sn`, `op`, ...), the `@` before a detached commit or an svn
  revision, and the usage API's `[API 429]`, `[API auth]`, `[API err]`.
- A language is one file, `src/i18n/<tag>.ts`, exporting an object typed `Labels`, and one line
  in `src/i18n/index.ts`. `en` is a plain object (not `as const`) and `type Labels =
  Record<keyof typeof en, string>`, so `tsc` fails while a key is missing (checked with tsc 5.9.3
  `--strict`; with `as const` every translation fails instead).
- `resolveLabels(tag)` looks the tag up in a registry with a null prototype, by own property, and
  falls back to English for an unknown tag. Why: VantageHUD's rule for its theme registry, so a
  tag such as `constructor` finds nothing.
- Fragments take the labels as an argument and hold no display words of their own. Numbers,
  units (`4h37m`, `69.5k`), emoji and the ` | ` separator are the same in every language, as in
  VantageHUD's zh-CN.
- No language option in 0.1.0. It comes with the second language: a `userConfig` string with
  `options`, default `en`, so no one's line changes.
- A label may hold wide characters; the line is fitted by columns ([Rules carried over from
  VantageHUD](#rules-carried-over-from-vantagehud), Width).
- Test: every fragment rendered with a test table whose labels are `⟦<key>⟧` must show only those
  for its words, which catches a word written straight into a fragment.

## The detail view

`/vargus` opens a pane with what does not fit the line, and closes it again. Off by default: the
`detailView` option registers the command and every hook below.

- **A pane, opened by the person.** `$.ui.open({ id: 'vargus', closeOnEscape: true })` from the
  command; `/vargus` again, Esc (with the pane focused, or at an idle empty prompt) or the
  engine's close mark closes it. The engine places it: docked beside the transcript in the
  fullscreen layout from 110 columns, else inline above the prompt (measured, 2.1.301: docked at
  160 columns with 71 body columns, inline at 80). Why on request only: the band above the prompt
  was turned down as always-on UI (2026-10-14); a pane opened by a command shows only while
  wanted. The command answers no text: a text row would also reach the model.
- **Live.** While the pane is open, the mod's 1 s tick calls `$.ui.invalidate('ui.render')`; a
  `ui.close` hook (every close passes it: the command's, Esc, the mark, an unload) stops that.
  Measured (a throwaway pane, 2.1.301): its render counter rose about once a second (4, then 13
  at a capture about 9 s later). A hot reload finds the pane in
  `$.ui.panes()` and keeps redrawing it.
- **Cards.** Round-bordered boxes in the theme's `sep` colour, each row one `Text` of coloured
  runs, sized to the pane's `bodyColumns`. Every row and title is cut to its card by the model
  (the run that crosses the edge ends in `…`), so none relies on the surface's own truncation:
  - header (no card): folder, model and effort, session time, call counts, as on the line;
    whole parts dropped from the end when it is too wide, as the line drops fragments, then the
    folder cut;
  - **Limits**: every window the engine and the usage API give, without the line's thresholds
    and switches (`sn:` under 80 %, other models' weekly, the spend limit unclamped, `extra:`
    with its dollars); a gauge, the percent in its tier colour, the reset as local clock time
    (`14:20` today, `Sat 21:00` within six days, so a weekday never names the day a week out, `10-30
    00:00` beyond; the mod's `Date` is the
    machine's local time, measured UTC+8 on the dev machine, 2.1.301) and the countdown. Narrow,
    the reset column drops `resets`, then the clock, before the gauge goes under 12 cells. A
    stale API read: `*` and a note with its age; past 15 min the line's error mark;
  - **Context**: a gauge whose track is tinted from 80 % (`COMPRESS?`) and 85 % (`CRITICAL`), so
    the thresholds show before the fill reaches them; the tokens in use over the window (the host's
    `context.tokens` and `window`); before the first response 0 % over the window, as the line's
    `ctx:0%`;
  - **Tokens**: one row per agent, the main loop first, then by input + output, largest first,
    six at most and `+n more`; uncached in, out, cache read, cache write (the last two dropped
    in a card under 66 columns); a total row. The same `turn.step` usage as `token:`, so while
    the option has been on for the whole span the total's in + out is the line's count; turned
    on mid-session, the list starts then and the total is lower. Names from `agent.spawn`: the
    call's `name`, the teammate's name, else the agent type, with the call's description dimmed;
    an agent started before the mod loaded shows as `?`. Past 64 agents the rest sum into one
    `others` row, which keeps the last shown place. Kept in `$.state` beside the counts, so a hot
    reload keeps it; `/clear` and a resume start it over. Each save of the list carries the counts'
    token count of that moment, and at `session.start` the list is taken back only when that
    equals the restored count: with the option off the list is neither kept nor cleared, so after
    a `/clear` with the option off it would be an earlier conversation's. A list started
    mid-session is kept across reloads; a reload between the two saves of one step drops it,
    rarely;
  - **Git** or **SVN**: ahead/behind first, then the branch (worktree and detached-HEAD naming
    as on the line), so a long branch is cut at the row's end and never them; the counts in words
    (`clean` when none), wrapped onto a second row rather than cut; the first 8 changed paths with their marks
    (the path's end kept when it is cut) and `+n more`. Read from the same `git status` and `svn
    status --xml` output as the counts, by a second pass that never changes them; git prints a
    path with unusual characters in C-style quotes, and it is shown so.
  - Side by side, Context and Tokens from 100 body columns, Tokens at least 66 wide (its four
    columns) and Context the rest. The docked pane does not reach it: it stayed 89 body columns
    wide at 240, 280 and 320 terminal columns (measured, 2.1.301); an inline pane at 100-109
    columns or the main screen gets it (seen inline at 109).
  - An inline pane is held to a height by the engine: at 80x48 only Limits and Context showed,
    at 80x30 Limits and the top of Context (measured, 2.1.301); the cards' order decides what is
    left out.
- **Colours** from the theme as `#rrggbb`, which the terminal converts (`tmux-256color` gave
  256-colour codes); with `NO_COLOR` no colour prop at all. Every word comes from the labels.
- **The hooks**: `agent.spawn` and `ui.close` only observe; `command.run` answers its own command
  (registered and matched by the literal name `vargus`, which `claude plugin validate` needs to
  report "answers its own command" rather than a gating hook); the `Pane` render hook draws only
  its own pane. Validate lists `agent.spawn` and `ui.close` as gating hooks without `.catch`:
  neither guards anything, and a throwing one is skipped, which leaves the engine's own behaviour
  (the spawn's answer stands, the close goes ahead).
- `$.command.register` and `$.ui.panes()` at `session.start` are caught: a refusal costs the view,
  never the line's tick started after them.
- Turning the option on or off in `/config` reloads the module (reference.md: "a change there
  reloads the module with the new `options`"); what a reload does to an open pane is not
  measured.

## The line file

- One folder per session: `<data>/<session id>/line`, where `<data>` is the plugin's data folder,
  `vargus-vargus` (plugin `vargus` from marketplace `vargus`, the `name` in the repo's own
  `marketplace.json`). Why: that folder survives plugin updates, while the plugin's install folder
  changes with each version (plugins/components docs). The mod builds the path as
  `$CLAUDE_CONFIG_DIR`, else `$HOME/.claude`, then `/plugins/data/vargus-vargus`, reading both with
  `$.env.get` (`$.fs` does not expand `~`; the mod's env has no `CLAUDE_PLUGIN_DATA`). On Windows
  (`USERPROFILE` a drive path and `HOME` not a `/` path: WSL can pass the Windows `USERPROFILE`
  through beside its own `HOME`) the home is `USERPROFILE`: measured with
  `HOME=D:\h` set, Claude Code kept its config and plugin data under `C:\Users\<name>\.claude`,
  and a mod that took `HOME` wrote `D:\h\.claude\...`, so the row stayed blank. Started from
  PowerShell `HOME` is unset; Git Bash hands it on as `C:\Users\...`. A drive path (`C:\...`,
  `C:/...`) counts as absolute and is written with `/` (measured: the line landed where the
  skill's `${CLAUDE_PLUGIN_DATA}` named, started from PowerShell and from Git Bash). Measured
  (2.1.300, a throwaway plugin installed from a local directory marketplace): the skill's
  `${CLAUDE_PLUGIN_DATA}` named the path the mod built, with and without `CLAUDE_CONFIG_DIR` set;
  the folder did not exist until the mod's first `$.fs.write`, which created it and the session
  folder beneath; uninstalling deleted it. Under `--plugin-dir` the skill's
  `${CLAUDE_PLUGIN_DATA}` named `<plugin>-inline` (measured, 2.1.300), so a reader set up for the
  installed plugin shows nothing while developing against the folder.
- The session id is re-read with `$.session.id()` on every write, never kept from the start. Why:
  `/clear` and an in-session resume go on under a new session id with no `session.start` (types,
  `SessionEndInput`). At `session.end` with reason `clear` or `resume` ("another took its place")
  the mod also starts its own counts over, as `$.session.usage()` does at `/clear`. The counts live
  in `$.state`, so a hot reload keeps them (the types say so; a lost worker is not stated,
  [Unsettled](#unsettled) 1). The reader keys on `CLAUDE_CODE_SESSION_ID`; both sides use the id as
  given, and the mod writes nothing for an empty id. Measured (2.1.300, a second session driven in
  tmux): the reader's `CLAUDE_CODE_SESSION_ID` and the payload's `session_id` agreed in all 618
  reader runs (212 of them the two probe sessions', 148 of those the one with the `/clear` and
  `/resume`), and the mod's `$.session.id()` moved to the same ids at the start, a `/clear` and an
  in-session `/resume`. In the one resume measured, `$.session.id()` still gave the cleared
  session's id at the new session's start event; the mod's 1 s tick saw the change 0.75 s later, and
  the reader's first run under the new id came 0.56 s after the start event. A write between the
  start event and the tick is skipped, since the id is the ended session's (the `session.end`
  bullet below), and the next write goes to the new id's folder because the id changed ([When
  the line is written](#when-the-line-is-written)). The mod's env has no
  `CLAUDE_CODE_SESSION_ID`. Why it matters: VantageHUD once keyed its cache on a variable
  Claude Code doesn't export, so concurrent sessions shared one file and `ctx:` dropped to 0%.
- Each write goes to `line.<t>.tmp` in the same folder, then `$.process.run(['mv', '-f', <tmp>,
  <line>])` puts it in place; on Windows (a drive-letter data folder) `cmd /d /c move /y` with `\`
  separators (`mv` is on the `PATH` only when Claude Code was started from Git Bash;
  [Scope](#scope)). `/d` skips cmd's AutoRun, for the same reason git runs with
  `core.fsmonitor=false`: no program the person configured runs. The runtime quotes only an
  argument with a space, so cmd would act on `&` (measured: `a&b.tmp` ran `b.tmp` as a command),
  `,` `;` `=` (argument separators), `^`, `%` and `!`: `rmdir /s /q D:\R&D\...` would remove
  `D:\R`. A path holding any of `&^%!,;=()"<>|` (in the data folder or the session id) gets no
  cmd command: the line is written in place with no temp file, and nothing is removed. `<t>` is
  `$.clock.now()` taken at `session.start`, so each loaded copy of the mod (after a hot reload,
  or a second process on the session) has its own temp file. Why:
  `$.fs.write` is not atomic ("it replaces the file's content in place, so another process can read
  a partly written file", mods/reference) and `$.fs` has no rename; `mv` within one folder is a
  rename, which a reader sees whole or not at all. Measured in a live session (2.1.299, tmpfs, a
  reader in a tight loop, 2026-10-15): writing the line file directly gave 36 and 41 wrong reads (in
  74,075 and 50,861, over 2,000 back-to-back writes each), among them an old line's start joined to
  the next line's end, which an end marker would pass; temp file + `mv` gave 0 wrong in 265,248 and
  268,098 reads (2,000 back-to-back writes each) and 207,086 reads (300 writes 10 ms apart), and no
  missing file once the first line was in place (counted in the second run). `mv` took 2-3 ms in the
  median (95th percentile 3-4 ms, max 53 ms); `$.fs.write` 0-1 ms.
- Within one loaded copy, one write-and-`mv` runs at a time; a newer text waiting replaces an
  older one. Why: two writes sharing a temp file could put a half-written one in place. A copy
  replaced by a hot reload may still have a write in flight; with its own temp file, the worst
  case is one older line put in place, which stays until the line's text next changes (within a
  minute while `session:` or a countdown is shown).
- A temp file left by a copy replaced mid-write stays until the folder is removed at
  `session.end`; one left by a crash goes with its folder in the age prune below.
- If `mv` fails (an organization hook refuses the process, say), the mod writes `line` directly;
  a read can then catch a half-written line for one run.
- Two Claude Code processes on one session (`claude --resume <id>` in a second window while the
  first runs) share the id, so both write the same file and both windows show whichever wrote
  last. Measured (2.1.300): the second process's `$.session.id()` was the first's; in 20 s of
  reads the file held the second's line 355 times and the first's 43 times, and both rows showed
  the second's (`session:0m`, no `token:`). Left so: the reader has only the session id to key on.
- `mv` on the real data folder's disk (ext4) against tmpfs, in one run from Python (300 each,
  2026-10-15): median 1.28 against 1.26 ms, 95th percentile 2.11 against 1.57 ms.
- At `session.end` (any reason) the mod removes the ending session's folder with
  `$.process.run(['rm', '-rf', '--', <data>/<id>])` (on Windows `cmd /d /c rmdir /s /q`, as for
  the move above), since `$.fs` has no delete: after a write
  in flight finishes, and only for an id that is a plain name (letters, digits, `_`, `-`) and
  a data folder that is an absolute path. It writes no more for that id until another session
  ends in this process: after a resume `$.session.id()` can still give it (0.75 s in the one
  resume measured). The hook's bound is 1.5 s by default for every hook and core (types,
  `SessionEndInput`); `rm` of a session folder took 0.96 ms median, 4.0 ms at most (300 runs
  from Python on the ext4 home, 2026-10-15). Measured (2.1.300,
  a session in tmux): the folder went at `/clear` (the old id's), `/exit`, a SIGHUP, and the
  exit of a `claude --resume` of an older session. Two processes on one session: the one that
  ends removes the other's line until its text next changes.
- A session that ends without the hook (a crash, SIGKILL) leaves its folder; at each interactive
  `session.start` (a hot reload included), not awaited, the mod removes such folders once idle 14
  days (VantageHUD's age, without its once-a-day throttle): idle by the newest file in the folder
  (the line or a temp file), else the folder's own time. Only folders named like a session id (the
  same plain-name rule), never through a link, never the current session's (under
  `claude --resume <id>`, `$.session.id()` was already that id at `session.start`, measured once on
  2.1.300, in a second window on a session another process still ran; `--continue` and the bare
  picker not measured; an in-session `/resume` fires no `session.start`); VantageHUD guarded its
  prune with a marker file, while this data folder is the plugin's own. A session left open whose
  line has not changed for 14 days loses its file until its text next changes. Measured (2.1.300): a
  session start removed a session-id-shaped folder whose `line` was 20 days old and kept one 13 days
  old and the 9 real folders of that day.

## The reader

The `statusLine` entry in the person's settings, with `refreshInterval: 1`:

```sh
cat "<data>/$CLAUDE_CODE_SESSION_ID/line" 2>/dev/null
```

- `<data>` is written in by the setup skill as an absolute path: the plugin's path variables,
  `${CLAUDE_PLUGIN_DATA}` among them, are substituted in a skill's content (plugins/components
  docs), so the skill hands the agent the real folder.
- One `cat`: 2-3 ms a run as Claude Code runs it, in a shell.
- The mod replaces the file whole ([The line file](#the-line-file)), so a read shows a whole line,
  except in the direct-write fallback there. When the file is missing `cat` exits 1 and the row is
  blank for that run.
- A mod that wrote and then stopped leaves its last line on screen with frozen numbers. Measured
  (2.1.300, a renamed dev copy under `--plugin-dir` with the installed plugin off for that
  session): a broken module picked up by hot reload left the old copy running ("reload failed,
  the previous version stays loaded"), but `/reload-plugins` dropped it ("hooks module did not
  load", 0 hooks); the file's time stopped and three minutes later the row still read
  `session:2m` with the `5h:` countdown stuck. Turning the plugin off mid-session is expected to
  do the same (not measured); a lost worker is [Unsettled](#unsettled) 1.
- The `blankStopped` option (off by default) handles it: the mod rewrites an unchanged line every
  30 s, and setup writes a second reader that prints the file only while it is under two minutes
  old:

  ```sh
  f="<data>/$CLAUDE_CODE_SESSION_ID/line"; [ -n "$(find "$f" -mmin -2 2>/dev/null)" ] && cat "$f"
  ```

  Why `find -mmin`: not POSIX, but GNU, BSD and busybox `find` all have it, where reading a file's
  time differs (`stat -c` against `stat -f`) and a time inside the file would show as a second row
  under the plain `cat`. GNU find compares the exact age (measured: shown at 110 s, blank at 125 s);
  BSD find rounds it up to whole minutes, so there the cutoff is one minute (its man page, not run),
  still twice the heartbeat. Cost (dash, 200 runs each, 2026-10-15): 3.41 ms median against 1.88 ms
  for the plain `cat`; bash 5.00 against 2.66 ms. The flag on with the plain reader still installed
  costs one `mv` every 30 s and blanks nothing; the reverse, the option off with this reader left,
  blanks a live line once it has not changed for two minutes (with `session:` and the countdowns
  hidden), so turning it off also means setting up again. The skill picks the reader from
  `pluginConfigs["vargus@vargus"].options.blankStopped` in the user settings, where Claude Code
  stores the option (an option set in managed settings is not seen there).
- It never reads stdin: the payload is not used ([The line file](#the-line-file) measured
  `CLAUDE_CODE_SESSION_ID` against it).

## Setup

- The plugin ships a `vargus-setup` skill. Asked to set up the VArgus status line, the agent
  follows it: show the current `statusLine` entry, if any, and ask before replacing it; write the
  reader with `refreshInterval: 1`; tell the person the line shows from the next status-line run.
  The same skill removes the entry before an uninstall.
- The reader goes where the plugin runs. Installed at user scope, the skill writes it into the user
  settings. Installed only at project or local scope (scope and project from `claude plugin list
  --json`), the mod writes no line elsewhere, so a reader in the user settings would leave the row
  blank in every other project (the same mechanism as on 2026-10-15, when a project-local reader
  blanked a session that hadn't loaded the plugin): the skill offers a user-scope install or the
  reader in that project's `.claude/settings.local.json`, never the committed
  `.claude/settings.json`, since the reader names a folder in one person's home. The mod's folder is
  fixed at `vargus-vargus`, so installed from a marketplace with another name the reader would name
  a folder the mod never writes: the skill says so and stops.
- Uninstalling deletes the plugin's data folder by default (plugins/manifest-reference), so a
  reader left in settings shows a blank row from then on: the `statusLine` entry goes first.
- A project's `statusLine` replaces the person's: measured on 2.1.300 for
  `.claude/settings.local.json`, where a session already running switched to the project's entry;
  project settings outrank user settings, so `.claude/settings.json` does too. When it writes the
  user settings, the skill checks both and says so when it finds one.
- README.md holds the same steps for doing it by hand.

## The host

- **Lifecycle**: module variables are shared by the module's hooks but lost on hot reload (and on
  a lost worker), so in-memory values start over; `$.state` (session) survives a reload,
  `$.store` (cross-session JSON, 4 MiB) too. A reload runs `register` and `session.start` again.
- **Develop against the folder** (`--plugin-dir`, or the mods folder with hot reload): a plugin
  installed from a git marketplace is a cached copy keyed by version, so edits reach it only after
  a version bump. One installed from a local directory marketplace runs from that folder
  (`$.plugin.root`); an edit reaches a running session at `/reload-plugins`, not before, and a new
  session runs the folder's code also after its version moved past the installed one (recorded
  0.1.0, folder 0.1.1; measured on 2.1.300).
- **`userConfig`**: flat fields, `type` one of `string`, `number`, `boolean`, `directory`,
  `file`; `options` gives a picker (≥ 2.1.271; older versions can't load the plugin at all);
  each option is a `/config` row (≥ 2.1.269) except `sensitive` and `multiple`; unknown keys fail
  validation.
- **Files**: `$.fs` has `read`, `write`, `list`, `exists`, `stat`, `ancestors` (no delete, no
  rename); `write` is not atomic (hence the temp file and `mv`, [The line file](#the-line-file)); an
  absolute path is used as given, up to 4 MiB a call. A mod
  writes anywhere the user can, though an organization's `fs.write` hook can observe or refuse it
  (mods/admin).
- **Processes**: `$.process.run` takes argv (no shell), 30 s default / 10 min max, 4 MiB stdout
  kept (`isStdoutTruncated`), children inherit the env; "CLI only" (types). There is no svn
  helper.
- **Network**: `$.http.fetch`, 30 s and 4 MiB a call, at most 5 redirects; an organization policy
  that blocks WebFetch blocks it too (mods/admin).
- **Modules**: `.ts`, `.tsx`, `.jsx`, `.js`, `.mjs`, `.cjs`, `.mts` or `.cts`, ES modules; imports
  only the mod's own files and `claude-code` (probed with `claude plugin validate` on 2.1.296 and
  2.1.299).
- **How `claude plugin validate` reads a module** (2.1.300): "$ is always spelled
  $.noun.event(...) at the call site, on is always on("<event>", hook)". So it refuses an `on()`
  whose event is not a string literal, `const s = $.session`, `const { session } = $`, `$[k]`,
  `const p = $.plugin` (`$.plugin.name` and `.root` pass), and `$` passed to a function that is
  neither top-level in the module nor imported from the mod's own files. A `turn.step` hook must
  be an async generator (`async function* ($, e, next)`, `yield* next(e)`), since `turn.step`
  streams.
- **Classic hook events** (`classic.<Event>`) do not run in a plugin a person installs where an
  organization manages Claude Code (`claude plugin validate`, 2.1.300). VArgus hooks none.
- **Marketplace**: `.claude-plugin/marketplace.json` with `source: "./"` makes the repo its own
  marketplace.

## Config

- Flags and simple values are `userConfig` fields in `.claude-plugin/plugin.json`: shown in
  `/config`, stored under `pluginConfigs`. AGENTS.md defines the feature-default
  policy for every host and shared feature; the defaults below describe existing options.
- 0.1.0's options: one boolean per fragment and sub-option ([Fragments](#fragments)), and
  `theme`, a picker (`options`) of VantageHUD's five palettes (`aurora`, `ember`, `nebula`,
  `graphite`, `daylight`), default `graphite`.
- `blankStopped` (0.1.3, off): the heartbeat write and the second reader
  ([The reader](#the-reader)).
- `detailView` (0.2.0, off): the `/vargus` pane ([The detail view](#the-detail-view)).
- Built in at VantageHUD's defaults: the short model name (`opus`); call counts as emoji (`🔧73`), as
  text (`T:73`) on WSL, as VantageHUD's `auto` did (WSL: `WSLENV` set, or `/proc/version` containing
  "microsoft", read with `$.env.get` and `$.fs.read`); the context thresholds 70 / 80 / 85 % and the
  Sonnet weekly shown from 80 %; the usage API read every 90 s; `ctx:` and the limits as
  percentages, never bar gauges.
- A line too long for the row loses whole fragments from the end ([When the line is
  written](#when-the-line-is-written)), where VantageHUD cut it with `...` when it knew the width.

## Colours

- Every colour is a theme token written as a 24-bit SGR sequence (`ESC[38;2;r;g;bm`).
- `NO_COLOR` set and non-empty in the mod's env: no colour codes at all (no-color.org).
- Every fragment's text has control characters (C0, C1, DEL), ESC included, replaced with `?`
  before the colour codes go on. VantageHUD's `cleanText` (`sanitize.js`, used by `render.js`)
  does this for outside text, while its per-fragment rule keeps ESC; VArgus is stricter because
  only the theme code adds escapes. Why: an escape in a repo path or
  branch would reach the terminal through the status line; `?` shows that something was there.
- The line holds no escape sequence but SGR colour codes, and plain spaces. VantageHUD's
  `safeMode` (oh-my-claudecode#346) is not needed: it stripped non-colour escapes (done above, more
  strictly), swapped the bar gauges' block glyphs for ASCII (no bar gauges in 0.1.0), trimmed
  trailing spaces, and kept the plain spaces that VantageHUD otherwise turned into non-breaking
  ones. The statusline docs still
  warn that escape codes can garble a multi-line line.

## Rules carried over from VantageHUD

Each came from a bug in VantageHUD 0.6.0 (github.com/zhoufanscut/VantageHUD); the file named is
where the rule and its reason live there. Read it before reimplementing; port the rule and a test
for it, not the code.

- **Themes** (`src/hud/themes.js`; AGENTS.md "Adding or changing a theme"): 10 hex tokens. For
  custom themes, after 0.1.0: `base` defaults to the theme's own name when it shadows a bundled
  one; a `base` cycle falls back to the bundled palette; a malformed value keeps the inherited
  colour; registry with a null prototype and own-property lookups; keys case-insensitive, `base`
  included. Its 256/16-colour
  measurements are not carried over ([Colours](#colours)).
- **Usage API** (`src/hud/usage-api.js`): never refresh OAuth tokens — refresh tokens are
  single-use, so a refresh revokes Claude Code's own token and forces a re-login
  (anthropics/claude-code#42603, closed "not planned"); 401 → `auth` error (VantageHUD kept a
  fingerprint of the rejected token so a new login retried at once; the Anthropic OAuth path never
  sees the token, so VArgus retries after 2 min, and `[API auth]` can outlast a re-login by up to 2 min 15 s); 403 is
  `network` (region block), not auth; 429 honours a numeric `Retry-After` (capped at 1 h); per-model
  weekly caps come from `limits[]` entries of kind `weekly_scoped` (the flat
  `seven_day_opus`/`seven_day_sonnet` are null); skip the Anthropic OAuth call when
  `ANTHROPIC_BASE_URL` is a non-Anthropic gateway or Bedrock/Vertex/Foundry is on. Exact Kimi
  coding matches instead use the direct provider in [Data sources](#data-sources). Only per-model
  weekly and `extra:` need the Anthropic API; the engine gives its other windows.
- **Usage cache and staleness** (`src/hud/usage-api.js`, AGENTS.md "Usage/rate-limit data"): one
  cache per provider and account (keyed by provider and `CLAUDE_CONFIG_DIR`, which picks the credentials), because one shared
  file once showed one account's numbers in another account's session; after a failed refresh the
  last numbers stay marked stale (`*`) for up to 15 min (`MAX_STALE_DATA_MS`), then the error
  shows; never mark the engine's own fresh numbers stale.
- **Limits display** (`src/hud/elements/limits.js`): a window past its `resets_at` is not drawn
  (`hasReset`); a window with no reset time is kept; spend limit as `spend:63%(25d3h)`, percent
  not clamped. The dollars VantageHUD showed (`($314.12/$500.00)`) come from the payload only.
- **svn** (`src/hud/elements/svn.js`): `svn status --xml --non-interactive`, no `-u`; count both
  the `item` and `props` columns (mapping in AGENTS.md); a large status needs the output limit in
  mind (`$.process.run` keeps 4 MiB).
- **git** (`src/hud/elements/git.js`, `src/lib/worktree-paths.js`): detached-HEAD naming read from
  files (`getDetachedHead`). Not carried: the symlinked-cwd root spelling (`onGivenPath`), which
  mapped a resolved root back to the payload's `cwd`; on 2.1.300 the engine resolves the cwd
  itself (its header, the payload's `cwd`, `$.session.cwd()`), so there is no link spelling to
  map to but the launch-time `PWD`, which goes stale after a `cd`. Nor its folder shown as the
  repo root (`resolveToWorktreeRoot`): the folder fragment shows the session's own folder, a
  subfolder included. `$.session.repo()`
  answers whether the folder is in a repo and the remote URL; its `root` is the main working
  tree's even in a linked worktree, so git still runs for the worktree and the branch.
- **Width** (`src/lib/string-width.js`): a wide (East Asian) character or an emoji takes two
  columns; fit the line by that count, not by string length.
- **Cost**: the old payload's cost was non-zero on a Max plan: it is the list-price equivalent,
  not a charge. Label it so.
- **Labels** (`DEFAULT_HUD_LABELS` in `src/hud/types.js`): the English words. `repo`, `branch`,
  the window names and `@` are written straight into VantageHUD's fragments; in VArgus they are
  labels too ([Languages](#languages)). Its zh-CN set is not in 0.1.0.

## What VArgus cannot show

- Data only the status-line payload carries: `prompt_cache` as the payload gives it, lines added
  and removed, PR state, `session_name`, `workspace`, API and wall
  durations, and the spend limit's dollars (`$.session.usage()` rate limits carry only `kind`,
  `percentUsed`, `resetsAt`). Dropped in 0.1.0; re-check what mod events carry before calling any
  of these lost (`turn.step` usage has the cache read and write tokens per request).
- `cache:` (VantageHUD's prompt-cache fragment), left out of 0.1.0 by the maintainer's choice.
  `turn.step` usage has the cache read and write tokens, but saying when the cache goes cold
  needs its lifetime (5 min or 1 h). No mod event reports it outside a model switch
  (`classic.PreModelSwitch`'s `cache_ttl`, `1h` on the dev machine on 2.1.300); `ModelUsage` has
  no lifetime split (2.1.300 added one to the OpenTelemetry `api_request` event only). A mod
  could work it out from `$.settings.read()` (`promptCacheTtl`, CHANGELOG 2.1.243), the env
  (`ENABLE_PROMPT_CACHING_1H`, `FORCE_PROMPT_CACHING_5M`, 2.1.108) and the plan (1 h for
  subscribers, CHANGELOG 2.1.108), but that copies the engine's rule, which can change.
- From the usage API, VantageHUD also read `extra:` in its `used_credits`/`monthly_limit` form,
  off an Enterprise plan only; a mod can't read the plan (`$.session.identity()` answers only a
  mod that managed settings install), so VArgus reads the `limit_usd`/`spent_usd` form alone,
  and shows no `extra:` when `used_credits` is present (VantageHUD's rule for an unknown plan).
  For Anthropic, `5h:`/`7d:` come only from the engine: until its first reading in a session they
  are absent, where VantageHUD fell back to the API. Kimi's direct `5h:`/`1m:` readings are the
  provider exception described in [Data sources](#data-sources).
- Teammates running in their own tmux pane: each "runs no loop here", so their requests are not
  seen.
- The old payload's `cost.total_cost_usd` included teammates; whether `$.session.usage().cost`
  does is not measured. VArgus shows no cost, so it matters only if a cost fragment is added.

## Unsettled

What the types and docs alone can't settle and no live session has settled yet for
the Claude mod. A throwaway mod run in a live session settles each.

1. Whether `$.state` survives a lost worker, as it survives a hot reload.

## Tests

- `npm ci` installs development/test tools only. `npm test`
  type-checks the Node graph and runs `.test.mts` files directly in Node: boundary, protocol/log,
  real app-server/localhost mock-provider turns and isolated tmux lifecycle tests.
  Standalone tests copy source, the Bash entry and package metadata without `dist` or
  `node_modules`; legacy-worker and reload probes change the copied `.ts` files.
  Standalone and sibling-view command helpers require the current shell marker's
  native completion footer and an idle activity indicator before sending another control.
  Daemon-heavy Node cases run serially to bound resource use.
  On Windows, `tests/node/run.mjs` reports and excludes POSIX executable-shim and
  Linux engine rigs, runs the shared checks and `windows.test.mts`, and skips
  the Bash symlink and POSIX metadata-shim cases. The boundary traversal and
  file URL fixture normalize native paths; saved transcript comparisons use
  the canonical path, including Windows short-name expansion.
- `npm run test:claude` runs the existing Claude checks listed below. In this development
  environment the engine test workers require execution outside the restricted sandbox; the
  unchanged baseline failed inside and passed outside.

- `claude plugin validate .` reads the manifest and the module as the engine will, and reports
  what the engine would refuse.
- `tsc -p .` type-checks against the types the engine writes into `.claude-plugin/types/`
  (gitignored by the engine's own `.gitignore` there). The engine writes them only for a folder
  it watches: start `claude --plugin-dir .` once per Claude Code release.
- `claude plugin test .` runs the `*.test.ts` files: the renderer's output for given values and
  widths, the writer's file, and each rule in [Rules carried over from
  VantageHUD](#rules-carried-over-from-vantagehud). A test has no files, network or processes: the
  writer's tests drive the mod through `$.session.start` and answer its calls with hooks of their
  own beneath it (`fs.write`, `fs.list`, `fs.stat`, `process.run`, `session.id`), each returning
  `{ value }`, and end it through `$.session.end` with a `session.end` hook beneath.
- `sh tests/manifest.test.sh` checks that `userConfig` in plugin.json has the keys and defaults of
  `src/options.ts`.
- `sh tests/reader.test.sh` runs the reader as `sh -c` and `bash -c` against line files it
  writes (present, missing, empty id), and checks that the setup skill and README.md carry the
  same command.
- Development loop: install from the working copy (`claude plugin marketplace add --scope local
  .`, `claude plugin install --scope local vargus@vargus`); a directory marketplace runs from the
  folder, so `/reload-plugins` picks up edits, and the data folder is the real `vargus-vargus`.
  The reader goes in `.claude/settings.local.json` (gitignored).
- The fragment order and each fragment's default match [Fragments](#fragments).
- The detail view: `tests/view.test.ts` checks the cards from given values (every row, title and
  the header within its box at 20, 40, 71, 76 and 140 columns, long branch, worktree and folder
  included; no colour with `NO_COLOR`; every word from the labels), the changed-path parsers and
  the agents list's restore rule; `tests/view-register.test.ts` drives the wiring (off: no command; on:
  `/vargus` opens and closes the pane, redraws each second while open, agents' tokens reach it).
- The labels test in [Languages](#languages).

## Rules for the code

- In the Claude mod graph, import only the mod's own files, by relative path, and `claude-code`: the engine refuses
  anything else.
- Hooks observe: a hook on an engine event passes it on with `next(e)` and changes nothing.
- `src/hosts/claude/register.ts` holds every hook, one per event, and calls each area's exported functions
  from it: `claude plugin validate` refuses a second `on('<event>')` without a matcher anywhere in
  the module ("registered twice without a matcher", 2.1.300).
- The renderer is pure; all I/O (`$.process`, `$.fs`, `$.http`) happens in collectors and the
  writer. A throwing fragment is left out, never the line.
- Run programs with `$.process.run` and an argument list; never a shell.
- Colours come only from the theme's tokens; control characters in a fragment become `?`.
- The mod writes only inside its data folder.
- Never refresh an OAuth token; the Anthropic usage API is read with `$.session.authorize()` alone.
  Direct third-party providers instead use the existing environment credential after an exact URL match.
- Comment the reason for anything that isn't obvious.
- When a design decision changes, update this file in the same commit, in place.

## Not in this version

Later:

- Custom themes, in a JSON file that a `file` option names (`userConfig` fields are flat, so
  nested themes can't live there); bar gauges (`useBars`); VantageHUD's other options, built in
  for 0.1.0 ([Config](#config)).
- Languages other than English (VantageHUD had zh-CN), and per-label overrides (VantageHUD's
  `labels` config).

Not planned for the Claude integration: payload-only data in the line; additional UI
beyond the inline status line and `/vargus` pane; seeing
teammates that run in their own tmux pane; a live-agents row (`agents: reviewer running 1m17s
8.2k | Explore done 9.2k`), since Claude Code lists each running agent under the prompt with what
it is doing, its time and its tokens (seen on 2.1.300: `◯ Explore  Grepping labels.test.ts for
fragment cases  40s · ↓ 29.2k tokens`).
