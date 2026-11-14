import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { renderAntigravityStatusLine } from '../../src/cli/antigravity.ts'
import { collectAntigravityPayload, type AntigravityPayload } from '../../src/hosts/antigravity/collect.ts'
import {
  readTranscriptState,
  resolveContainedTranscriptCandidate,
  resolveTranscriptPath,
} from '../../src/hosts/antigravity/transcript.ts'
import { POLL_MS, readCachedGit } from '../../src/hosts/antigravity/vcs.ts'
import { en } from '../../src/i18n/en.ts'
import { DEFAULTS } from '../../src/options.ts'
import { limits } from '../../src/render/fragments/limits.ts'
import { model, shortAntigravityModelName } from '../../src/render/fragments/model.ts'
import { makeTheme } from '../../src/theme/index.ts'

const exec = promisify(execFile)
const plain = makeTheme('graphite', true)

test('Antigravity model catalog shortens Gemini/Claude families, keeps Orchestrator variants and preserves other IDs', () => {
  const catalog: readonly [string, string, string, string | undefined][] = [
    ['gemini-4-carbon-medium', 'Gemini 4 Carbon (Medium)', 'carbon', 'medium'],
    ['gemini-4-carbon-high', 'Gemini 4 Carbon (High)', 'carbon', 'high'],
    ['gemini-4-carbon-low', 'Gemini 4 Carbon (Low)', 'carbon', 'low'],
    ['gemini-4-argon-medium', 'Gemini 4 Argon (Medium)', 'argon', 'medium'],
    ['gemini-4-argon-high', 'Gemini 4 Argon (High)', 'argon', 'high'],
    ['gemini-4-argon-low', 'Gemini 4 Argon (Low)', 'argon', 'low'],
    ['gemini-4-hydrogen-high', 'Gemini 4 Hydrogen (High)', 'hydrogen', 'high'],
    ['gemini-4-hydrogen-xhigh', 'Gemini 4 Hydrogen (XHigh)', 'hydrogen', 'xhigh'],
    ['gemini-4-hydrogen-medium', 'Gemini 4 Hydrogen (Medium)', 'hydrogen', 'medium'],
    ['gemini-4-hydrogen-low', 'Gemini 4 Hydrogen (Low)', 'hydrogen', 'low'],
    ['gemini-pro-orchestrator', 'Orchestrator (Carbon)', 'orchestrator(carbon)', undefined],
    ['gemini-pro-orchestrator-argon', 'Orchestrator (Argon)', 'orchestrator(argon)', undefined],
    ['gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)', 'flash', 'high'],
    ['gemini-3.8-flash-medium', 'Gemini 3.8 Flash (Medium)', 'flash', 'medium'],
    ['gemini-3.8-flash-low', 'Gemini 3.8 Flash (Low)', 'flash', 'low'],
    ['claude-opus-5-5-low', 'Claude Opus 5.5 (Low)', 'opus', 'low'],
    ['claude-opus-5-5-medium', 'Claude Opus 5.5 (Medium)', 'opus', 'medium'],
    ['claude-opus-5-5-high', 'Claude Opus 5.5 (High)', 'opus', 'high'],
    ['claude-sonnet-5-5-low', 'Claude Sonnet 5.5 (Low)', 'sonnet', 'low'],
    ['claude-sonnet-5-5-medium', 'Claude Sonnet 5.5 (Medium)', 'sonnet', 'medium'],
    ['claude-sonnet-5-5-high', 'Claude Sonnet 5.5 (High)', 'sonnet', 'high'],
    ['gpt-oss-120b-medium', 'GPT-OSS 120B (Medium)', 'gpt-oss-120b', 'medium'],
  ]

  for (const [slug, label, expectedName, expectedEffort] of catalog) {
    assert.equal(shortAntigravityModelName(label), expectedName, `display label ${label}`)
    assert.equal(shortAntigravityModelName(slug), expectedName, `slug ${slug}`)
    // Verify initial authenticating frames (where `model.effort` is omitted) infer effort
    // from `(Low|Medium|High|XHigh)` without mistaking `(Carbon)` or `(Argon)` for effort.
    const values = collectAntigravityPayload({ model: { id: label, display_name: label } })
    assert.equal(values.session.effort, expectedEffort, `inferred effort for ${label}`)
    const rendered = model({ v: values, o: DEFAULTS, l: en, t: plain, now: 0 })
    assert.equal(rendered, expectedEffort ? `${expectedName}:${expectedEffort}` : expectedName)
  }

  assert.equal(shortAntigravityModelName('vendor/qwen-3-coder'), 'vendor/qwen-3-coder')
  assert.equal(shortAntigravityModelName('qwen-vl-max'), 'qwen-vl-max')
  assert.equal(shortAntigravityModelName('alibaba/qwen-3-max'), 'alibaba/qwen-3-max')
  assert.equal(shortAntigravityModelName('Gemini 2.5 Flash-Lite'), 'flash-lite')
  assert.equal(shortAntigravityModelName('Gemini 2.5 Flash Lite (Low)'), 'flash-lite')
})

