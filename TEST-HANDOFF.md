# Native Codex test failure handoff

The host-first test layout was reviewed against `3752f5b`. The reviewer found no layout blocker. Linux and simulated Windows runner checks selected the same test files as before, and both TypeScript projects retained their test inputs. The runner now sorts by relative path and still runs files serially. [Review checks](/tmp/vargus-round.FTpXEW/reviewer/checks.log)

The frozen candidate passed `npm run test:local` with 117 tests and `npm run test:claude` with 195 engine tests plus the reader and manifest checks. Run the Claude command from a clean copy if the worktree contains old test snapshots under `tmp/`. Claude also discovers those ignored copies. [Node preflight](/tmp/vargus-round.FTpXEW/helpers/preflight-local.log) · [Claude preflight](/tmp/vargus-round.FTpXEW/helpers/preflight-claude.log)

The guarded Linux `npm test` run finished with **131 passed, 7 failed and 12 skipped**. The native checks used Codex CLI 0.169.1, Node 24.14.1, tmux 3.5a and a localhost mock provider. [Full run](/tmp/vargus-round.FTpXEW/evidence/previous/native-final.log#L288)

## Three standalone assertions reproduce before and after the move

The fixture kills its test-owned helper and exercises `off` recovery. Each case expected an empty `@vargus_line` after stripping tmux styling. The same case retained the same token reading on the baseline and candidate. [Fixture](tests/codex/standalone.test.mts#L472)

| Fixture | Failing check | Reading retained |
| --- | --- | --- |
| Fresh chat with the default footer (`null`) | Immediate blank-row check after `off` reports pending restoration, line 480 | `token:3.2k` |
| Prompted chat with `['session-id', 'model']` | Blank-row wait after `off`, line 489 | `token:6.4k` |
| Fresh chat with an explicitly empty footer (`[]`) | Blank-row wait after `off`, line 489 | `token:3.2k` |

The before-and-after comparisons disabled plugin sync in disposable homes and confirmed process exit. [Default footer baseline](/tmp/vargus-round.FTpXEW/evidence/previous/native-before.log) · [Default footer candidate](/tmp/vargus-round.FTpXEW/evidence/previous/native-after.log) · [Other two baseline cases](/tmp/vargus-round.FTpXEW/tester/tools/native-compare-baseline.log) · [Other two candidate cases](/tmp/vargus-round.FTpXEW/tester/tools/native-compare-candidate.log)

Start with the default-footer case. Capture the helper identity, pane owner and line options, and session status formats immediately before and after `off`. Compare the stored line with the rendered bar to establish whether stale data remains visible. The assertion establishes that the pane option is still populated. [Off recovery](src/cli/codex.ts#L221) · [Abandoned-owner cleanup](src/outputs/tmux/client.ts#L627)

## Four failures occurred at fixture teardown

- `hooks-engine.test.mts` SessionStart broadcast and SessionStart without an explicit full-ID footer.
- `skills-engine.test.mts` official skill-load counting.
- `views-engine.test.mts` sibling views with the crowded fullscreen footer, cold config and full ID.

The temporary cleanup guard found Git processes for Codex's plugin repository still running when the fixtures tried to remove their scratch directories. The guard retained those homes until exit was confirmed. The teardown exceptions leave the corresponding test-body results open. [Failure details](/tmp/vargus-round.FTpXEW/reviewer/failure-accounting.log)

The tester reran the SessionStart case without a full ID with plugin sync disabled. It passed and confirmed exit before deletion. Verify the other three cases with the same isolation. In the native harness, disable managed-daemon updates and verify that test-owned processes have exited before removing their homes. [Focused rerun](/tmp/vargus-round.FTpXEW/tester/tools/native-focused-hook-cleanup.log) · [Cleanup rules](AGENTS.md#test-process-cleanup)

## Reproducing the standalone checks

The temporary supervisor used in the round is under `/tmp/vargus-round.FTpXEW/tester/tools`. Copy it to a fresh scratch directory to preserve the recorded logs. Run the selected case from the relevant checkout with localhost and process inspection available.

```sh
vargus_saved_tools=/tmp/vargus-round.FTpXEW/tester/tools
vargus_probe_tools=$(mktemp -d /tmp/vargus-probe.XXXXXX)
cp -a "$vargus_saved_tools/verify.py" "$vargus_saved_tools/guard.mjs" \
  "$vargus_saved_tools/cleanup.py" "$vargus_saved_tools/bin" "$vargus_probe_tools/"
VARGUS_LAYOUT_DISABLE_PLUGINS=1 python3 "$vargus_probe_tools/verify.py" \
  native-standalone node --test --test-concurrency=1 \
  --test-name-pattern 'official Codex standalone controls' \
  tests/codex/standalone.test.mts
```

Use `tests/node/standalone.test.mts` in the baseline checkout. Treat the scratch path printed after a failed run as evidence until process exit is confirmed. Rerun the full Linux suite after the teardown and standalone fixes.

If the temporary verifier has expired, recreate the isolation and exit checks in `AGENTS.md` before running the probe. The test profile used `[features]` with `plugins = false` and put Node on the disposable login shell's `PATH`.

## Review note

One low-severity finding remains open. Passing the retired `--fixtures` flag directly to `tests/run-node.mjs` selects the full native suite. The documented `npm run test:local` path selects the intended local suite. Rejecting the old direct flag can be handled separately from this handoff. [Runner](tests/run-node.mjs#L11) · [Argument capture](/tmp/vargus-round.FTpXEW/reviewer/runner-argv.jsonl)
