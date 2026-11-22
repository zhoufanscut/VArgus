import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { fixtureCheckout } from '../checkout.mts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { renderAntigravityStatusLine } from '../../src/cli/antigravity.ts'
import { collectAntigravityPayload, type AntigravityPayload } from '../../src/hosts/antigravity/collect.ts'
import { cachePath } from '../../src/hosts/antigravity/cache.ts'
import {
  advanceAntigravityRate,
  baseModelKey,
  payloadFingerprint,
  updateAntigravityRate,
} from '../../src/hosts/antigravity/rate.ts'
import {
  readTranscriptState,
  resolveContainedTranscriptCandidate,
  resolveTranscriptPath,
  type TranscriptState,
} from '../../src/hosts/antigravity/transcript.ts'
import { POLL_MS, readCachedGit } from '../../src/hosts/antigravity/vcs.ts'
import { en } from '../../src/i18n/en.ts'
import { DEFAULTS } from '../../src/options.ts'
import { limits } from '../../src/render/fragments/limits.ts'
import { antigravityDisplay, shortAntigravityModelName } from '../../src/hosts/antigravity/display.ts'
import { model } from '../../src/render/fragments/model.ts'
import { makeTheme } from '../../src/theme/index.ts'

const exec = promisify(execFile)
const plain = makeTheme('graphite', true)

test('a failed Antigravity refresh retains the same conversation’s last row until recovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-agy-stale-'))
  const cacheDir = join(dir, 'cache'), brain = join(dir, 'brain', 'alpha')
  const runtime = { cacheDir, home: dir, noColor: true, givenOptions: { repo: false, branch: false, status: false } }
  const transcript = join(brain, 'transcript.jsonl')
  const payload = { conversation_id: 'alpha', model: 'gemini-4-carbon', cwd: '/repo', transcript_path: transcript }
  const transcriptCache = cachePath(cacheDir, 'transcript', transcript)
  try {
    await mkdir(brain, { recursive: true })
    await writeFile(transcript, '{}\n')
    const healthy = await renderAntigravityStatusLine(payload, runtime)
    const saved = await readFile(transcriptCache, 'utf8')
    // The next incremental read cannot restore this damaged skill list.
    await writeFile(transcriptCache, JSON.stringify({ ...JSON.parse(saved), seenSkillsInTurn: 42 }))
    await appendFile(transcript, '{}\n')
    assert.equal(await renderAntigravityStatusLine(payload, runtime), healthy + ' | ⚠ stale')
    const other = await renderAntigravityStatusLine({ ...payload, conversation_id: 'beta', model: 'gemini-4-argon' }, runtime)
    assert.match(other, /argon/)
    assert.doesNotMatch(other, /carbon|stale/)
    assert.equal(await renderAntigravityStatusLine(payload, runtime), healthy + ' | ⚠ stale')
    await writeFile(transcriptCache, saved)
    assert.equal(await renderAntigravityStatusLine(payload, runtime), healthy)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

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
    const rendered = model({ v: values, display: antigravityDisplay(values.session), o: DEFAULTS, l: en, t: plain, now: 0 })
    assert.equal(rendered, expectedEffort ? `${expectedName}:${expectedEffort}` : expectedName)
  }

  assert.equal(shortAntigravityModelName('vendor/qwen-3-coder'), 'vendor/qwen-3-coder')
  assert.equal(shortAntigravityModelName('qwen-vl-max'), 'qwen-vl-max')
  assert.equal(shortAntigravityModelName('alibaba/qwen-3-max'), 'alibaba/qwen-3-max')
  assert.equal(shortAntigravityModelName('Gemini 2.5 Flash-Lite'), 'flash-lite')
  assert.equal(shortAntigravityModelName('Gemini 2.5 Flash Lite (Low)'), 'flash-lite')
  assert.equal(shortAntigravityModelName('  '), null)
})

test('Antigravity colour follows the published default or the high cutoff', () => {
  const theme = makeTheme('graphite', false)
  for (const [payload, name, effort, color, defaultEffort] of [
    [{ display_name: 'Gemini 4 Hydrogen (Medium)' }, 'hydrogen', 'medium', 'gradHigh', 'high'],
    [{ display_name: 'Gemini 4 Hydrogen (High)' }, 'hydrogen', 'high', 'gradLow', 'high'],
    [{ id: 'gemini-4-neon-xhigh', display_name: 'Gemini 4 Neon (XHigh)', effort: 'xhigh' }, 'neon', 'xhigh', 'gradLow', 'high'],
    [{ display_name: 'Gemini 4 Carbon (Medium)' }, 'carbon', 'medium', 'gradHigh', undefined],
    [{ display_name: 'Gemini 4 Carbon (High)' }, 'carbon', 'high', 'gradLow', undefined],
  ] as const) {
    const v = collectAntigravityPayload({ model: payload })
    assert.equal(v.session.defaultEffort, defaultEffort)
    const display = antigravityDisplay(v.session)
    assert.equal(model({ v, display, o: DEFAULTS, l: en, t: theme, now: 0 }),
      theme.paint('label', `${name}:`) + theme.paint(color, effort))
  }
})