test('Antigravity quota maps active model group, skips disabled or expired windows, and supports otherModelWeekly', () => {
  const now = Date.parse('2026-11-14T01:00:00Z')
  const quota: NonNullable<AntigravityPayload['quota']> = {
    'gemini-5h': { remaining_fraction: 0.96, reset_time: '2026-11-14T05:37:00Z' },
    'gemini-weekly': { remaining_fraction: 0.61, reset_time: '2026-11-20T07:00:00Z' },
    '3p-5h': { remaining_fraction: 0.75, reset_time: '2026-11-14T04:00:00Z' },
    '3p-weekly': { remaining_fraction: 0.15, reset_time: '2026-11-18T01:00:00Z' },
  }

  const geminiValues = collectAntigravityPayload({
    model: { display_name: 'Gemini 4 Carbon (High)', effort: 'high' },
    quota,
  }, { now })
  assert.equal(limits({ v: geminiValues, o: DEFAULTS, l: en, t: plain, now }), '5h:4%(4h37m) 7d:39%(6d6h)')
  assert.equal(
    limits({ v: geminiValues, o: { ...DEFAULTS, otherModelWeekly: true }, l: en, t: plain, now }),
    '5h:4%(4h37m) 7d:39%(6d6h) 3p:85%(4d0h)',
  )

  const claudeValues = collectAntigravityPayload({
    model: { display_name: 'Claude Opus 5.5 (High)', effort: 'high' },
    quota,
  }, { now })
  assert.equal(limits({ v: claudeValues, o: DEFAULTS, l: en, t: plain, now }), '5h:25%(3h0m) 7d:85%(4d0h)')
  // Gemini weekly is 39% (< 80%), so `otherModelWeekly` leaves `gm` hidden until 80%.
  assert.equal(
    limits({ v: claudeValues, o: { ...DEFAULTS, otherModelWeekly: true }, l: en, t: plain, now }),
    '5h:25%(3h0m) 7d:85%(4d0h)',
  )

  // When a known model group's own buckets (`3p-*`) are disabled or missing, it never
  // falls back to `gemini-*` for `5h:`/`7d:` or duplicates `gm:` alongside `7d:`.
  const disabled3pValues = collectAntigravityPayload({
    model: { display_name: 'Claude Opus 5.5 (High)', effort: 'high' },
    quota: {
      'gemini-5h': { remaining_fraction: 0.9, reset_time: '2026-11-14T05:37:00Z' },
      'gemini-weekly': { remaining_fraction: 0.1, reset_time: '2026-11-20T07:00:00Z' },
      '3p-5h': { remaining_fraction: 0.5, disabled: true, reset_time: '2026-11-14T04:00:00Z' },
      '3p-weekly': { remaining_fraction: 0.5, disabled: true, reset_time: '2026-11-18T01:00:00Z' },
    },
  }, { now })
  assert.equal(limits({ v: disabled3pValues, o: DEFAULTS, l: en, t: plain, now }), null)
  assert.equal(
    limits({ v: disabled3pValues, o: { ...DEFAULTS, otherModelWeekly: true }, l: en, t: plain, now }),
    'gm:90%(6d6h)',
  )

  // Disabled buckets and windows already past reset (`reset_time <= now` or `reset_in_seconds <= 0`)
  // are omitted; custom single suffix falls back cleanly; out-of-range `reset_in_seconds` never throws.
  const fallbackValues = collectAntigravityPayload({
    model: { display_name: 'vendor/gateway-model' },
    quota: {
      'enterprise-5h': { remaining_fraction: 0.5, reset_in_seconds: 3600 },
      'enterprise-weekly': { remaining_fraction: 0.2, disabled: true, reset_time: '2026-11-20T01:00:00Z' },
    },
  }, { now })
  assert.equal(limits({ v: fallbackValues, o: DEFAULTS, l: en, t: plain, now }), '5h:50%(1h0m)')

  const expiredAndHugeValues = collectAntigravityPayload({
    model: { display_name: 'Gemini 4 Carbon (High)', effort: 'high' },
    quota: {
      'gemini-5h': { remaining_fraction: 0.4, reset_in_seconds: 0 },
      'gemini-weekly': { remaining_fraction: 0.3, reset_in_seconds: 1e15 },
      '3p-weekly': { remaining_fraction: 0.05, reset_time: '2026-11-14T00:59:59Z' },
    },
  }, { now })
  assert.equal(
    limits({ v: expiredAndHugeValues, o: { ...DEFAULTS, otherModelWeekly: true }, l: en, t: plain, now }),
    '7d:70%',
  )
})

