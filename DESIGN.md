# VArgus — design

VArgus is a status line for Claude Code in two parts. A mod (a plugin hooks module that stays
loaded for the whole session) hears the engine's events, keeps the numbers in memory, renders the
line and writes it to a file. The `statusLine` command is a shell one-liner that prints that file.
The line stays where VantageHUD's was, under the prompt. VArgus replaces VantageHUD and shares no
code with it.

This file is how VArgus works: each rule, with the reason for it. It is edited in place when a
rule changes, in the same commit as the code. It holds no history: what shipped in which version
goes in CHANGELOG.md, why one change was made in its commit message.

No code exists yet, so until the first release this file is the intended design. A point that a
live session still has to settle is marked **Unsettled** and listed in [Unsettled](#unsettled).
The mod API is early access: each fact about it here was read from the types and docs of the
Claude Code version named in [Scope](#scope), and is re-checked on each new release.

Code comments cite this file by section name: `(DESIGN, "The line file")`.

## Contents

- [Scope](#scope), [Decisions](#decisions), [Terms](#terms)
- [How it works](#how-it-works): layout, data sources, when the line is written
- [Fragments](#fragments), [Languages](#languages)
- [The line file](#the-line-file), [The reader](#the-reader), [Setup](#setup)
- [The host](#the-host): what the mod API gives and what it holds VArgus to
- [Config](#config), [Colours](#colours)
- [Rules carried over from VantageHUD](#rules-carried-over-from-vantagehud)
- [What VArgus cannot show](#what-vargus-cannot-show), [Unsettled](#unsettled)
- [Tests](#tests), [Rules for the code](#rules-for-the-code),
  [Not in this version](#not-in-this-version)

## Scope

- Claude Code 2.1.299 or later: mods are on by default from 2.1.287, and the facts below were
  checked on 2.1.299 (older versions are untested). The live-agents row planned after 0.1.0 needs
  2.1.299 too: that is where `turn.start` began to hear subagents' turns.
- The line shows wherever Claude Code shows a `statusLine`: `claude` in a terminal, an editor's
  integrated terminal included. Where the status line is not drawn (the VS Code extension's chat
  panel, `claude -p`, the Agent SDK, cloud sessions) VArgus shows nothing, as VantageHUD did.
- Linux and macOS. The reader is POSIX `sh`; Windows is not covered.

Not in scope: the band above the prompt and other mod-drawn UI, data that only the status-line
payload carries ([What VArgus cannot show](#what-vargus-cannot-show)), teammates running in their
own tmux pane, code shared with VantageHUD.

## Decisions

| decision | why |
|---|---|
| 0.1.0 shows VantageHUD's fragments in VantageHUD's order, each on or off by default as there ([Fragments](#fragments)); none is added or removed before 0.1.0 | The first release replaces VantageHUD like for like, so the two can be compared fragment by fragment; which fragments to add or remove is decided after 0.1.0 |
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
src/collect/*.ts                events → values
src/render/*.ts                 pure: values + options + width → the line's text
src/theme/*.ts                  palettes, resolvePalette, ANSI
src/i18n/en.ts                  the English labels; the `Labels` type is taken from it
src/i18n/index.ts               the language registry, resolveLabels
src/write.ts                    the line file
types/index.d.ts                the `$.state` contract (`PluginState`), named by `types` in plugin.json
skills/vargus-setup/SKILL.md    how the agent sets up the reader
```

Collectors hear events and update values; the renderer turns them into text; the writer puts the
text in the line file. The reader prints it on Claude Code's next status-line run.

### Data sources

| Data | Source | Basis |
|---|---|---|
| Tokens per request, per agent (subagents; workflow agents and teammates: [Unsettled](#unsettled) 5), counted from when this process loaded the mod or from the last clear/resume; a resumed session's earlier history is not in them, while `$.session.usage()` counts from its first launch | `turn.step` result `usage` ("as the API reported it"), `e.agentId` | types; workflow agents unverified |
| Context %, cost, session start, `five_hour`/`seven_day`/`spend_limit` | `$.session.usage()`; pushed by `session.measure` after each main-thread turn and when a limit window moves a whole point | types |
| `cache:` warm or cold | `turn.step` usage of the main loop's requests (`cache_read_input_tokens`, `cache_creation_input_tokens`) and when the last one ended; the cache's lifetime is not in it | **unsettled**: [Unsettled](#unsettled) 9 |
| Folder, model, effort | `$.session.cwd()`, `$.session.model()`, `effort` on `turn.step`'s input | types |
| Tool / agent / skill / workflow counts | `tool.call`, `agent.spawn` | types |
| Live agents (running, done), for the row after 0.1.0 | `agent.spawn`, `turn.start` / `turn.complete` with `e.agentId` (subagents' turns since 2.1.299) | types, CHANGELOG 2.1.299 |
| Per-model weekly (`sn:`/`op:`/others), `extra:` | OAuth usage API via `$.http.fetch` + `$.session.authorize()`, cached in `$.store` | **unverified**: [Unsettled](#unsettled) 6 |
| git | `$.session.repo()`, `$.process.run` (no shell; git runs with repo hooks off) | types |
| svn | `$.process.run(['svn', 'status', '--xml', ...])` | types |
| Clock-driven fragments (countdowns, session time) | `$.clock.every(1000)`, which keeps running between turns (mods/api: "keeps running between turns and doesn't start one") | docs |

### When the line is written

- The mod renders on each change of a value and on each `$.clock.every(1000)` tick, and writes the
  file only when the text differs from what it last wrote. Why: the reader runs every second, and
  most ticks change nothing. So the shown line can lag the mod's values by up to about a second:
  an event-triggered reader run can come before the mod's write.
- Only an interactive session writes (`session.start`'s `isInteractive`). Why: `claude -p` and
  SDK runs load plugins too, show no status line, and would each leave a folder behind.
- The width comes from [Unsettled](#unsettled) 4. Fragments are dropped from the end, whole,
  when the row is too narrow. 0.1.0 uses one row; a second row is for the live agents, after
  0.1.0. Claude Code's own
  notifications share the right side of the row (statusline docs), so the usable width is less
  than the terminal's.
- A fragment that throws costs only that fragment: the renderer catches it and leaves it out.
  Why: VantageHUD's rule ("Rendering must never throw to the user"); one bad value must not blank
  the line.

## Fragments

0.1.0 shows VantageHUD 0.6.0's fragments in its order (`DEFAULT_ELEMENT_ORDER.main` in
`src/hud/types.js`), joined by ` | `, each on or off by default as there. Each fragment and each
sub-option is a `userConfig` boolean.

| # | fragment | example | default | sub-options (default) |
|---|---|---|---|---|
| 1 | folder | `~/proj/VArgus` | on | |
| 2 | model | `opus:high` | on | effort (on) |
| 3 | rate limits | `5h:4%(4h37m) 7d:39%(5d6h)` | on | spend limit (off), other models' weekly (off) |
| 4 | context | `ctx:20%` | on | |
| 5 | prompt cache | `cache:warm(14:30)` | off | |
| 6 | tokens | `token:69.5k` | on | |
| 7 | session time | `session:24m` | on | |
| 8 | call counts | `🔧73 🤖2 ⚡1` | on | workflow runs (off) |
| 9 | repo | `repo:VArgus` | on | |
| 10 | branch | `branch:main` | on | detached HEAD named (off) |
| 11 | working-tree status | `?4` | on | |

- Where VantageHUD read a value from the status-line payload, VArgus takes it from the host
  ([Data sources](#data-sources)). The spend limit loses its dollars ([What VArgus cannot
  show](#what-vargus-cannot-show)); `cache:` waits on [Unsettled](#unsettled) 9.
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

## The line file

- One folder per session: `<data>/<session id>/line`, where `<data>` is the plugin's data folder,
  `~/.claude/plugins/data/vargus-<marketplace>/` in the docs. Why: that folder survives plugin
  updates, while the plugin's install folder changes with each version (plugins/components docs).
  The mod builds the path as `$CLAUDE_CONFIG_DIR`, else `$HOME/.claude`, then
  `/plugins/data/vargus-<marketplace>`, reading both with `$.env.get` (`$.fs` does not expand
  `~`). `$.plugin` gives only `name` and `root`, and `<marketplace>` is the `name` in the repo's
  own `marketplace.json`, so the rest is constants. Whether Claude Code puts the folder under
  `CLAUDE_CONFIG_DIR` is not documented: if the mod's path and the skill's `${CLAUDE_PLUGIN_DATA}`
  differ, the row stays blank. Under `--plugin-dir` the plugin is
  `vargus@inline`, so its folder is likely `vargus-inline`: a reader set up for the installed
  plugin shows nothing while developing. **Unsettled** 3.
- The session id is re-read with `$.session.id()` on every write, never kept from the start. Why:
  `/clear` and an in-session resume go on under a new session id with no `session.start` (types,
  `SessionEndInput`). At `session.end` with reason `clear` or `resume` ("another took its place")
  the mod also starts its own counts over, as `$.session.usage()` does at `/clear`. The counts
  live in `$.state`, so a hot reload keeps them (the types say so; a lost worker is not stated,
  [Unsettled](#unsettled) 8). The reader keys on
  `CLAUDE_CODE_SESSION_ID`; both sides use the id as given, and the mod writes nothing for an
  empty id. **Unsettled** 1. Why it matters: VantageHUD once keyed its cache on a variable Claude
  Code doesn't export, so concurrent sessions shared one file and `ctx:` dropped to 0%.
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
- A temp file left by a crash, or by a copy replaced mid-write, stays until the folder is
  removed ([Not in this version](#not-in-this-version)).
- If `mv` fails (an organization hook refuses the process, say), the mod writes `line` directly;
  a read can then catch a half-written line for one run.
- Whether two Claude Code processes can write one session's file is not known. **Unsettled** 2.
- The folder is left behind when the session ends: `$.fs` has no delete. Later: remove it at
  `session.end`, plus an age prune for sessions that were killed ([Not in this
  version](#not-in-this-version)).

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
  blank for that run. A mod that wrote and then stopped (turned off, a lost worker) leaves its last
  line on screen with frozen numbers: the reader can't tell; see [Not in this
  version](#not-in-this-version).
- It never reads stdin: the payload is not used. Fallback if [Unsettled](#unsettled) 1 fails:
  take `session_id` from stdin with one `sed`, as VantageHUD's `statusline.sh` did.

## Setup

- The plugin ships a `vargus-setup` skill. Asked to set up the VArgus status line, the agent
  follows it: show the current `statusLine` entry, if any, and ask before replacing it; write the
  reader with `refreshInterval: 1`; tell the person the line shows from the next status-line run.
  The same skill removes the entry before an uninstall.
- Uninstalling deletes the plugin's data folder by default (plugins/manifest-reference), so a
  reader left in settings shows a blank row from then on: the `statusLine` entry goes first.
- README.md holds the same steps for doing it by hand.

## The host

- **Lifecycle**: module variables are shared by the module's hooks but lost on hot reload (and on
  a lost worker), so in-memory values start over; `$.state` (session) survives a reload,
  `$.store` (cross-session JSON, 4 MiB) too. A reload runs `register` and `session.start` again.
- **Develop against the folder** (`--plugin-dir`, or the mods folder with hot reload): an
  installed plugin is a cached copy keyed by version, so edits reach it only after a version
  bump.
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
- **Marketplace**: `.claude-plugin/marketplace.json` with `source: "./"` makes the repo its own
  marketplace.

## Config

- Flags and simple values are `userConfig` fields in `.claude-plugin/plugin.json`: shown in
  `/config`, stored under `pluginConfigs`. Each new feature's flag defaults to off.
- 0.1.0's options: one boolean per fragment and sub-option ([Fragments](#fragments)), and
  `theme`, a picker (`options`) of VantageHUD's five palettes (`aurora`, `ember`, `nebula`,
  `graphite`, `daylight`), default `graphite`.
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
  (anthropics/claude-code#42603, closed "not planned"); 401 → `auth` error with a fingerprint of
  the rejected token; 403 is `network` (region block), not auth; 429 honours a numeric
  `Retry-After` (capped at 1 h); per-model weekly caps come from `limits[]` entries of kind
  `weekly_scoped` (the flat `seven_day_opus`/`seven_day_sonnet` are null); skip the call when
  `ANTHROPIC_BASE_URL` is a non-Anthropic gateway or Bedrock/Vertex/Foundry is on. Only per-model
  weekly and `extra:` need this API; the engine gives the rest.
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
  files (`getDetachedHead`), the symlinked-cwd root spelling (`onGivenPath`). Check how much of
  this `$.session.repo()` already does.
- **Width** (`src/lib/string-width.js`): a wide (East Asian) character or an emoji takes two
  columns; fit the line by that count, not by string length.
- **Cost**: the old payload's cost was non-zero on a Max plan: it is the list-price equivalent,
  not a charge. Label it so.
- **Labels** (`DEFAULT_HUD_LABELS` in `src/hud/types.js`): the English words. `repo`, `branch`,
  the window names and `@` are written straight into VantageHUD's fragments; in VArgus they are
  labels too ([Languages](#languages)). Its zh-CN set is not in 0.1.0.

## What VArgus cannot show

- Data only the status-line payload carries: `prompt_cache` as the payload gives it (VantageHUD's
  `cache:` fragment, which VArgus rebuilds from `turn.step` usage if [Unsettled](#unsettled) 9
  allows), lines added and removed, PR state, `session_name`, `workspace`, API and wall
  durations, and the spend limit's dollars (`$.session.usage()` rate limits carry only `kind`,
  `percentUsed`, `resetsAt`). Dropped in 0.1.0; re-check what mod events carry before calling any
  of these lost (`turn.step` usage has the cache read and write tokens per request).
- Teammates running in their own tmux pane: each "runs no loop here", so their requests are not
  seen.
- The old payload's `cost.total_cost_usd` included teammates; whether `$.session.usage().cost`
  does is unverified ([Unsettled](#unsettled) 7).

## Unsettled

What the types and docs alone can't settle; a throwaway mod run in a live session settles it.

1. `$.session.id()`, the payload's `session_id` and `CLAUDE_CODE_SESSION_ID` in the reader's env
   are the same value, at the start, after `/clear` and after an in-session resume
   ([The line file](#the-line-file)).
2. Whether two Claude Code processes can write one session's line file (the same session resumed
   in a second window), and whether `mv` costs the same on the real data folder's disk as on the
   tmpfs it was measured on ([The line file](#the-line-file)).
3. The mod can write to the plugin's data folder; the folder's real name (`<id>` is the plugin id
   with every character other than letters, digits, `_` and `-` replaced by `-`); where it is when
   `CLAUDE_CONFIG_DIR` is set; and what `${CLAUDE_PLUGIN_DATA}` expands to in the setup skill.
4. How the mod learns the width. The host gives a width only to `ui.render` hooks
   (`e.viewport`); a hook on `PromptHint` that reads it and passes on with `next(e)` would observe
   without drawing. The reader's `COLUMNS` (set since 2.1.153 per the CHANGELOG) can only serve
   to check it: the mod can't see the reader's env.
5. `turn.step` carries usage for workflow (`ultracode`) agents and Agent-tool teammates.
6. `$.http.fetch` + `authorize()` reaches `/api/oauth/usage`, and does so through `HTTPS_PROXY`
   (on the dev machine the API is reachable only via the proxy). The engine sets the credential
   header "only for a first-party host"; no docs page mentions a proxy for mods, and the types'
   "no proxy" is said of `socketPath` only. If not: `$.process.run` of a small fetch script
   (children inherit the env, so the proxy vars), or drop per-model weekly.
7. Whether `$.session.usage().cost` includes teammates.
8. Whether `$.state` survives a lost worker, as it survives a hot reload.
9. Whether the mod can learn the prompt cache's lifetime (5 min or 1 h), which `cache:` needs to
   say when the cache goes cold. `turn.step`'s `ModelUsage` has the cache read and write tokens but
   no lifetime; a split by lifetime (`cache_creation.ephemeral_5m_input_tokens`,
   `ephemeral_1h_input_tokens`) is declared only on the Agent tool's result. Lead: a mod can hear
   classic hook events as `classic.<Event>`; `classic.PreModelSwitch` and
   `classic.PostModelSwitch` carry `cache_ttl: '5m' | '1h'`, and `classic.SessionStart` on a
   resume carries `prompt_cache_likely_expired`. Check whether one of them, or a setting they
   reflect, gives the lifetime outside a switch. If not, 0.1.0 ships without `cache:`.

## Tests

- `claude plugin validate .` reads the manifest and the module as the engine will, and reports
  what the engine would refuse.
- `tsc -p .` type-checks against the types the engine writes into `.claude-plugin/types/`.
- `claude plugin test .` runs the `*.test.ts` files: the renderer's output for given values and
  widths, the writer's file, and each rule in [Rules carried over from
  VantageHUD](#rules-carried-over-from-vantagehud).
- The reader is tested as a shell command against a line file written by the tests.
- The fragment order and each fragment's default match [Fragments](#fragments).
- The labels test in [Languages](#languages).

## Rules for the code

- Import only the mod's own files, by relative path, and `claude-code`: the engine refuses
  anything else.
- Hooks observe: a hook on an engine event passes it on with `next(e)` and changes nothing.
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

- Removing a session's folder at `session.end` (`$.process.run(['rm', '-r', <folder>])`, guarded
  to the data folder), plus an age prune for killed sessions, only inside a folder that carries
  VArgus's marker file (VantageHUD's prune rule: 14 idle days, marker-guarded).
- The reader showing nothing when the mod has stopped writing (a stale line stays today). Needs a
  heartbeat write, since the mod otherwise writes only when the text changes.
- Custom themes, in a JSON file that a `file` option names (`userConfig` fields are flat, so
  nested themes can't live there); bar gauges (`useBars`); VantageHUD's other options, built in
  for 0.1.0 ([Config](#config)).
- A detail view (`/vargus` opening a pane, or answering in text) for what does not fit the line.
- The live-agents row (`agents: reviewer running 1m17s 8.2k | Explore done 9.2k`), a second row
  while subagents run; its sources are in [Data sources](#data-sources).
- Languages other than English (VantageHUD had zh-CN), and per-label overrides (VantageHUD's
  `labels` config).

Not planned: payload-only data in the line; drawing anywhere but the status-line row; seeing
teammates that run in their own tmux pane.
