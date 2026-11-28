# VArgus for Codex CLI

VArgus adds a tmux row to ordinary Codex and reads saved session logs. Use
Node.js 24.12 or later and Bash with tmux on Linux or macOS. On native Windows,
use PowerShell, Windows Node and psmux.

## Install

Use the [shared checkout and PATH launcher](../README.md#shared-checkout-and-launcher).
Choose manual activation for the current session or install automatic startup
hooks in the intended Codex home.

### Manual activation

Start ordinary `codex` in tmux or psmux. From its primary conversation view
with a saved session log and an empty composer, run the following command.

```text
!vargus on
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
`--theme codex-ink` and `--config /path/to/options.json` apply on activation.

### Native Windows setup

Run Codex in native **psmux**, with Windows Node and PowerShell. Use this checkout's
`bin\vargus.cmd` through the [shared Windows PATH launcher](../README.md#put-vargus-on-path).
A forwarding file keeps the repository-relative entry intact and needs no
symlink privileges.

For [automatic startup](#automatic-startup-in-codex), the installer writes
PowerShell callbacks on Windows. Open Codex inside psmux for the UI steps.

### Automatic startup in Codex

With the [PATH launcher](../README.md#put-vargus-on-path) in place, run the installer.

```sh
vargus install codex
```

The command prepares `vargus/autostart` and adds the VArgus **SessionStart**
(`vargus hook session-start`) and **UserPromptSubmit** (`vargus hook prompt`)
callbacks to `hooks.json`, preserving existing callbacks, including direct
VArgus callbacks and their options. It uses `CODEX_HOME` or `~/.codex`
(`%USERPROFILE%\.codex` on Windows). Pass `--home /absolute/path` to prepare
another home, then launch Codex with that home. Record the checkout, launcher,
and the `hooks.json` path printed by the installer.

In the intended TUI, the user completes these steps.

1. Open or reopen Codex in tmux (psmux on Windows) and review and trust the
   VArgus callbacks through the startup dialog or `/hooks`.
2. Run `/statusline` with no arguments and select **Thread ID** in the picker.
   Confirm the selection and keep the whole ID visible. In a narrow terminal,
   [put Thread ID first](#narrow-terminals-and-ssh).
3. Send a normal prompt to start the row, then [verify activation](#verify).

`codexAutoStart` defaults to true. To use a custom tmux socket, restrict activation
to a pane, pick a theme, or supply a VArgus options file, add `--socket PATH`,
`--pane %ID`, `--theme NAME`, or `--config FILE` to both VArgus commands in
`hooks.json`. After moving the checkout, repoint the
[PATH launcher](../README.md#put-vargus-on-path). If a callback names the old checkout
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
in the options file used by both callbacks, or by [removing the callbacks](#remove).

## Verify

For automatic startup, check the selected home's `hooks.json` for VArgus
callbacks under `SessionStart` and `UserPromptSubmit`. Automatic activation waits
for a normal prompt after trust and Thread ID setup.

In the intended Codex TUI, run this after manual or automatic activation.

```text
!vargus status
```

Look for `VArgus is on` with the intended pane and for the row in the tmux or psmux bar.
If the row is blank and the current view is unknown, see
[footer restoration and typing](#footer-restoration-and-typing) and
[narrow terminals and SSH](#narrow-terminals-and-ssh).

If the worker misses its check-ins, the next bar redraw shows the last readings
with `| ⌛stale` (`| !:stale` on WSL). This also applies when a previously readable transcript
becomes unreadable while its view is still identified. The marker clears once the view is
identified and updated again.
The bar follows your existing `status-interval`.
With periodic redraws disabled, the marker can appear on the next redraw.

## Configure

The installed hooks and manual activation both read `vargus.jsonc` from the
VArgus checkout. A running helper polls `vargus.jsonc` every second, so edits
take effect automatically for keys not overridden by `--theme` or `--config`.
Run `!vargus reload` to change explicit flags or upgrade after code updates.
To override individual shared settings, pass `--theme NAME` or
`--config /absolute/path/to/vargus.json` on first activation.
[Shared configuration](../README.md#shared-configuration)
To change a running helper's options, use `reload` with those flags:

```text
!vargus on --theme codex-ink
!vargus reload --theme graphite
```

An explicit JSON or JSONC file uses the [shared defaults](../src/options.ts) and
[Codex defaults](../src/hosts/codex/options.ts).

```json
{
  "theme": "codex-ink",
  "folderFoldThreshold": 16,
  "session": false
}
```

Pass it with `!vargus on --config /absolute/path/to/vargus.json`, or with
`!vargus reload --config /absolute/path/to/vargus.json` for an existing helper.
`NO_COLOR` disables colours in the environment that starts the helper.
Setting `repo`, `branch` and `status` all to `false` stops the row's Git/SVN polling.
On a detached HEAD, the branch label shows the checkout ref or short commit ID
and any detected Git operation. During a rebase it shows the branch being rebased when available.

Codex always displays known model families as `astra`, `sol`, `terra` or `luna`, for example
`sol:xhigh`. Both `gpt-6-sol` and `gpt-6.1-sol` display `sol`; unfamiliar IDs remain
whole. The former `codexShortModel` option is ignored in existing options files.
The shared `callCounts` setting controls tool, agent and skill counts together.

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

## Update

Update your clone with `git -C /absolute/path/to/VArgus pull`, or fetch tags and
check out the release you want. Then, in Codex:

```text
!vargus reload
```

This replaces the standalone helper with the current source while Codex, its daemon
and conversation keep running. It rereads the checkout file, retains explicit overrides, replays recorded readings,
rediscovers the displayed view, and keeps the
original footer backups. Plain `on` also upgrades an older helper with reload
metadata, preserving those options and backups; the retired draft-hold setting
cannot disable paused readings. Helpers created before shared-file support
retain their full saved options until a fresh activation. Reload flags override retained options. `--config` merges
only supplied keys, and `--theme`/`--config` are applied in command order. A reload
while off stays off, including pending footer restoration and manual-off suppression
recorded by an interrupted off command.
If multiple panes share a bar from before the stale marker was introduced,
turn VArgus off in all of them before re-enabling it. This releases the old
shared layout so the next attachment can install the new format.
An older helper without reload metadata stays running and reports how to migrate:
run `!vargus off`, then `!vargus on` with your original options once. Unreadable
history leaves a healthy helper running. Failed replacement retains backups and
options for another `reload`; `off` remains available for footer recovery. Reload
does not build or install anything.

## Remove

1. If you installed automatic startup, run `vargus remove codex` with the
   same Codex home. It removes the VArgus callbacks from `hooks.json` and clears
   `vargus/autostart` (and empty `vargus/`). If VArgus uses a custom shell
   wrapper or appears before another callback in its group, remove the VArgus
   callbacks from `hooks.json` by hand. Keep the other callbacks and review the
   affected groups in `/hooks` after reopening Codex.
2. In each Codex TUI using VArgus, run `!vargus off`, then `!vargus status` while
   the clone and PATH entry still exist. If restoration is pending, visit the
   affected conversations with an empty composer and follow the
   [restoration notes](#footer-restoration-and-typing). Finish those restores, or
   exit Codex before removing the helper's source.
3. If you removed startup hooks, close the affected Codex TUIs before removing the
   PATH entry or clone. In checked Codex 0.167.0, reopening the TUI loads the updated
   hook definitions; reopening only `/hooks` inside a running TUI keeps the removed
   entries in its cached inventory.
4. Follow [Remove shared files](../README.md#remove-shared-files).

The saved footer selection from hook setup is yours to keep or edit. `off` restores
that saved layout; it does not remove your `thread-id` preference.
## Readings and view changes

The helper follows the displayed parent or subagent through Alt+Left/Right and
`/subagents`. By default (`includeSubagents: true`), each view folds saved,
attributable descendant threads' tokens, tools, agents and skills into the
displayed view (Main shows the whole saved family; a subagent view shows its own
subtree; ephemeral, ambiguous, unreadable, corrupt, replaced and unsupported
mixed-history logs are skipped). Setting `includeSubagents: false` shows each
view's own recorded readings without aggregating children. Context, cache hit %,
output speed (`t/s`), model, effort, Fast mode, session age, rate limits and
repository readings always follow the displayed thread. VArgus matches Codex's
contextual agent label to saved session metadata.
If a popup, clipped label or ambiguous agent path prevents identification, the row
blanks until the view can be identified again or the snapshot rules below apply.
At an empty composer, blank content also releases this pane's extra tmux row.
The last pane to release it restores the original bar height,
so `/new` can show the native Codex footer without an empty extra row. Content
returning brings VArgus back. On Linux/macOS, another pane using VArgus keeps the
extra row in its window; windows without VArgus keep the original height. `status` reports the current view or pause.
Without the optional startup hook, after `/new` or `/resume` run `!vargus on` again (with pane selection if needed)
to bind the new conversation. Its token total covers recorded uncached input and output.
The cache-hit percentage and output decode speed (`t/s`) in parentheses use the
latest request in the displayed thread: cached over total input tokens for cache
hit, and recorded `output_tokens` over the model's streamed item span
(`Reasoning`, `AgentMessage`, `Plan`, plus any trailing client tool call) when
at least 0.5 s elapsed. Codex can record zero when the provider omits cache
details. Pure tool-call-only steps without a recorded stream-start timestamp and
sub-0.5 s bursts preserve the previous speed. Compaction, a response without
fresh usage, or changing the model or Fast tier clears the affected suffix.
Tool counts replay completed visible items and exclude `!` controls. `🤖2` counts
recorded subagent starts in the displayed conversation's attributable subtree (or
the displayed conversation only when `includeSubagents: false`); `⚡3` counts observed skill
loads, once per skill path per user turn. Context defaults to `ctx:0%` until
recorded; other missing readings stay hidden.
Live readings come from saved transcripts and update as Codex writes them.
Model and effort picks appear once recorded.
For paginated subagent logs with Codex's recorded history boundary, VArgus skips
inherited parent activity and counts the child's own work. Inherited skill catalogs
can still identify later skill reads by the child. Logs without that supported
boundary can initially report `The transcript belongs to another Codex thread.`
through `status`; later refreshes can advance past the error. Readings from those
mixed logs remain unsupported, and their subagent and skill counts stay omitted.

## Footer restoration and typing

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
`!vargus on`; no options file is needed. Typing alone leaves the row as it was. Readings and time stay
frozen, and `!vargus status` reports that the current view is unknown.
These historical readings may belong to a different view after navigation.
Live readings resume when the view is identified again. Holding readings in an
ordinary draft requires a previously rendered snapshot in the current helper and
the native `% context left` or matching `Shell mode` hint. A native warning beside
the hint keeps the snapshot visible. Dialogs, unsupported layouts, and ordinary
drafts with foreign or clipped identities blank the row. Releasing the extra row
at an empty composer also discards its snapshot, so typing in a new conversation
cannot revive old readings.
Reloading discards the snapshot until a view is recognized again.

When `/btw` opens a side chat on Codex 0.170.0, the native statusline can
reappear alongside the VArgus tmux row. VArgus clears the main thread's footer
with `/statusline --clear`. The side chat opens with its own footer layout
and Codex shows `/statusline` as disabled in the command menu. Entering the
command there returns “'/statusline' is unavailable in side conversations.”
Even with the side thread's ID, VArgus cannot use that command to hide its footer.

VArgus controls the tmux row directly. In a side chat opened with `/btw` or
`/side`, the row marks the last confirmed readings `stale` while the side chat prompt
or its draft hint is visible. Live readings resume when you return to a
recognized saved conversation.

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

Saved session logs and composer recognition are version-sensitive. Linux tmux
checks used Codex 0.167.0 and 0.169.1. For coverage by build, including native
Windows psmux, see the [live verification record](../DESIGN.md#live-evidence-and-limits).

### Narrow terminals and SSH

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

## Windows bar behavior

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
Native Windows checks used Codex 0.167.0, Node.js 24.21.0 and psmux 3.4.0 with
a local mock provider on 2026-11-10. They cover automatic startup, token display,
`on/status/reload/off`, preserving a custom first row and
sharing the added row between two owners. Attached-client checks cover keyboard
window switching and creating a new window; native regressions cover custom
heights, hidden bars, user hooks and restoration. Windows subagent navigation and draft
scenarios and shared-daemon mode need their own live verification. The native
TUI rig uses `--no-daemon`; an independent real-TUI probe also verified `!` shell
controls and that a normal prompt after manual off leaves the row off. See
[DESIGN.md](../DESIGN.md#native-windows-codex-and-psmux) for the native bar details.