test('resolveTranscriptPath handles Antigravity 1.5.8 antigravity-vs-antigravity-cli path mismatch and rejects unsafe IDs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vargus-agy-path-'))
  try {
    const id = '169d1dc1-ce47-41ff-a9d2-fdea529d3fd3'
    const cliTranscript = join(root, '.gemini', 'antigravity-cli', 'brain', id, '.system_generated', 'logs', 'transcript.jsonl')
    await mkdir(join(cliTranscript, '..'), { recursive: true })
    await writeFile(cliTranscript, '{"step_index":0}\n')

    // Pre-turn payload with empty conversation_id returns null.
    assert.equal(await resolveTranscriptPath({
      conversation_id: '',
      transcript_path: join(root, '.gemini', 'antigravity', 'brain', '.system_generated', 'logs', 'transcript.jsonl'),
    }, { home: root }), null)

    // Traversal IDs, unrelated paths, and dot-segment escapes out of `/brain/<id>/` are rejected.
    assert.equal(await resolveTranscriptPath({
      conversation_id: '../outside',
      transcript_path: cliTranscript,
    }, { home: root }), null)

    const outsideFile = join(root, 'secret.jsonl')
    await writeFile(outsideFile, '{"step_index":0}\n')
    const backslashFile = `${root}/evil\\brain\\${id}\\transcript.jsonl`
    await writeFile(backslashFile, '{"step_index":0}\n').catch(() => {})
    assert.equal(await resolveTranscriptPath({
      conversation_id: id,
      transcript_path: outsideFile,
    }, {}), null)
    // Pass raw unnormalized strings (not `path.join`) so dot-segment and backslash
    // escape attempts reach `resolveTranscriptPath` uncollapsed.
    assert.equal(await resolveTranscriptPath({
      conversation_id: id,
      transcript_path: `${root}/brain/${id}/../../secret.jsonl`,
    }, {}), null)
    assert.equal(await resolveTranscriptPath({
      conversation_id: id,
      transcript_path: `${root}/x\\brain\\${id}\\y/../secret.jsonl`,
    }, {}), null)
    assert.equal(await resolveTranscriptPath({
      conversation_id: id,
      transcript_path: backslashFile,
    }, {}), null)

    // Cross-platform unit checks on Windows drive & UNC containment rules.
    assert.equal(
      resolveContainedTranscriptCandidate(`C:\\Users\\alice\\brain\\${id}\\..\\..\\secret.jsonl`, id, 'win32'),
      null,
    )
    assert.equal(
      resolveContainedTranscriptCandidate(`\\\\brain\\${id}\\secret.jsonl`, id, 'win32'),
      null,
    )
    assert.equal(
      resolveContainedTranscriptCandidate(
        `C:/Users/alice/.gemini/antigravity/brain/${id}/.system_generated/logs/transcript.jsonl`,
        id,
        'win32',
      ),
      `C:\\Users\\alice\\.gemini\\antigravity\\brain\\${id}\\.system_generated\\logs\\transcript.jsonl`,
    )

    // Antigravity 1.5.8 sends `.gemini/antigravity/brain/<id>/...` while CLI writes `.gemini/antigravity-cli/brain/<id>/...`.
    const reportedIdePath = join(root, '.gemini', 'antigravity', 'brain', id, '.system_generated', 'logs', 'transcript.jsonl')
    assert.equal(await resolveTranscriptPath({
      conversation_id: id,
      transcript_path: reportedIdePath,
    }, { home: root }), cliTranscript)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('readTranscriptState incrementally counts uncached tokens, tools, agents, workflows and Antigravity skills', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vargus-agy-transcript-'))
  try {
    const cacheDir = join(root, 'cache')
    const home = join(root, 'home')
    const customAppData = join(root, 'custom-appdata')
    const workspace = join(root, 'repo')
    const subpkg = join(workspace, 'packages', 'web')
    await mkdir(join(workspace, '.agents'), { recursive: true })
    await mkdir(join(subpkg, '.agents'), { recursive: true })
    await mkdir(join(subpkg, 'local-skills'), { recursive: true })
    await writeFile(join(workspace, '.agents', 'skills.json'), JSON.stringify({
      entries: [{ path: 'tools/team-skills' }],
    }))
    // Subdirectory `.agents/skills.json` checks `declaringDir` first (`local-skills`),
    // falls back to `projectDir` (`root-fallback-skills`), expands `~//` under `home`,
    // and normalizes Windows drive paths without prepending POSIX `process.cwd()`.
    await writeFile(join(subpkg, '.agents', 'skills.json'), JSON.stringify({
      entries: [
        { path: 'local-skills' },
        { path: 'root-fallback-skills' },
        { path: '~//shared-skills' },
        { path: 'C:\\Team\\WinSkills\\..\\CustomSkills' },
      ],
    }))

    const id = 'conv-1'
    const transcript = join(home, '.gemini', 'antigravity-cli', 'brain', id, '.system_generated', 'logs', 'transcript.jsonl')
    await mkdir(join(transcript, '..'), { recursive: true })

    const builtinSkill = join(home, '.gemini', 'antigravity-cli', 'builtin', 'skills', 'antigravity_guide', 'SKILL.md')
    const customPluginSkill = join(customAppData, 'builtin', 'plugins', 'core-pack', 'skills', 'helper', 'SKILL.md')
    const dotSkill = join(workspace, '.agents', 'skills', 'deploy', 'SKILL.md')
    const manifestSkill = join(workspace, 'tools', 'team-skills', 'lint', 'SKILL.md')
    const subpkgLocalSkill = join(subpkg, 'local-skills', 'ui', 'SKILL.md')
    const rootFallbackSkill = join(workspace, 'root-fallback-skills', 'ci', 'SKILL.md')
    const homeTildeSkill = join(home, 'shared-skills', 'ops', 'SKILL.md')
    const windowsCustomSkill = 'c:\\Team\\CustomSkills\\ps\\SKILL.md'
    const unrelatedRepoSkill = join(workspace, 'skills', 'claude-only', 'SKILL.md')

    const firstLine = JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-14T00:36:00Z' })
    const lines1 = [
      firstLine,
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-14T00:36:02Z',
        input_tokens: 10000,
        cache_read_tokens: 50000,
        output_tokens: 500,
        tool_calls: [
          { name: 'read_file', args: { Path: JSON.stringify(builtinSkill), StartLine: '1', EndLine: '50' } },
          // Second chunk read of the same skill in the same turn does not double-count `skills`.
          { name: 'read_file', args: { Path: JSON.stringify(builtinSkill), StartLine: '51', EndLine: '100' } },
          // Reading an ordinary repo file named SKILL.md outside Antigravity roots counts as a tool, not a skill.
          { name: 'read_file', args: { Path: JSON.stringify(unrelatedRepoSkill) } },
          { name: 'invoke_subagent', args: { TypeName: '"research"', Role: '"Explorer"', Prompt: '"Check"' } },
          { name: 'run_workflow', args: { Description: '"Fan out"' } },
        ],
      }),
    ].join('\n') + '\n'
    await writeFile(transcript, lines1)

    const ctx = { cwd: subpkg, projectDir: workspace, home, appDataDir: customAppData }
    const s1 = await readTranscriptState(transcript, cacheDir, ctx)
    assert.equal(s1.startedAt, Date.parse('2026-11-14T00:36:00Z'))
    assert.deepEqual(s1.counts, {
      tokens: 10500,
      tools: 5,
      agents: 1,
      skills: 1,
      workflows: 1,
    })
    assert.equal(s1.mutatingToolsSeen, 0)

    // Append an incomplete line without trailing newline: held back until `\n` arrives.
    const partialStep = JSON.stringify({
      step_index: 2,
      type: 'USER_INPUT',
      created_at: '2026-11-14T00:37:00Z',
    })
    await appendFile(transcript, partialStep.slice(0, 20))
    const sPartial = await readTranscriptState(transcript, cacheDir, ctx)
    assert.deepEqual(sPartial.counts, s1.counts)

    // Complete step 2 + add turn 2 with swarm add, compaction checkpoint, and declared/workspace/plugin skills.
    const rest = partialStep.slice(20) + '\n' + [
      JSON.stringify({
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-14T00:37:05Z',
        input_tokens: 2000,
        cache_read_tokens: 60000,
        output_tokens: 300,
        tool_calls: [
          { name: 'read_file', args: { Path: JSON.stringify(builtinSkill) } },
          { name: 'read_file', args: { Path: JSON.stringify(customPluginSkill) } },
          { name: 'read_file', args: { Path: JSON.stringify(dotSkill) } },
          { name: 'read_file', args: { Path: JSON.stringify(manifestSkill) } },
          { name: 'read_file', args: { Path: JSON.stringify(subpkgLocalSkill) } },
          { name: 'read_file', args: { Path: JSON.stringify(rootFallbackSkill) } },
          { name: 'read_file', args: { Path: JSON.stringify(homeTildeSkill) } },
          { name: 'read_file', args: { Path: JSON.stringify(windowsCustomSkill) } },
          { name: 'swarm', args: { action: '"add"', tasks: '["a","b"]' } },
          { name: 'swarm', args: { action: '"status"' } },
          { name: 'write_file', args: { Path: JSON.stringify(join(workspace, 'out.txt')), Content: '"ok"' } },
        ],
      }),
      JSON.stringify({
        step_index: 4,
        type: 'CHECKPOINT',
        created_at: '2026-11-14T00:38:00Z',
        input_tokens: 1000,
        cache_read_tokens: 70000,
        output_tokens: 200,
      }),
    ].join('\n') + '\n'
    await appendFile(transcript, rest)

    const s2 = await readTranscriptState(transcript, cacheDir, ctx)
    assert.deepEqual(s2.counts, {
      tokens: 10500 + 2300 + 1200,
      tools: 5 + 11,
      agents: 1 + 2,
      skills: 1 + 8,
      workflows: 1,
    })
    assert.equal(s2.mutatingToolsSeen, 1)

    // Mid-transcript `/rewind` rewrite: same line 1 and larger total byte length,
    // but modified bytes before `cached.size`. `tailHash` invalidates and replays from byte 0.
    const rewound = [
      firstLine,
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-14T00:39:00Z',
        input_tokens: 800,
        output_tokens: 100,
        padding: 'x'.repeat(lines1.length + rest.length + 512),
      }),
    ].join('\n') + '\n'
    await writeFile(transcript, rewound)
    const sRewound = await readTranscriptState(transcript, cacheDir, ctx)
    assert.deepEqual(sRewound.counts, { tokens: 900, tools: 0, agents: 0, skills: 0, workflows: 0 })
    assert.equal(sRewound.mutatingToolsSeen, 0)

    // Replacing the transcript with a new conversation resets from byte 0.
    await writeFile(transcript, JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-14T01:00:00Z' }) + '\n')
    const sReset = await readTranscriptState(transcript, cacheDir, ctx)
    assert.equal(sReset.startedAt, Date.parse('2026-11-14T01:00:00Z'))
    assert.deepEqual(sReset.counts, { tokens: 0, tools: 0, agents: 0, skills: 0, workflows: 0 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('readCachedGit honours 5s polling, mutating-tool invalidation, linked worktrees and detachedHead', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vargus-agy-git-'))
  try {
    const cacheDir = join(root, 'cache')
    const repoDir = join(root, 'repo')
    await mkdir(repoDir, { recursive: true })
    const git = (cwd: string, args: string[]) => exec('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    })

    await git(repoDir, ['init', '-b', 'main'])
    await git(repoDir, ['remote', 'add', 'origin', 'https://github.com/zhoufanscut/VArgus.git'])
    await writeFile(join(repoDir, 'a.txt'), 'one\n')
    await git(repoDir, ['add', 'a.txt'])
    await git(repoDir, ['commit', '-m', 'init'])
    await git(repoDir, ['tag', 'v1.0.0'])

    const t0 = 1_000_000
    const first = await readCachedGit(repoDir, false, 'session-a', 0, cacheDir, t0)
    assert.equal(first.kind, 'git')
    assert.equal(first.repo, 'VArgus')
    assert.equal(first.branch, 'main')
    assert.equal(first.counts?.untracked, 0)

    // Create an untracked file; within POLL_MS with no mutating tool, cached counts stay.
    await writeFile(join(repoDir, 'untracked.txt'), 'new\n')
    const cachedHit = await readCachedGit(repoDir, false, 'session-a', 0, cacheDir, t0 + 500)
    assert.equal(cachedHit.counts?.untracked, 0)

    // A mutating tool in the same session invalidates the poll window (past 10x lastMs).
    const afterTool = await readCachedGit(repoDir, false, 'session-a', 1, cacheDir, t0 + 2000)
    assert.equal(afterTool.counts?.untracked, 1)

    // Past POLL_MS, external changes also show without a tool call.
    await rm(join(repoDir, 'untracked.txt'))
    const tAfterPoll = t0 + 2000 + POLL_MS + 2000
    const afterPoll = await readCachedGit(repoDir, false, 'session-a', 1, cacheDir, tAfterPoll)
    assert.equal(afterPoll.counts?.untracked, 0)

    // Lowering `mutatingToolsSeen` (after `/rewind`) updates the baseline in cache so the
    // next mutating tool (`0 -> 1`) invalidates immediately within `POLL_MS`.
    await readCachedGit(repoDir, false, 'session-a', 0, cacheDir, tAfterPoll + 500)
    await writeFile(join(repoDir, 'after-rewind.txt'), 'new\n')
    const afterRewindTool = await readCachedGit(repoDir, false, 'session-a', 1, cacheDir, tAfterPoll + 2000)
    assert.equal(afterRewindTool.counts?.untracked, 1)

    // Backward wall-clock jump (`now < cached.lastEnd`) refreshes instead of freezing.
    await rm(join(repoDir, 'after-rewind.txt'))
    const afterClockJump = await readCachedGit(repoDir, false, 'session-a', 1, cacheDir, t0)
    assert.equal(afterClockJump.counts?.untracked, 0)

    // Linked worktree + detached HEAD: worktree add --detach shows short SHA;
    // `git checkout v1.0.0` records the reflog entry and names `v1.0.0`.
    const wtDir = join(root, 'wt-feature')
    await git(repoDir, ['worktree', 'add', '--detach', wtDir, 'v1.0.0'])
    const detachedOff = await readCachedGit(wtDir, false, 'session-b', 0, cacheDir, t0 + 20_000)
    assert.equal(detachedOff.worktree, 'wt-feature')
    assert.equal(detachedOff.branch, null)
    assert.equal(detachedOff.detached, null)

    const detachedSha = await readCachedGit(wtDir, true, 'session-b', 0, cacheDir, t0 + 20_000)
    assert.equal(detachedSha.worktree, 'wt-feature')
    assert.match(detachedSha.detached?.name ?? '', /^[0-9a-f]{7}$/)

    await git(wtDir, ['checkout', '-B', 'temp-branch'])
    await git(wtDir, ['checkout', 'v1.0.0'])
    const detachedTag = await readCachedGit(wtDir, true, 'session-b', 1, cacheDir, t0 + 30_000)
    assert.deepEqual(detachedTag.detached, { name: 'v1.0.0', onBranch: false, operation: null, progress: '' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('vargus statusline CLI renders end-to-end with themes, config, NO_COLOR, WSL labels and terminal_width', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vargus-agy-cli-'))
  try {
    const id = '39f30479-0e87-4a15-9bd3-b11ad9452046'
    const home = join(root, 'home')
    const workspace = join(home, 'proj', 'demo')
    await mkdir(workspace, { recursive: true })
    const transcript = join(home, '.gemini', 'antigravity-cli', 'brain', id, '.system_generated', 'logs', 'transcript.jsonl')
    await mkdir(join(transcript, '..'), { recursive: true })
    const startedIso = new Date(Date.now() - 24 * 60_000).toISOString()
    await writeFile(transcript, [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: startedIso }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: startedIso,
        input_tokens: 12000,
        output_tokens: 400,
        tool_calls: [{ name: 'run_command', args: { CommandLine: '"ls"' } }],
      }),
    ].join('\n') + '\n')
    // Touch an old cache file to exercise cache pruning without error.
    const cacheDir = join(root, 'cache')
    await mkdir(cacheDir, { recursive: true })
    const staleFile = join(cacheDir, 'stale.json')
    await writeFile(staleFile, '{}')
    const oldTime = new Date(Date.now() - 48 * 3600_000)
    await utimes(staleFile, oldTime, oldTime)

    const payload: AntigravityPayload = {
      cwd: workspace,
      session_id: id,
      conversation_id: id,
      transcript_path: join(home, '.gemini', 'antigravity', 'brain', id, '.system_generated', 'logs', 'transcript.jsonl'),
      model: { id: 'Gemini 4 Carbon (High)', display_name: 'Gemini 4 Carbon (High)', effort: 'high' },
      workspace: { current_dir: workspace, project_dir: workspace },
      context_window: {
        total_input_tokens: 209715,
        total_output_tokens: 400,
        context_window_size: 1048576,
        used_percentage: 20,
      },
      quota: {
        'gemini-5h': { remaining_fraction: 0.96, reset_in_seconds: 16620 },
        'gemini-weekly': { remaining_fraction: 0.61, reset_in_seconds: 453600 },
      },
      terminal_width: 200,
    }

    const wslLine = await renderAntigravityStatusLine(payload, {
      home,
      isWsl: true,
      noColor: true,
      cacheDir,
    })
    assert.match(wslLine, /^  ~\/proj\/demo \| carbon:high \| 5h:4%\(4h3\dm\) 7d:39%\(5d6h\) \| ctx:20% \| token:12\.4k \| session:24m \| T:1$/)

    const narrowLine = await renderAntigravityStatusLine({ ...payload, terminal_width: 32 }, {
      home,
      noColor: true,
      cacheDir,
    })
    assert.equal(narrowLine, '  ~/proj/demo | carbon:high')

    // `terminal_width` reserves 2 columns for leading padding (`26 - 2 = 24 < 25`),
    // dropping `| carbon:high` so the indented row never wraps at 26 columns.
    const tightLine = await renderAntigravityStatusLine({ ...payload, terminal_width: 26 }, {
      home,
      noColor: true,
      cacheDir,
    })
    assert.equal(tightLine, '  ~/proj/demo')

    // Subprocess check through bin/vargus statusline with --config and --theme.
    const configPath = join(root, 'vargus.json')
    await writeFile(configPath, JSON.stringify({ callCounts: false, session: false }))
    const bin = resolve('bin/vargus')
    const runStatusline = (args: string[], stdinText: string, extraEnv: NodeJS.ProcessEnv = {}) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
        const child = spawn(bin, ['statusline', ...args], {
          env: { ...process.env, HOME: home, ...extraEnv },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', d => { stdout += d })
        child.stderr.on('data', d => { stderr += d })
        child.on('error', reject)
        child.on('close', code => resolvePromise({ code, stdout, stderr }))
        child.stdin.end(stdinText)
      })

    const colored = await runStatusline(['--theme', 'aurora', '--config', configPath], JSON.stringify(payload), { NO_COLOR: '' })
    assert.equal(colored.code, 0, colored.stderr)
    assert.ok(colored.stdout.includes('\x1b[38;2;'), 'expected 24-bit ANSI SGR output')
    assert.ok(!colored.stdout.includes('session:'), 'config should disable session fragment')
    assert.ok(!colored.stdout.includes('🔧'), 'config should disable callCounts fragment')

    const noColor = await runStatusline(['--config', configPath], JSON.stringify(payload), { NO_COLOR: '1' })
    assert.equal(noColor.code, 0, noColor.stderr)
    assert.ok(!noColor.stdout.includes('\x1b['), 'NO_COLOR must strip all ANSI codes')
    assert.match(noColor.stdout.replace(/\r?\n$/, ''), /^  ~\/proj\/demo \| carbon:high \| 5h:4%\(4h3\dm\) 7d:39%\(5d6h\) \| ctx:20% \| token:12\.4k$/)

    // Empty stdin and JSON array payloads exit 0 quietly so Antigravity never counts them as failures.
    const emptyRes = await runStatusline([], '')
    assert.equal(emptyRes.code, 0)
    assert.equal(emptyRes.stdout, '')
    const arrayRes = await runStatusline([], '[]')
    assert.equal(arrayRes.code, 0)
    assert.equal(arrayRes.stdout, '')

    // Multi-byte UTF-8 paths split mid-codepoint across stdin chunks decode cleanly without U+FFFD.
    const utf8Cwd = join(home, '项目🚀')
    const utf8Payload = Buffer.from(JSON.stringify({
      cwd: utf8Cwd,
      workspace: { current_dir: utf8Cwd, project_dir: utf8Cwd },
      model: { display_name: 'Gemini 4 Carbon (High)', effort: 'high' },
      terminal_width: 120,
    }), 'utf8')
    const chunkedUtf8 = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
      const child = spawn(bin, ['statusline', '--config', configPath], {
        env: { ...process.env, HOME: home, NO_COLOR: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', d => { stdout += d })
      child.stderr.on('data', d => { stderr += d })
      child.on('error', reject)
      child.on('close', code => resolvePromise({ code, stdout, stderr }))
      for (let offset = 0; offset < utf8Payload.length; offset += 2) {
        child.stdin.write(utf8Payload.subarray(offset, offset + 2))
      }
      child.stdin.end()
    })
    assert.equal(chunkedUtf8.code, 0, chunkedUtf8.stderr)
    assert.ok(chunkedUtf8.stdout.startsWith('  ~/项目🚀 | carbon:high'), `got: ${chunkedUtf8.stdout}`)
    assert.ok(!chunkedUtf8.stdout.includes('\ufffd'), 'must not corrupt split UTF-8 byte sequences')

    // Bad flag exits non-zero with a clear error.
    const badFlag = await runStatusline(['--bogus', '1'], '{}')
    assert.equal(badFlag.code, 1)
    assert.match(badFlag.stderr, /Unknown VArgus option: --bogus/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
