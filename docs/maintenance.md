# VArgus maintenance

## Test process cleanup

These rules apply to every agent and subagent, test suite and throwaway probe, regardless of host CLI.

- Before launching a test, inspect its harness for these safeguards. If it lacks them, fix it or
  use an invocation-scoped runner that supplies them before running it.
- Use isolated test homes and tmux sockets. Record temporary paths and process handles, PIDs and
  start times; keep long commands in managed tool sessions and collect their exit status.
- In disposable Codex homes, use direct stdio app-server or `--no-daemon` unless managed-daemon
  behaviour is under test. Before starting a required daemon, set
  `app-server-daemon/settings.json` to `{"updater":{"autoUpdateEnabled":false}}`, merging into
  existing settings. Leave updates enabled only for updater tests;
  `check_for_update_on_startup = false` does not disable the daemon updater.
- Clean up in `finally`, including after failures: stop test-owned TUIs, tmux servers, daemons,
  helpers and providers. A successful daemon stop is not proof that `pid-update-loop` exited.
  Revalidate executable path, arguments, PID and start time against the recorded test home
  before signalling a remaining process. Never use broad `pkill -f` or stop normal user sessions.
- Verify exit in a process namespace that can see the spawned processes, with a positive control.
  Wait for confirmed exit before deleting any test home; deleted executables can remain in use.
  If an owned process survives a bounded wait or visibility is insufficient, fail the cleanup check,
  retain its home and report the remaining process or verification gap before handing off.

## Releases

Same steps as VantageHUD: bump `.claude-plugin/plugin.json` and `package.json`,
keeping the top-level and root-package versions in `package-lock.json` in sync, and add a dated
`## [x.y.z] - YYYY-MM-DD` section in `CHANGELOG.md` (Keep a Changelog: Added / Changed / Fixed /
Removed, compare link at the bottom), committed as `chore(release): x.y.z`; an annotated tag
`vX.Y.Z`; push `main` and the tag; `gh release create vX.Y.Z --title vX.Y.Z --notes-file notes.md
--latest --verify-tag`. Notes style: one lead sentence, a `##` section per headline change with
its measured numbers, an `## Also` list, an `## Upgrading` section when there are migration steps,
then `---` and `**Full changelog**: <compare link>` (see VantageHUD's GitHub releases).

## Development checks

- Run `npm ci` for development tools. `npm run test:local` type-checks the
  Node source and runs the shared renderer and local host tests with Node and Git.
  The fixture supervisor used by the Node and Claude suites also needs the
  Windows .NET Framework 4.x compiler (`csc.exe`) on Windows, or `sh` and a
  `ps` that shows same-user process environments on POSIX. The Windows
  assignment-failure test uses Windows PowerShell. These are test prerequisites,
  not VArgus install steps.
  `npm test` adds native Codex and tmux checks, or Codex and psmux checks on Windows.
- For Claude development, start `claude --plugin-dir .` interactively from the repository
  root on a fresh checkout or after upgrading Claude Code. Let Claude load the plugin and
  write its TypeScript declarations to `.claude-plugin/types/`, then exit the session.
  Run `npm run test:claude` for type-checking, staged plugin validation, engine tests
  and the reader and manifest checks. On Windows the shell checks use Git for Windows.
  If the runner reports a retained fixture, inspect the command and cleanup errors
  before removing that directory.
  See [test and verification details](../DESIGN.md#tests).

## Add a host

Use [Antigravity's stdin command](../src/cli/antigravity.ts) as a starting point for
a command-based host, or [OmO's native registration](../src/hosts/omo/register.ts)
for an in-process extension.

- Add one adapter under `src/hosts/<host>` for readings and host lifecycle.
  For quotas, supply windows in display order using the [shared quota types](../src/core/limits.ts).
- Wire it to the shared renderer and output at a CLI or native entry point.
  Register any native entry's output import explicitly in the boundary test.
- Add a `.test.mts` file under `tests/<host>/` that exercises the entry with a
  representative payload or session. Run `npm run test:local`.
- Add a host setup guide covering verification and removal, and link it from
  [README.md](../README.md#choose-your-setup). Cover any shared checkout or launcher
  it uses. Keep user installs source-only.
