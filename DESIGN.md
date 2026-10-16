# VArgus — design

VArgus is a status line for Claude Code in two parts. A mod (a plugin hooks module that stays
loaded for the whole session) hears the engine's events, keeps the numbers in memory, renders the
line and writes it to a file. The `statusLine` command is a shell one-liner that prints that file.
The line stays where VantageHUD's was, under the prompt. VArgus replaces VantageHUD and shares no
code with it.

This file is how VArgus works: each rule, with the reason for it. It is edited in place when a
rule changes, in the same commit as the code. It holds no history: what shipped in which version
goes in CHANGELOG.md, why one change was made in its commit message.

A point that a live session still has to settle is marked **Unsettled** and listed in
[Unsettled](#unsettled). The mod API is early access: each fact about it here was read from the
types and docs, or measured, on the Claude Code version named in [Scope](#scope) or beside the fact,
and is re-checked on each new release.

Code comments cite this file by section name: `(DESIGN, "The line file")`.

## Contents

- [Scope](#scope), [Decisions](#decisions), [Terms](#terms)
- [How it works](#how-it-works): layout, data sources, when the line is written
- [Fragments](#fragments), [Languages](#languages), [The detail view](#the-detail-view)
- [The line file](#the-line-file), [The reader](#the-reader), [Setup](#setup)
- [The host](#the-host): what the mod API gives and what it holds VArgus to
- [Config](#config), [Colours](#colours)
- [Rules carried over from VantageHUD](#rules-carried-over-from-vantagehud)
- [What VArgus cannot show](#what-vargus-cannot-show), [Unsettled](#unsettled)
- [Tests](#tests), [Rules for the code](#rules-for-the-code),
  [Not in this version](#not-in-this-version)

## Scope

- Claude Code 2.1.299 or later: mods are on by default from 2.1.287, and the facts below were
  checked on 2.1.299 and re-checked on 2.1.300 and 2.1.301; a measured fact names its version
  (older versions are untested).
- The line shows wherever Claude Code shows a `statusLine`: `claude` in a terminal, an editor's
  integrated terminal included. Where the status line is not drawn (the VS Code extension's chat
  panel, `claude -p`, the Agent SDK, cloud sessions) VArgus shows nothing, as VantageHUD did.
- Linux and macOS. The reader is POSIX `sh`; Windows is not covered.

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
| Every new feature has its own flag, off by default | An upgrade must not change what someone's line shows |
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
.claude-plugin/plugin.json      name, version, userConfig, types
.claude-plugin/marketplace.json the repo as its own marketplace
hooks/hooks.json                { "modules": ["./register.ts"] }
hooks/register.ts               wiring only
src/core/types.ts               the contract: Values, Theme, Fragment
src/options.ts                  the options and their defaults (= userConfig)
src/collect/*.ts                events → values: session, limits, vcs, each with its installer
src/render/index.ts             the composer: order, options, width
src/render/fragments/*.ts       pure: one fragment each, values + options + labels + theme → text
src/render/text.ts              cleanText, the `~` for home
src/render/format.ts            durations (`4h37m`)
src/render/width.ts             the wide-character count
src/theme/*.ts                  palettes, makeTheme, ANSI
src/i18n/en.ts                  the English labels; the `Labels` type is taken from it
src/i18n/index.ts               the language registry, resolveLabels
src/collect/agents.ts           tokens by agent, for the detail view
src/view/model.ts               pure: the detail view's cards, values + options + labels + theme → runs
src/view/pane.tsx               the cards as Box and Text elements
src/write.ts                    the line file
types/index.d.ts                the `$.state` contract (`PluginState`), named by `types` in plugin.json
skills/vargus-setup/SKILL.md    how the agent sets up the reader
tests/*.test.ts                 `claude plugin test .`
tests/reader.test.sh            the reader, run by `sh`
tests/manifest.test.sh          userConfig against src/options.ts
tsconfig.json                   for `tsc -p .`
```

Collectors hear events and update values; the renderer turns them into text; the writer puts the
text in the line file. The reader prints it on Claude Code's next status-line run.

### Data sources

| Data | Source | Basis |
|---|---|---|
| Tokens per request, per agent (subagents, in-process teammates and workflow agents), counted from when this process loaded the mod or from the last clear/resume; a resumed session's earlier history is not in them, while `$.session.usage()` counts from its first launch | `turn.step` result `usage` ("as the API reported it"), `e.agentId`; `token:` sums `input_tokens + output_tokens`, main loop and subagents, as VantageHUD did (cache reads and writes left out: `ctx:` is the cache-inclusive gauge; `input_tokens` is the part neither read from nor written to the cache, so nothing counts twice) | types; measured (2.1.300): a subagent's steps, and an in-process teammate's (`agent.spawn` `isTeammate`) on both its first turn and one after a `SendMessage`, the line's `token:` equal to the sum; a workflow agent's two steps (`agent.spawn` `workflow`), main loop 1,850 + agent 298 = the line's `token:2.1k` |
| Context %, cost, session start, `five_hour`/`seven_day`/`spend_limit` | `$.session.usage()`; pushed by `session.measure` after each main-thread turn and when a limit window moves a whole point. After `/clear` or a resume nothing pushes the context and start until the next main-thread turn, so the tick reads `$.session.usage()` again (free without a breakdown) until that turn's `session.measure`, taking each answer: a first answer that still described the session left is corrected on the next tick. VantageHUD avoided `ctx:0%` on a resumed conversation by working the percent out from the transcript; here the host has it at once after `claude --resume <id>` of a long conversation in a new process (an in-session `/resume` not measured) | types; measured (2.1.301, 2026-10-16): the person resumed a long session and found `ctx:`, `session:` and the detail view's Context card right before the first message |
| Folder, model, effort | `$.session.cwd()` and `$.session.model()` on each tick (a `/model` switch raises no event but the classic `PostModelSwitch`, and classic hooks don't run where an organization manages Claude Code), `effort` on the main loop's `turn.step` input, so none shows before a session's first request. Not filled in earlier from settings and the model's default: the engine's order (model-config docs) also takes `--effort`, a session-only `/effort`, an organization default and caps, which a mod can't read | types, docs |
| Tool / agent / skill / workflow counts | the main loop's `tool.call` (no `e.agentId`): every call, `Agent`, `Skill`, and `Workflow` other than a resume; counted when the call is asked for, a refused one included, as VantageHUD counted the transcript's tool_use blocks. Not `agent.spawn`: it fires for each workflow agent too | types |
| Per-model weekly (`sn:`/`op:`/others), `extra:` | OAuth usage API via `$.http.fetch` + `$.session.authorize()`, cached in `$.store` per config folder (`CLAUDE_CONFIG_DIR`, which picks the login); the store is checked every 15 s and the API read when the cache's retry time has passed (90 s after a success, 2 min after a network or auth failure, the larger of the backoff and `Retry-After` after a 429). No read, and no cached numbers shown, when `authorize()` gives null or an API key (the endpoint is OAuth-only; checked before the cache, so another login's numbers can't show), or with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` set (the engine refuses a plugin's request carrying `auth`). Another process's `$.store.set` is seen here on the next check. Each `authorize()` mints a new handle and only the newest few stay valid, so the 15 s calls pile nothing up; the handle is spent at once | measured: HTTP 200 on the dev machine, where the API answers only through `HTTPS_PROXY` (2.1.300); two sessions writing one key each to `$.store` every second and reading the other's: 52 of 52 writes seen, 0.33-0.75 s later, then after a hot reload 77 of 79 (0.79-0.95 s; the two missed were overwritten before the next read) and 78 of 78 (0.07-0.22 s); 70 `authorize()` calls gave 70 distinct handles, of which the newest 4 still worked and the 5th-newest and older were refused ("unknown auth handle"), and the process's `VmRSS` (`/proc`) moved 337 to 339 MB over a 100-call burst (2.1.301) |
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
| 3 | rate limits | `5h:4%(4h37m) 7d:39%(5d6h)` | on | spend limit (off), other models' weekly (off) |
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
  `$.env.get` (`$.fs` does not expand `~`; the mod's env has no `CLAUDE_PLUGIN_DATA`). Measured
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
  <line>])` puts it in place. `<t>` is `$.clock.now()` taken at `session.start`, so each loaded copy
  of the mod (after a hot reload, or a second process on the session) has its own temp file. Why:
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
  `$.process.run(['rm', '-rf', '--', <data>/<id>])`, since `$.fs` has no delete: after a write
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
  `/config`, stored under `pluginConfigs`. Each new feature's flag defaults to off.
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
  fingerprint of the rejected token so a new login retried at once; a mod never sees the token, so
  VArgus retries after 2 min, and `[API auth]` can outlast a re-login by up to 2 min 15 s); 403 is
  `network` (region block), not auth; 429 honours a numeric `Retry-After` (capped at 1 h); per-model
  weekly caps come from `limits[]` entries of kind `weekly_scoped` (the flat
  `seven_day_opus`/`seven_day_sonnet` are null); skip the call when `ANTHROPIC_BASE_URL` is a
  non-Anthropic gateway or Bedrock/Vertex/Foundry is on. Only per-model weekly and `extra:` need
  this API; the engine gives the rest.
- **Usage cache and staleness** (`src/hud/usage-api.js`, AGENTS.md "Usage/rate-limit data"): one
  cache per account (keyed by `CLAUDE_CONFIG_DIR`, which picks the credentials), because one shared
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
  `5h:`/`7d:` come only from the engine: until its first reading in a session they are absent,
  where VantageHUD fell back to the API.
- Teammates running in their own tmux pane: each "runs no loop here", so their requests are not
  seen.
- The old payload's `cost.total_cost_usd` included teammates; whether `$.session.usage().cost`
  does is not measured. VArgus shows no cost, so it matters only if a cost fragment is added.

## Unsettled

What the types and docs alone can't settle and no live session has settled yet; none blocks
0.1.0's line. A throwaway mod run in a live session settles each.

1. Whether `$.state` survives a lost worker, as it survives a hot reload.

## Tests

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

- Import only the mod's own files, by relative path, and `claude-code`: the engine refuses
  anything else.
- Hooks observe: a hook on an engine event passes it on with `next(e)` and changes nothing.
- `hooks/register.ts` holds every hook, one per event, and calls each area's exported functions
  from it: `claude plugin validate` refuses a second `on('<event>')` without a matcher anywhere in
  the module ("registered twice without a matcher", 2.1.300).
- The renderer is pure; all I/O (`$.process`, `$.fs`, `$.http`) happens in collectors and the
  writer. A throwing fragment is left out, never the line.
- Run programs with `$.process.run` and an argument list; never a shell.
- Colours come only from the theme's tokens; control characters in a fragment become `?`.
- The mod writes only inside its data folder.
- Never refresh an OAuth token; the usage API is read with `$.session.authorize()` alone.
- Comment the reason for anything that isn't obvious.
- When a design decision changes, update this file in the same commit, in place.

## Not in this version

Later:

- Custom themes, in a JSON file that a `file` option names (`userConfig` fields are flat, so
  nested themes can't live there); bar gauges (`useBars`); VantageHUD's other options, built in
  for 0.1.0 ([Config](#config)).
- Languages other than English (VantageHUD had zh-CN), and per-label overrides (VantageHUD's
  `labels` config).

Not planned: payload-only data in the line; drawing anywhere but the status-line row and the
`/vargus` pane; seeing
teammates that run in their own tmux pane; a live-agents row (`agents: reviewer running 1m17s
8.2k | Explore done 9.2k`), since Claude Code lists each running agent under the prompt with what
it is doing, its time and its tokens (seen on 2.1.300: `◯ Explore  Grepping labels.test.ts for
fragment cases  40s · ↓ 29.2k tokens`).