test('Antigravity quota maps active model group and skips disabled or expired windows', () => {
  const now = Date.parse('2026-11-14T01:00:00Z')
  function draw(payload: AntigravityPayload) {
    const v = collectAntigravityPayload(payload, { now })
    return limits({ v, display: antigravityDisplay(v.session), o: DEFAULTS, l: en, t: plain, now })
  }
  const quota: NonNullable<AntigravityPayload['quota']> = {
    'gemini-5h': { remaining_fraction: 0.96, reset_time: '2026-11-14T05:37:00Z' },
    'gemini-weekly': { remaining_fraction: 0.61, reset_time: '2026-11-20T07:00:00Z' },
    '3p-5h': { remaining_fraction: 0.75, reset_time: '2026-11-14T04:00:00Z' },
    '3p-weekly': { remaining_fraction: 0.15, reset_time: '2026-11-18T01:00:00Z' },
  }

  const gemini = {
    model: { display_name: 'Gemini 4 Carbon (High)', effort: 'high' },
    quota,
  }
  assert.equal(draw(gemini), '5h:4%(4h37m) 7d:39%(6d6h)')

  const claude = {
    model: { display_name: 'Claude Opus 5.5 (High)', effort: 'high' },
    quota,
  }
  assert.equal(draw(claude), '5h:25%(3h0m) 7d:85%(4d0h)')

  // A known model group with disabled buckets has no quota to display.
  const disabled3p = {
    model: { display_name: 'Claude Opus 5.5 (High)', effort: 'high' },
    quota: {
      'gemini-5h': { remaining_fraction: 0.9, reset_time: '2026-11-14T05:37:00Z' },
      'gemini-weekly': { remaining_fraction: 0.1, reset_time: '2026-11-20T07:00:00Z' },
      '3p-5h': { remaining_fraction: 0.5, disabled: true, reset_time: '2026-11-14T04:00:00Z' },
      '3p-weekly': { remaining_fraction: 0.5, disabled: true, reset_time: '2026-11-18T01:00:00Z' },
    },
  }
  assert.equal(draw(disabled3p), null)

  // Disabled buckets and windows already past reset (`reset_time <= now` or `reset_in_seconds <= 0`)
  // are omitted; custom single suffix falls back cleanly; out-of-range `reset_in_seconds` never throws.
  const fallback = {
    model: { display_name: 'vendor/gateway-model' },
    quota: {
      'enterprise-5h': { remaining_fraction: 0.5, reset_in_seconds: 3600 },
      'enterprise-weekly': { remaining_fraction: 0.2, disabled: true, reset_time: '2026-11-20T01:00:00Z' },
    },
  }
  assert.equal(draw(fallback), '5h:50%(1h0m)')

  const expiredAndHuge = {
    model: { display_name: 'Gemini 4 Carbon (High)', effort: 'high' },
    quota: {
      'gemini-5h': { remaining_fraction: 0.4, reset_in_seconds: 0 },
      'gemini-weekly': { remaining_fraction: 0.3, reset_in_seconds: 1e15 },
      '3p-weekly': { remaining_fraction: 0.05, reset_time: '2026-11-14T00:59:59Z' },
    },
  }
  assert.equal(draw(expiredAndHuge), '7d:70%')
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

test('readTranscriptState incrementally counts uncached tokens, tools, agents and Antigravity skills', async () => {
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
    })
    assert.equal(s1.mutatingToolsSeen, 0)

    // Resume a cache written by a version that tracked workflow runs.
    const cacheFile = cachePath(cacheDir, 'transcript', transcript)
    const cached = JSON.parse(await readFile(cacheFile, 'utf8'))
    cached.counts.workflows = 1
    await writeFile(cacheFile, JSON.stringify(cached))
    assert.deepEqual((await readTranscriptState(transcript, cacheDir, ctx)).counts, s1.counts)

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
    assert.deepEqual(sRewound.counts, { tokens: 900, tools: 0, agents: 0, skills: 0 })
    assert.equal(sRewound.mutatingToolsSeen, 0)

    // Replacing the transcript with a new conversation resets from byte 0.
    await writeFile(transcript, JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-14T01:00:00Z' }) + '\n')
    const sReset = await readTranscriptState(transcript, cacheDir, ctx)
    assert.equal(sReset.startedAt, Date.parse('2026-11-14T01:00:00Z'))
    assert.deepEqual(sReset.counts, { tokens: 0, tools: 0, agents: 0, skills: 0 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('readCachedGit honours 5s polling, mutating-tool invalidation, linked worktrees and detached refs', async () => {
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
    const first = await readCachedGit(repoDir, 'session-a', 0, cacheDir, t0)
    assert.equal(first.kind, 'git')
    assert.equal(first.repo, 'VArgus')
    assert.equal(first.branch, 'main')
    assert.equal(first.counts?.untracked, 0)

    // Create an untracked file; within POLL_MS with no mutating tool, cached counts stay.
    await writeFile(join(repoDir, 'untracked.txt'), 'new\n')
    const cachedHit = await readCachedGit(repoDir, 'session-a', 0, cacheDir, t0 + 500)
    assert.equal(cachedHit.counts?.untracked, 0)

    // A mutating tool in the same session invalidates the poll window (past 10x lastMs).
    const afterTool = await readCachedGit(repoDir, 'session-a', 1, cacheDir, t0 + 2000)
    assert.equal(afterTool.counts?.untracked, 1)

    // Past POLL_MS, external changes also show without a tool call.
    await rm(join(repoDir, 'untracked.txt'))
    const tAfterPoll = t0 + 2000 + POLL_MS + 2000
    const afterPoll = await readCachedGit(repoDir, 'session-a', 1, cacheDir, tAfterPoll)
    assert.equal(afterPoll.counts?.untracked, 0)

    // Lowering `mutatingToolsSeen` (after `/rewind`) updates the baseline in cache so the
    // next mutating tool (`0 -> 1`) invalidates immediately within `POLL_MS`.
    await readCachedGit(repoDir, 'session-a', 0, cacheDir, tAfterPoll + 500)
    await writeFile(join(repoDir, 'after-rewind.txt'), 'new\n')
    const afterRewindTool = await readCachedGit(repoDir, 'session-a', 1, cacheDir, tAfterPoll + 2000)
    assert.equal(afterRewindTool.counts?.untracked, 1)

    // Backward wall-clock jump (`now < cached.lastEnd`) refreshes instead of freezing.
    await rm(join(repoDir, 'after-rewind.txt'))
    const afterClockJump = await readCachedGit(repoDir, 'session-a', 1, cacheDir, t0)
    assert.equal(afterClockJump.counts?.untracked, 0)

    // Linked worktree + detached HEAD: worktree add --detach shows short SHA;
    // `git checkout v1.0.0` records the reflog entry and names `v1.0.0`.
    const wtDir = join(root, 'wt-feature')
    await git(repoDir, ['worktree', 'add', '--detach', wtDir, 'v1.0.0'])
    const detachedSha = await readCachedGit(wtDir, 'session-b', 0, cacheDir, t0 + 20_000)
    assert.equal(detachedSha.worktree, 'wt-feature')
    assert.equal(detachedSha.branch, null)
    assert.match(detachedSha.detached?.name ?? '', /^[0-9a-f]{7}$/)

    await git(wtDir, ['checkout', '-B', 'temp-branch'])
    await git(wtDir, ['checkout', 'v1.0.0'])
    const detachedTag = await readCachedGit(wtDir, 'session-b', 1, cacheDir, t0 + 30_000)
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
        current_usage: { input_tokens: 2669, cache_read_input_tokens: 8113, cache_creation_input_tokens: 0, output_tokens: 1 },
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
    assert.match(wslLine, /^  ~\/proj\/demo \| carbon:high \| 5h:4%\(4h3\dm\) 7d:39%\(5d6h\) \| ctx:20% \| token:12\.4k\(75\.2%\) \| session:24m \| T:1$/)

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
    const configPath = join(root, 'explicit.jsonc')
    await writeFile(configPath, '{ /* explicit file */ "callCounts": false, "session": false, "model": true }')
    const install = await fixtureCheckout(root)
    const bin = join(install, 'bin', 'vargus')
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

    await writeFile(join(install, 'vargus.jsonc'), '// checkout default\n{"model":false}')
    const fromCheckout = await runStatusline([], JSON.stringify(payload), { NO_COLOR: '1' })
    assert.equal(fromCheckout.code, 0, fromCheckout.stderr)
    assert.match(fromCheckout.stdout, /ctx:20%/)
    assert.doesNotMatch(fromCheckout.stdout, /carbon/)
    const colored = await runStatusline(['--theme', 'aurora', '--config', configPath], JSON.stringify(payload), { NO_COLOR: '' })
    assert.equal(colored.code, 0, colored.stderr)
    assert.match(colored.stdout, /carbon/)
    assert.ok(colored.stdout.includes('\x1b[38;2;'), 'expected 24-bit ANSI SGR output')
    assert.ok(!colored.stdout.includes('session:'), 'config should disable session fragment')
    assert.ok(!colored.stdout.includes('🔧'), 'config should disable callCounts fragment')

    const noColor = await runStatusline(['--config', configPath], JSON.stringify(payload), { NO_COLOR: '1' })
    assert.equal(noColor.code, 0, noColor.stderr)
    assert.ok(!noColor.stdout.includes('\x1b['), 'NO_COLOR must strip all ANSI codes')
    assert.match(noColor.stdout.replace(/\r?\n$/, ''), /^  ~\/proj\/demo \| carbon:high \| 5h:4%\(4h3\dm\) 7d:39%\(5d6h\) \| ctx:20% \| token:12\.4k\(75\.2%\)$/)

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

test('Antigravity payloadFingerprint ignores quota reset_in_seconds countdowns and baseModelKey strips only effort', () => {
  const base: AntigravityPayload = {
    agent_state: 'working',
    model: { id: 'Gemini 4 Neon (Medium)', display_name: 'Gemini 4 Neon (Medium)', effort: 'medium' },
    quota: {
      'gemini-5h': { remaining_fraction: 0.78, reset_time: '2026-11-22T05:19:09Z', reset_in_seconds: 7378 },
      'gemini-weekly': { remaining_fraction: 0.94, reset_time: '2026-11-29T00:19:09Z', reset_in_seconds: 594178 },
    },
    terminal_width: 120,
  }
  const ticked: AntigravityPayload = {
    ...base,
    quota: {
      'gemini-5h': { remaining_fraction: 0.78, reset_time: '2026-11-22T05:19:09Z', reset_in_seconds: 7370 },
      'gemini-weekly': { remaining_fraction: 0.94, reset_time: '2026-11-29T00:19:09Z', reset_in_seconds: 594170 },
    },
  }
  assert.equal(payloadFingerprint(base), payloadFingerprint(ticked))

  const quotaMoved: AntigravityPayload = {
    ...base,
    quota: {
      ...base.quota,
      'gemini-5h': { remaining_fraction: 0.77, reset_time: '2026-11-22T05:19:09Z', reset_in_seconds: 7370 },
    },
  }
  assert.notEqual(payloadFingerprint(base), payloadFingerprint(quotaMoved))
  assert.notEqual(payloadFingerprint(base), payloadFingerprint({ ...base, terminal_width: 140 }))

  assert.equal(baseModelKey({ id: 'Gemini 4 Neon (Medium)', display_name: 'Gemini 4 Neon (Medium)' }), 'gemini-4-neon')
  assert.equal(baseModelKey({ id: 'gemini-4-neon-xhigh', display_name: 'Gemini 4 Neon (XHigh)' }), 'gemini-4-neon')
  assert.equal(baseModelKey('gemini-4-neon-low'), 'gemini-4-neon')
  assert.equal(baseModelKey({ display_name: 'Claude Opus 5.5 (High)' }), 'claude-opus-5-5')
  assert.equal(baseModelKey('claude-opus-5-5-high'), 'claude-opus-5-5')
  assert.equal(baseModelKey('qwen-vl-max'), 'qwen-vl-max')
  assert.equal(baseModelKey('alibaba/qwen-3-max'), 'alibaba/qwen-3-max')
  assert.equal(baseModelKey({ display_name: 'Orchestrator (Carbon)' }), 'orchestrator-(carbon)')
  assert.notEqual(baseModelKey({ display_name: 'Orchestrator (Carbon)' }), baseModelKey({ display_name: 'Orchestrator (Argon)' }))
  assert.equal(baseModelKey(undefined), undefined)
})

test('Antigravity stream-start heuristic matches probed multi-step and slow-tool decode rates and preserves bursts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vargus-agy-rate-'))
  try {
    const cacheDir = join(root, 'cache')
    const home = join(root, 'home')
    const workspace = join(home, 'proj', 'demo')
    await mkdir(workspace, { recursive: true })
    const id = '984a33cd-3fb1-43f8-9ae5-40a3727efdcd'
    const transcript = join(home, '.gemini', 'antigravity-cli', 'brain', id, '.system_generated', 'logs', 'transcript.jsonl')
    await mkdir(join(transcript, '..'), { recursive: true })

    const baseTime = Date.parse('2026-11-22T03:17:40.000Z')
    const setTranscript = async (lines: Record<string, unknown>[], mtimeMs: number) => {
      await writeFile(transcript, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
      const at = new Date(mtimeMs)
      await utimes(transcript, at, at)
    }
    const makePayload = (overrides: Partial<AntigravityPayload> & { resetIn?: number } = {}): AntigravityPayload => {
      const { resetIn = 7300, ...rest } = overrides
      return {
        cwd: workspace,
        session_id: id,
        conversation_id: id,
        transcript_path: transcript,
        agent_state: 'working',
        model: { id: 'Gemini 4 Neon (Medium)', display_name: 'Gemini 4 Neon (Medium)', effort: 'medium' },
        workspace: { current_dir: workspace, project_dir: workspace },
        context_window: {
          total_input_tokens: 21637,
          total_output_tokens: 0,
          context_window_size: 1048576,
          used_percentage: 2,
          current_usage: null,
        },
        quota: {
          'gemini-5h': { remaining_fraction: 0.78, reset_time: '2026-11-22T05:19:09Z', reset_in_seconds: resetIn },
        },
        terminal_width: 200,
        ...rest,
      }
    }
    const runtimeFor = (now: number, extra: Record<string, unknown> = {}) => ({
      home,
      noColor: true,
      cacheDir,
      now,
      givenOptions: { repo: false, branch: false, status: false, session: false, callCounts: false, rateLimits: false, ...extra },
    })

    // Probe 1 replay: Step 1 (fast read_file burst, 0 mid-step stream ticks) -> Step 2 (1917 tok over 15.56s -> 123t/s) -> Step 3 ("pong" 15ms burst preserves 123t/s).
    const step0 = { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-22T03:17:43Z' }
    await setTranscript([step0], baseTime + 3569)
    await renderAntigravityStatusLine(makePayload({ resetIn: 7378 }), runtimeFor(baseTime + 3809))

    // Startup quota refresh during pre-TTFT updates lastTransitionAt without latching.
    await renderAntigravityStatusLine(makePayload({
      quota: { 'gemini-5h': { remaining_fraction: 0.77, reset_time: '2026-11-22T05:19:09Z', reset_in_seconds: 7377 } },
    }), runtimeFor(baseTime + 4411))

    // Step 1 (read_file) completes in one chunk alongside GENERIC tool output: no rate yet.
    const step1 = {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-22T03:17:43Z',
      model: 'gemini-4-neon-medium',
      input_tokens: 15468,
      cache_read_tokens: 0,
      output_tokens: 116,
      tool_calls: [{ name: 'read_file', args: { Path: '"probe.txt"' } }],
    }
    const step2 = { step_index: 2, type: 'GENERIC', created_at: '2026-11-22T03:17:49Z' }
    await setTranscript([step0, step1, step2], baseTime + 9365)
    const afterStep1 = await renderAntigravityStatusLine(makePayload({ resetIn: 7372 }), runtimeFor(baseTime + 9380))
    assert.match(afterStep1, /token:15\.6k$/)
    assert.doesNotMatch(afterStep1, /t\/s/)

    // Context window updates 300ms later (fpChanged=true), then one trailing 300ms no-op tick (dt=301ms <= 450ms -> skipped).
    const cwAfterStep1 = {
      total_input_tokens: 21637,
      total_output_tokens: 116,
      context_window_size: 1048576,
      used_percentage: 2,
      current_usage: { input_tokens: 15468, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 116 },
    }
    await renderAntigravityStatusLine(makePayload({ context_window: cwAfterStep1, resetIn: 7372 }), runtimeFor(baseTime + 9677))
    await renderAntigravityStatusLine(makePayload({ context_window: cwAfterStep1, resetIn: 7371 }), runtimeFor(baseTime + 9978))

    // First SSE chunk arrives after 4.38s pre-TTFT silence -> latches streamStartMs at baseTime + 14356.
    await renderAntigravityStatusLine(makePayload({ context_window: cwAfterStep1, resetIn: 7367 }), runtimeFor(baseTime + 14356))
    // Mid-stream terminal resize does not reset an already-latched streamStartMs.
    await renderAntigravityStatusLine(makePayload({ context_window: cwAfterStep1, resetIn: 7360, terminal_width: 180 }), runtimeFor(baseTime + 21000))

    // Step 2 completes at mtimeMs = baseTime + 29913 (15,557 ms decode, 1917 tokens -> 123t/s).
    const step3 = {
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-22T03:17:49Z',
      model: 'gemini-4-neon-medium',
      input_tokens: 2281,
      cache_read_tokens: 13411,
      output_tokens: 1917,
    }
    await setTranscript([step0, step1, step2, step3], baseTime + 29913)
    const cwAfterStep2 = {
      total_input_tokens: 21811,
      total_output_tokens: 2033,
      context_window_size: 1048576,
      used_percentage: 2,
      current_usage: { input_tokens: 2281, cache_read_input_tokens: 13411, cache_creation_input_tokens: 0, output_tokens: 1917 },
    }
    const afterStep2 = await renderAntigravityStatusLine(
      makePayload({ agent_state: 'idle', context_window: cwAfterStep2, resetIn: 7351 }),
      runtimeFor(baseTime + 30012),
    )
    assert.match(afterStep2, /token:19\.8k\(85\.5%, 123t\/s\)$/)

    // Step 3 ("pong"): 8.63s pre-TTFT silence, first chunk at +39986, flush at +40001 (15ms < 500ms -> preserves 123t/s).
    const step4 = { step_index: 4, type: 'USER_INPUT', created_at: '2026-11-22T03:18:11Z' }
    await setTranscript([step0, step1, step2, step3, step4], baseTime + 31209)
    await renderAntigravityStatusLine(
      makePayload({ agent_state: 'working', context_window: cwAfterStep2, resetIn: 7350 }),
      runtimeFor(baseTime + 31355),
    )
    await renderAntigravityStatusLine(
      makePayload({ agent_state: 'working', context_window: cwAfterStep2, resetIn: 7341 }),
      runtimeFor(baseTime + 39986),
    )
    const step5 = {
      step_index: 5,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-22T03:18:11Z',
      model: 'gemini-4-neon-medium',
      input_tokens: 4045,
      cache_read_tokens: 13643,
      output_tokens: 13,
    }
    await setTranscript([step0, step1, step2, step3, step4, step5], baseTime + 40001)
    const cwAfterStep3 = {
      total_input_tokens: 23789,
      total_output_tokens: 2046,
      context_window_size: 1048576,
      used_percentage: 2,
      current_usage: { input_tokens: 4045, cache_read_input_tokens: 13643, cache_creation_input_tokens: 0, output_tokens: 13 },
    }
    const afterBurst = await renderAntigravityStatusLine(
      makePayload({ agent_state: 'idle', context_window: cwAfterStep3, resetIn: 7341 }),
      runtimeFor(baseTime + 40286),
    )
    assert.match(afterBurst, /token:23\.8k\(77\.1%, 123t\/s\)$/)

    // Slow tool in flight (pendingTools > 0): no-op ticks during tool execution must NOT latch streamStartMs.
    const step6 = { step_index: 6, type: 'USER_INPUT', created_at: '2026-11-22T03:18:20Z' }
    const step7 = {
      step_index: 7,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-22T03:18:20Z',
      input_tokens: 1000,
      output_tokens: 142,
      tool_calls: [{ name: 'run_command', args: { CommandLine: '"sleep 3"' } }],
    }
    await setTranscript([step0, step1, step2, step3, step4, step5, step6, step7], baseTime + 47268)
    await renderAntigravityStatusLine(
      makePayload({ agent_state: 'working', context_window: cwAfterStep3, resetIn: 7334 }),
      runtimeFor(baseTime + 47293),
    )
    // Tool safety monitor & command ticks while tool is still running: ignored because awaitingModel === false.
    await renderAntigravityStatusLine(
      makePayload({ agent_state: 'working', context_window: cwAfterStep3, resetIn: 7332 }),
      runtimeFor(baseTime + 49126),
    )
    const step8 = { step_index: 8, type: 'GENERIC', created_at: '2026-11-22T03:18:27Z' }
    await setTranscript([step0, step1, step2, step3, step4, step5, step6, step7, step8], baseTime + 52420)
    await renderAntigravityStatusLine(
      makePayload({ agent_state: 'working', context_window: cwAfterStep3, resetIn: 7329 }),
      runtimeFor(baseTime + 52443),
    )
    // Trailing 297ms flush after GENERIC skipped; first SSE chunk at +56229 latches; flush at +59700 -> 407 tok / 3.471s -> 117t/s.
    await renderAntigravityStatusLine(
      makePayload({ agent_state: 'working', context_window: cwAfterStep3, resetIn: 7328 }),
      runtimeFor(baseTime + 52740),
    )
    await renderAntigravityStatusLine(
      makePayload({ agent_state: 'working', context_window: cwAfterStep3, resetIn: 7325 }),
      runtimeFor(baseTime + 56229),
    )
    const step9 = {
      step_index: 9,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-22T03:18:32Z',
      input_tokens: 1200,
      output_tokens: 407,
    }
    await setTranscript([step0, step1, step2, step3, step4, step5, step6, step7, step8, step9], baseTime + 59700)
    const afterSlowTool = await renderAntigravityStatusLine(
      makePayload({ agent_state: 'idle', context_window: cwAfterStep3, resetIn: 7321 }),
      runtimeFor(baseTime + 59835),
    )
    assert.match(afterSlowTool, /\(77\.1%, 117t\/s\)$/)

    // Effort change on the same model keeps the rate; model switch clears it.
    const sameModelEffort = await renderAntigravityStatusLine(
      makePayload({
        agent_state: 'idle',
        model: { id: 'Gemini 4 Neon (XHigh)', display_name: 'Gemini 4 Neon (XHigh)', effort: 'xhigh' },
        context_window: cwAfterStep3,
      }),
      runtimeFor(baseTime + 61000),
    )
    assert.match(sameModelEffort, /117t\/s\)$/)

    const switchedModel = await renderAntigravityStatusLine(
      makePayload({
        agent_state: 'idle',
        model: { id: 'Claude Opus 5.5 (High)', display_name: 'Claude Opus 5.5 (High)', effort: 'high' },
        context_window: cwAfterStep3,
      }),
      runtimeFor(baseTime + 62000),
    )
    assert.doesNotMatch(switchedModel, /t\/s/)
    assert.match(switchedModel, /\(77\.1%\)$/)

    // Cold-start / resumed conversation (separate cacheDir) omits t/s until a live reply streams.
    const coldCacheDir = join(root, 'cold-cache')
    const resumed = await renderAntigravityStatusLine(
      makePayload({ agent_state: 'idle', context_window: cwAfterStep3 }),
      { ...runtimeFor(baseTime + 63000), cacheDir: coldCacheDir },
    )
    assert.doesNotMatch(resumed, /t\/s/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Antigravity rate clears on compaction, rewind and zero output, fails closed on intervening/trailing steps, and recovers from clock/cache faults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vargus-agy-rate-edge-'))
  try {
    const cacheDir = join(root, 'cache')
    const trPath = join(root, 'transcript.jsonl')
    const payload: AntigravityPayload = {
      agent_state: 'working',
      model: { id: 'Gemini 4 Neon (High)', display_name: 'Gemini 4 Neon (High)', effort: 'high' },
    }
    const baseState = (overrides: Partial<TranscriptState> = {}): TranscriptState => ({
      startedAt: 1000,
      counts: { tokens: 1000, tools: 0, agents: 0, skills: 0 },
      mutatingToolsSeen: 0,
      epoch: 'epoch-1',
      firstLineHash: 'hash-1',
      committedBytes: 100,
      mtimeMs: 1000,
      stepCount: 1,
      plannerStepsSeen: 0,
      compactionsSeen: 0,
      awaitingModel: true,
      unboundedTrailingStep: false,
      ...overrides,
    })

    // Fast-TTFT back-to-back 300ms ticks: first (+300ms) skipped without moving lastTransitionAt; second (+600ms) latches.
    let fastTtft = advanceAntigravityRate(undefined, { transcriptPath: trPath, transcript: baseState(), payload, now: 1000 })
    fastTtft = advanceAntigravityRate(fastTtft, { transcriptPath: trPath, transcript: baseState(), payload, now: 1300 })
    assert.equal(fastTtft.streamStartMs, undefined)
    assert.equal(fastTtft.lastTransitionAt, 1000)
    fastTtft = advanceAntigravityRate(fastTtft, { transcriptPath: trPath, transcript: baseState(), payload, now: 1600 })
    assert.equal(fastTtft.streamStartMs, 1600)

    // Seed a measured 100 t/s reading (500 tokens / 5000 ms).
    let state = advanceAntigravityRate(undefined, { transcriptPath: trPath, transcript: baseState(), payload, now: 1000 })
    state = advanceAntigravityRate(state, { transcriptPath: trPath, transcript: baseState(), payload, now: 2000 })
    assert.equal(state.streamStartMs, 2000)
    state = advanceAntigravityRate(state, {
      transcriptPath: trPath,
      transcript: baseState({
        committedBytes: 300,
        mtimeMs: 7000,
        stepCount: 2,
        plannerStepsSeen: 1,
        awaitingModel: false,
        lastPlanner: { stepCount: 2, outputTokens: 500 },
      }),
      payload: { ...payload, agent_state: 'idle' },
      now: 7100,
    })
    assert.equal(state.tokensPerSecond, 100)

    // Aborted turn (working -> idle or working -> error with no PLANNER_RESPONSE) discards streamStartMs and keeps 100 t/s.
    for (const endState of ['idle', 'error'] as const) {
      let aborted = advanceAntigravityRate(state, {
        transcriptPath: trPath,
        transcript: baseState({ committedBytes: 400, stepCount: 3, plannerStepsSeen: 1, awaitingModel: true }),
        payload,
        now: 8000,
      })
      aborted = advanceAntigravityRate(aborted, {
        transcriptPath: trPath,
        transcript: baseState({ committedBytes: 400, stepCount: 3, plannerStepsSeen: 1, awaitingModel: true }),
        payload,
        now: 9000,
      })
      assert.equal(aborted.streamStartMs, 9000)
      aborted = advanceAntigravityRate(aborted, {
        transcriptPath: trPath,
        transcript: baseState({ committedBytes: 400, stepCount: 3, plannerStepsSeen: 1, awaitingModel: true }),
        payload: { ...payload, agent_state: endState },
        now: 10000,
      })
      assert.equal(aborted.streamStartMs, undefined)
      assert.equal(aborted.tokensPerSecond, 100)
    }

    // A new transcript step arriving while awaitingModel clears any latched streamStartMs.
    let trReset = advanceAntigravityRate(state, {
      transcriptPath: trPath,
      transcript: baseState({ committedBytes: 400, stepCount: 3, plannerStepsSeen: 1, awaitingModel: true }),
      payload,
      now: 8000,
    })
    trReset = advanceAntigravityRate(trReset, {
      transcriptPath: trPath,
      transcript: baseState({ committedBytes: 400, stepCount: 3, plannerStepsSeen: 1, awaitingModel: true }),
      payload,
      now: 9000,
    })
    assert.equal(trReset.streamStartMs, 9000)
    trReset = advanceAntigravityRate(trReset, {
      transcriptPath: trPath,
      transcript: baseState({ committedBytes: 480, stepCount: 4, plannerStepsSeen: 1, awaitingModel: true }),
      payload,
      now: 9500,
    })
    assert.equal(trReset.streamStartMs, undefined)

    // Missed intermediate refresh + slow tool in same read (mtimeMs - created_at > 2000 ms) preserves prior rate.
    let slowCombined = advanceAntigravityRate(state, {
      transcriptPath: trPath,
      transcript: baseState({ committedBytes: 400, stepCount: 3, plannerStepsSeen: 1, awaitingModel: true }),
      payload,
      now: 8000,
    })
    slowCombined = advanceAntigravityRate(slowCombined, {
      transcriptPath: trPath,
      transcript: baseState({ committedBytes: 400, stepCount: 3, plannerStepsSeen: 1, awaitingModel: true }),
      payload,
      now: 9000,
    })
    slowCombined = advanceAntigravityRate(slowCombined, {
      transcriptPath: trPath,
      transcript: baseState({
        committedBytes: 700,
        mtimeMs: 16000,
        stepCount: 5,
        plannerStepsSeen: 2,
        awaitingModel: true,
        lastPlanner: { stepCount: 4, outputTokens: 200 },
        firstToolAfterPlannerCreatedAt: 11000,
      }),
      payload,
      now: 16050,
    })
    assert.equal(slowCombined.tokensPerSecond, 100)

    // Compaction clears the rate.
    const compacted = advanceAntigravityRate(state, {
      transcriptPath: trPath,
      transcript: baseState({ committedBytes: 400, stepCount: 3, plannerStepsSeen: 1, compactionsSeen: 1, awaitingModel: true }),
      payload,
      now: 8000,
    })
    assert.equal(compacted.tokensPerSecond, undefined)

    // Mid-transcript `/rewind` (epoch rotation even with larger bytes) clears the rate.
    const rewound = advanceAntigravityRate(state, {
      transcriptPath: trPath,
      transcript: baseState({ epoch: 'epoch-2', committedBytes: 900, stepCount: 5, plannerStepsSeen: 2, awaitingModel: false }),
      payload: { ...payload, agent_state: 'idle' },
      now: 8000,
    })
    assert.equal(rewound.tokensPerSecond, undefined)

    // Usage-less / zero-output completed step (single and multi-step jump) clears the rate.
    const zeroOut = advanceAntigravityRate(state, {
      transcriptPath: trPath,
      transcript: baseState({
        committedBytes: 400,
        mtimeMs: 9000,
        stepCount: 3,
        plannerStepsSeen: 2,
        awaitingModel: false,
        lastPlanner: { stepCount: 3, outputTokens: 0 },
      }),
      payload: { ...payload, agent_state: 'idle' },
      now: 9050,
    })
    assert.equal(zeroOut.tokensPerSecond, undefined)

    const multiZeroOut = advanceAntigravityRate(state, {
      transcriptPath: trPath,
      transcript: baseState({
        committedBytes: 600,
        mtimeMs: 9500,
        stepCount: 5,
        plannerStepsSeen: 3,
        awaitingModel: false,
        lastPlanner: { stepCount: 5, outputTokens: 0 },
      }),
      payload: { ...payload, agent_state: 'idle' },
      now: 9600,
    })
    assert.equal(multiZeroOut.tokensPerSecond, undefined)

    // Far-future mtimeMs (> now + 1000) falls back to observedAt instead of trusting skewed filesystem time.
    let futureMtime = advanceAntigravityRate(undefined, { transcriptPath: trPath, transcript: baseState(), payload, now: 1000 })
    futureMtime = advanceAntigravityRate(futureMtime, { transcriptPath: trPath, transcript: baseState(), payload, now: 2000 })
    futureMtime = advanceAntigravityRate(futureMtime, {
      transcriptPath: trPath,
      transcript: baseState({
        committedBytes: 300,
        mtimeMs: 99_999_999,
        stepCount: 2,
        plannerStepsSeen: 1,
        awaitingModel: false,
        lastPlanner: { stepCount: 2, outputTokens: 200 },
      }),
      payload: { ...payload, agent_state: 'idle' },
      now: 4200,
      observedAt: 4000,
    })
    assert.equal(futureMtime.tokensPerSecond, 100)

    // Backward wall-clock jump does not freeze stream-start latching.
    let jumped = advanceAntigravityRate(state, {
      transcriptPath: trPath,
      transcript: baseState({ committedBytes: 400, stepCount: 3, plannerStepsSeen: 1, awaitingModel: true }),
      payload,
      now: 10000,
    })
    jumped = advanceAntigravityRate(jumped, {
      transcriptPath: trPath,
      transcript: baseState({ committedBytes: 400, stepCount: 3, plannerStepsSeen: 1, awaitingModel: true }),
      payload,
      now: 5000,
    })
    assert.equal(jumped.lastTransitionAt, 5000)
    assert.equal(jumped.streamStartMs, undefined)
    jumped = advanceAntigravityRate(jumped, {
      transcriptPath: trPath,
      transcript: baseState({ committedBytes: 400, stepCount: 3, plannerStepsSeen: 1, awaitingModel: true }),
      payload,
      now: 6000,
    })
    assert.equal(jumped.streamStartMs, 6000)

    // observedAt compensates for Node startup latency when measuring against transcript mtimeMs.
    let compensated = advanceAntigravityRate(undefined, {
      transcriptPath: trPath,
      transcript: baseState(),
      payload,
      now: 1170,
      observedAt: 1000,
    })
    compensated = advanceAntigravityRate(compensated, {
      transcriptPath: trPath,
      transcript: baseState(),
      payload,
      now: 2170,
      observedAt: 2000,
    })
    assert.equal(compensated.streamStartMs, 2000)
    compensated = advanceAntigravityRate(compensated, {
      transcriptPath: trPath,
      transcript: baseState({
        committedBytes: 300,
        mtimeMs: 3000,
        stepCount: 2,
        plannerStepsSeen: 1,
        awaitingModel: false,
        lastPlanner: { stepCount: 2, outputTokens: 100 },
      }),
      payload: { ...payload, agent_state: 'idle' },
      now: 3170,
      observedAt: 3000,
    })
    assert.equal(compensated.tokensPerSecond, 100)

    // Corrupted rate cache files (bad types or negative/non-positive counters/rates) recover cleanly without throwing.
    const rateFile = cachePath(cacheDir, 'rate', trPath)
    await mkdir(cacheDir, { recursive: true })
    await writeFile(rateFile, JSON.stringify({ version: 1, lastTransitionAt: 'corrupt' }))
    assert.equal(await updateAntigravityRate(trPath, baseState(), payload, cacheDir, 1000), undefined)
    const matchingState = baseState({
      committedBytes: 300,
      mtimeMs: 7000,
      stepCount: 2,
      plannerStepsSeen: 1,
      awaitingModel: false,
      lastPlanner: { stepCount: 2, outputTokens: 500 },
    })
    await writeFile(rateFile, JSON.stringify({ ...state, tokensPerSecond: -50 }))
    assert.equal(await updateAntigravityRate(trPath, matchingState, { ...payload, agent_state: 'idle' }, cacheDir, 7200), undefined)
    await writeFile(rateFile, JSON.stringify({ ...state, streamStartMs: 0 }))
    assert.equal(await updateAntigravityRate(trPath, matchingState, { ...payload, agent_state: 'idle' }, cacheDir, 7200), undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Antigravity end-to-end transcript wiring fails closed on intervening/trailing steps, survives tokens toggle across rewind, and handles compaction, SYSTEM_MESSAGE and observedAt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vargus-agy-rate-e2e-'))
  try {
    const home = join(root, 'home')
    const workspace = join(home, 'proj', 'demo')
    await mkdir(workspace, { recursive: true })
    const baseTime = Date.parse('2026-11-22T04:00:00.000Z')

    const makeHarness = async (id: string) => {
      const cacheDir = join(root, `cache-${id}`)
      const tr = join(home, '.gemini', 'antigravity-cli', 'brain', id, '.system_generated', 'logs', 'transcript.jsonl')
      await mkdir(join(tr, '..'), { recursive: true })
      const writeLines = async (lines: unknown[], mtimeMs: number) => {
        await writeFile(tr, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
        const at = new Date(mtimeMs)
        await utimes(tr, at, at)
      }
      const payload = (state = 'working'): AntigravityPayload => ({
        cwd: workspace,
        session_id: id,
        conversation_id: id,
        transcript_path: tr,
        agent_state: state,
        model: { id: 'Gemini 4 Neon (High)', display_name: 'Gemini 4 Neon (High)', effort: 'high' },
        workspace: { current_dir: workspace, project_dir: workspace },
        context_window: { total_input_tokens: 1000, total_output_tokens: 100, context_window_size: 1048576, used_percentage: 1 },
        terminal_width: 200,
      })
      const run = (now: number, opts: Record<string, unknown> = {}, state = 'working', observedAt?: number) =>
        renderAntigravityStatusLine(payload(state), {
          home,
          noColor: true,
          cacheDir,
          now,
          observedAt,
          givenOptions: { repo: false, branch: false, status: false, callCounts: false, rateLimits: false, ...opts },
        })
      return { tr, cacheDir, writeLines, run }
    }

    // 1. Real observedAt forwarding, mid-append non-object JSONL guard, SYSTEM_MESSAGE wakeup, CHECKPOINT compaction, and durable /rewind across tokens:false toggle.
    const h1 = await makeHarness('conv-e2e-1')
    const u0 = { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-22T04:00:00Z' }
    await h1.writeLines([u0], baseTime + 100)
    await h1.run(baseTime + 270, {}, 'working', baseTime + 100)
    await h1.run(baseTime + 1170, {}, 'working', baseTime + 1000)
    const p1 = { step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-11-22T04:00:00Z', input_tokens: 500, output_tokens: 100 }
    // Appending non-object JSONL lines right before p1 must not shift stepCount or break contiguity.
    await h1.writeLines([u0, null, 42, p1], baseTime + 2000)
    // observedAt=1000 to mtimeMs=2000 -> 1000ms -> 100t/s (without observedAt forwarding it would be 100/830ms = 120t/s).
    const r1 = await h1.run(baseTime + 2170, {}, 'idle', baseTime + 2000)
    assert.match(r1, /token:600\(100t\/s\)/)

    // SYSTEM_MESSAGE waking an idle conversation sets awaitingModel so the next streamed reply is timed.
    const sysMsg = { step_index: 2, type: 'SYSTEM_MESSAGE', created_at: '2026-11-22T04:00:05Z' }
    await h1.writeLines([u0, null, 42, p1, sysMsg], baseTime + 5000)
    await h1.run(baseTime + 5050, {}, 'working')
    await h1.run(baseTime + 6000, {}, 'working')
    const p2 = { step_index: 3, type: 'PLANNER_RESPONSE', created_at: '2026-11-22T04:00:05Z', input_tokens: 500, output_tokens: 400 }
    await h1.writeLines([u0, null, 42, p1, sysMsg, p2], baseTime + 8000)
    const rSys = await h1.run(baseTime + 8050, {}, 'idle')
    assert.match(rSys, /\(200t\/s\)/)

    // Durable `/rewind` across an intervening `tokens: false` refresh (same line 1, larger bytes, higher counts).
    const rewoundLine = {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-22T04:00:09Z',
      input_tokens: 600,
      output_tokens: 100,
      padding: 'x'.repeat(512),
    }
    await h1.writeLines([u0, rewoundLine, sysMsg, p2], baseTime + 9000)
    const hiddenTokens = await h1.run(baseTime + 9050, { tokens: false, session: true }, 'idle')
    assert.doesNotMatch(hiddenTokens, /token:/)
    const afterRewind = await h1.run(baseTime + 9500, { tokens: true, session: true }, 'idle')
    assert.doesNotMatch(afterRewind, /t\/s/)

    // Re-seed a rate, then verify real CHECKPOINT in transcript.jsonl clears it.
    const u2 = { step_index: 4, type: 'USER_INPUT', created_at: '2026-11-22T04:00:10Z' }
    await h1.writeLines([u0, rewoundLine, sysMsg, p2, u2], baseTime + 10000)
    await h1.run(baseTime + 10050, {}, 'working')
    await h1.run(baseTime + 11000, {}, 'working')
    const p3 = { step_index: 5, type: 'PLANNER_RESPONSE', created_at: '2026-11-22T04:00:10Z', input_tokens: 300, output_tokens: 300 }
    await h1.writeLines([u0, rewoundLine, sysMsg, p2, u2, p3], baseTime + 13000)
    assert.match(await h1.run(baseTime + 13050, {}, 'idle'), /\(150t\/s\)/)
    const cp = { step_index: 6, type: 'CHECKPOINT', created_at: '2026-11-22T04:00:14Z', input_tokens: 200, output_tokens: 100 }
    await h1.writeLines([u0, rewoundLine, sysMsg, p2, u2, p3, cp], baseTime + 14000)
    assert.doesNotMatch(await h1.run(baseTime + 14050, {}, 'idle'), /t\/s/)

    // 2a. Positive witness: PLANNER_RESPONSE + fast dated GENERIC in one read (<= 2s) computes rate, and whitespace tool names are ignored.
    const hFastTool = await makeHarness('conv-fast-tool')
    await hFastTool.writeLines([u0], baseTime + 100)
    await hFastTool.run(baseTime + 150, {}, 'working')
    await hFastTool.run(baseTime + 1000, {}, 'working')
    await hFastTool.writeLines([
      u0,
      { step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-11-22T04:00:00Z', input_tokens: 200, output_tokens: 400, tool_calls: [{ name: 'read_file' }, { name: '   ' }] },
      { step_index: 2, type: 'GENERIC', created_at: '2026-11-22T04:00:03Z' },
    ], baseTime + 3050)
    const fastToolOut = await hFastTool.run(baseTime + 3100, {}, 'working')
    assert.match(fastToolOut, /\(195t\/s\)/)
    const fastToolState = await readTranscriptState(hFastTool.tr, hFastTool.cacheDir)
    assert.equal(fastToolState.counts.tools, 1)
    assert.equal(fastToolState.awaitingModel, true)

    // 2b. Trailing-step fail-closed checks: slow GENERIC, slow GENERIC + USER_INPUT, 0-tool PLANNER + USER_INPUT,
    // dateless GENERIC, fast GENERIC + SYSTEM_MESSAGE, and 2-tool batch where the second GENERIC omits created_at.
    for (const [name, trailing, mtimeDelta] of [
      ['slow-generic', [
        { step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-11-22T04:00:00Z', input_tokens: 200, output_tokens: 200, tool_calls: [{ name: 'run_command' }] },
        { step_index: 2, type: 'GENERIC', created_at: '2026-11-22T04:00:02Z' },
      ], 7000],
      ['slow-generic-plus-user', [
        { step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-11-22T04:00:00Z', input_tokens: 200, output_tokens: 200, tool_calls: [{ name: 'run_command' }] },
        { step_index: 2, type: 'GENERIC', created_at: '2026-11-22T04:00:02Z' },
        { step_index: 3, type: 'USER_INPUT', created_at: '2026-11-22T04:00:07Z' },
      ], 7000],
      ['zero-tool-plus-user', [
        { step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-11-22T04:00:00Z', input_tokens: 200, output_tokens: 500 },
        { step_index: 2, type: 'USER_INPUT', created_at: '2026-11-22T04:00:20Z' },
      ], 20000],
      ['dateless-generic', [
        { step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-11-22T04:00:00Z', input_tokens: 200, output_tokens: 200, tool_calls: [{ name: 'run_command' }] },
        { step_index: 2, type: 'GENERIC' },
      ], 8000],
      ['fast-generic-plus-system', [
        { step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-11-22T04:00:00Z', input_tokens: 200, output_tokens: 400, tool_calls: [{ name: 'read_file' }] },
        { step_index: 2, type: 'GENERIC', created_at: '2026-11-22T04:00:02Z' },
        { step_index: 3, type: 'SYSTEM_MESSAGE', created_at: '2026-11-22T04:00:03Z' },
      ], 3050],
      ['two-tools-second-dateless', [
        { step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-11-22T04:00:00Z', input_tokens: 200, output_tokens: 400, tool_calls: [{ name: 'read_file' }, { name: 'run_command' }] },
        { step_index: 2, type: 'GENERIC', created_at: '2026-11-22T04:00:02Z' },
        { step_index: 3, type: 'GENERIC' },
      ], 3050],
    ] as const) {
      const h = await makeHarness(`conv-trail-${name}`)
      await h.writeLines([u0], baseTime + 100)
      await h.run(baseTime + 150, {}, 'working')
      await h.run(baseTime + 1000, {}, 'working')
      await h.writeLines([u0, ...trailing], baseTime + mtimeDelta)
      const out = await h.run(baseTime + mtimeDelta + 50, {}, 'working')
      assert.doesNotMatch(out, /t\/s/, `${name} must not emit a corrupted rate`)
    }

    // 3. Intervening USER_INPUT after an aborted turn must NOT pair Turn 1's latched streamStartMs with Turn 2's PLANNER_RESPONSE.
    const hAbort = await makeHarness('conv-abort-gap')
    await hAbort.writeLines([u0], baseTime + 100)
    await hAbort.run(baseTime + 150, {}, 'working')
    await hAbort.run(baseTime + 1000, {}, 'working') // Turn 1 streamStartMs latches at +1000
    // Turn 1 aborted without idle tick; Turn 2 USER_INPUT + 100ms burst PLANNER_RESPONSE land together at +5000.
    const uTurn2 = { step_index: 1, type: 'USER_INPUT', created_at: '2026-11-22T04:00:04Z' }
    const pTurn2 = { step_index: 2, type: 'PLANNER_RESPONSE', created_at: '2026-11-22T04:00:04Z', input_tokens: 200, output_tokens: 25 }
    await hAbort.writeLines([u0, uTurn2, pTurn2], baseTime + 5000)
    const afterMissedAbort = await hAbort.run(baseTime + 5050, {}, 'idle')
    assert.doesNotMatch(afterMissedAbort, /t\/s/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
