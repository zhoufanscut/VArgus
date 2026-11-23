import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, appendFile, chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  OmoSubagents,
  parseOmoJsonc,
  projectStateKey,
  resolveOmoTaskStateDir,
} from '../../src/hosts/omo/subagents.ts'

async function makeTempRoot(t: TestContext, prefix = 'vargus-omo-subagents-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function assistantLine(
  opts: {
    id?: string
    input: number
    output: number
    cacheRead?: number
    cacheWrite?: number
    tools?: { id?: string; name?: string; runtimeItemKey?: string }[]
    text?: string
  },
): string {
  const content: unknown[] = []
  if (opts.text !== undefined) content.push({ type: 'text', text: opts.text })
  for (const tool of opts.tools ?? []) {
    content.push({
      type: 'toolCall',
      id: tool.id ?? 'call-1',
      name: tool.name ?? 'read',
      arguments: {},
      ...(tool.runtimeItemKey ? { runtimeItemKey: tool.runtimeItemKey } : {}),
    })
  }
  const entry: Record<string, unknown> = {
    type: 'message',
    timestamp: '2026-11-23T00:00:00Z',
    message: {
      role: 'assistant',
      content,
      usage: {
        input: opts.input,
        output: opts.output,
        cacheRead: opts.cacheRead ?? 500,
        cacheWrite: opts.cacheWrite ?? 100,
      },
    },
  }
  if (opts.id !== undefined) entry.id = opts.id
  return JSON.stringify(entry) + '\n'
}

function spawnResultLine(id: string, taskIds: string[]): string {
  return JSON.stringify({
    id,
    type: 'message',
    timestamp: '2026-11-23T00:00:01Z',
    message: {
      role: 'toolResult',
      toolCallId: 'spawn-1',
      toolName: 'task',
      details: { mode: 'spawn', items: taskIds.map(task_id => ({ task_id })) },
    },
  }) + '\n'
}

async function writeTask(
  stateDir: string,
  taskId: string,
  record: Record<string, unknown>,
  fileName = `${taskId}.json`,
): Promise<string> {
  const dir = join(stateDir, 'tasks')
  await mkdir(dir, { recursive: true })
  const file = join(dir, fileName)
  await writeFile(file, JSON.stringify({ task_id: taskId, ...record }))
  return file
}

async function writeChildJsonl(
  stateDir: string,
  taskId: string,
  fileName: string,
  content: string | Uint8Array,
): Promise<string> {
  const dir = join(stateDir, 'children', taskId, 'sessions', taskId)
  await mkdir(dir, { recursive: true })
  const file = join(dir, fileName)
  await writeFile(file, content)
  return file
}

test('parseOmoJsonc supports BOM, comments, trailing commas, and rejects invalid JSONC or non-objects', () => {
  const parsed = parseOmoJsonc(
    '\uFEFF// header\n{\n  /* block */\n  "url": "https://a.example/*keep*/,//ok,}",\n  "arr": [1, 2, /* c */],\n  "task": { "state_dir": "/tmp/x", },\n}\n',
  )
  assert.deepEqual(parsed, {
    url: 'https://a.example/*keep*/,//ok,}',
    arr: [1, 2],
    task: { state_dir: '/tmp/x' },
  })
  const sanitized = parseOmoJsonc('{"__proto__":{"polluted":true},"constructor":{},"prototype":{},"ok":1}')
  assert.deepEqual(sanitized, { ok: 1 })
  assert.equal(({} as Record<string, unknown>).polluted, undefined)

  for (const invalid of [
    '[]', 'null', '"str"', '42', '{,}', '{"a":1,,}', '{"a": [,] }',
    '{/* unterminated', '{"a": 1 /* comment */ 2}', '{broken',
  ]) {
    assert.equal(parseOmoJsonc(invalid), null, `expected null for ${invalid}`)
  }
})

test('projectStateKey matches OmO Unicode normalization, symlink resolution and missing-path fallback', async t => {
  const root = await makeTempRoot(t)
  const target = join(root, '项目-α β_1.0!')
  await mkdir(target)
  const key = projectStateKey(target)
  const expectedHash = createHash('sha256').update(await import('node:fs/promises').then(fs => fs.realpath(target))).digest('hex').slice(0, 12)
  assert.equal(key, `项目-α_β_1.0_-${expectedHash}`)

  if (process.platform !== 'win32') {
    const link = join(root, 'alias-link')
    await symlink(target, link)
    assert.equal(projectStateKey(link), key)
  }

  const missing = join(root, 'does-not-exist', 'my repo')
  const missingAbs = resolve(missing)
  const missingHash = createHash('sha256').update(missingAbs).digest('hex').slice(0, 12)
  assert.equal(projectStateKey(missing), `my_repo-${missingHash}`)
})

test('resolveOmoTaskStateDir honours agent-dir env priority and read-only legacy in-project store', async t => {
  const root = await makeTempRoot(t)
  const home = join(root, 'home')
  const project = join(root, 'work')
  await mkdir(home, { recursive: true })
  await mkdir(project, { recursive: true })

  const envBase = { HOME: home }
  const key = projectStateKey(project)

  assert.equal(
    await resolveOmoTaskStateDir(project, { env: envBase, accountHomeDir: home }),
    join(home, '.omo', 'agent', 'projects', key, 'senpi-task'),
  )
  assert.equal(
    await resolveOmoTaskStateDir(project, {
      env: { ...envBase, PI_CODING_AGENT_DIR: join(root, 'pi-dir') },
      accountHomeDir: home,
    }),
    join(root, 'pi-dir', 'projects', key, 'senpi-task'),
  )
  assert.equal(
    await resolveOmoTaskStateDir(project, {
      env: { ...envBase, SENPI_CODING_AGENT_DIR: join(root, 'senpi-dir'), PI_CODING_AGENT_DIR: join(root, 'pi-dir') },
      accountHomeDir: home,
    }),
    join(root, 'senpi-dir', 'projects', key, 'senpi-task'),
  )
  assert.equal(
    await resolveOmoTaskStateDir(project, {
      env: {
        ...envBase,
        OMO_CODING_AGENT_DIR: `  ${join(root, 'omo-dir')}  `,
        SENPI_CODING_AGENT_DIR: join(root, 'senpi-dir'),
      },
      accountHomeDir: home,
    }),
    join(root, 'omo-dir', 'projects', key, 'senpi-task'),
  )

  // Empty scaffolding inside <cwd>/.omo/senpi-task does NOT adopt legacy store.
  const legacyDir = join(project, '.omo', 'senpi-task')
  await mkdir(join(legacyDir, 'tasks'), { recursive: true })
  await mkdir(join(legacyDir, 'children'), { recursive: true })
  assert.equal(
    await resolveOmoTaskStateDir(project, { env: envBase, accountHomeDir: home }),
    join(home, '.omo', 'agent', 'projects', key, 'senpi-task'),
  )

  // Populated legacy store adopts read-only and NEVER writes `.in-project`.
  await writeTask(legacyDir, 'st_00000001', { parent_session_id: 's1', root_session_id: 's1', status: 'completed' })
  assert.equal(
    await resolveOmoTaskStateDir(project, { env: envBase, accountHomeDir: home }),
    legacyDir,
  )
  await assert.rejects(access(join(legacyDir, '.in-project')), /ENOENT/)

  // A `.in-project` marker alone also keeps the legacy store adopted after tasks are expunged.
  await rm(join(legacyDir, 'tasks'), { recursive: true, force: true })
  await writeFile(join(legacyDir, '.in-project'), '')
  assert.equal(
    await resolveOmoTaskStateDir(project, { env: envBase, accountHomeDir: home }),
    legacyDir,
  )
})

test('resolveOmoTaskStateDir merges omo.jsonc layers, overlays, profiles, symlinks and home boundary', async t => {
  const root = await makeTempRoot(t)
  const home = join(root, 'home')
  const parent = join(home, 'workspace')
  const project = join(parent, 'app')
  await mkdir(join(home, '.omo'), { recursive: true })
  await mkdir(join(parent, '.omo'), { recursive: true })
  await mkdir(join(project, '.omo'), { recursive: true })

  // User layer with trailing commas, comments, [native] and profiles.
  await writeFile(join(home, '.omo', 'omo.jsonc'), `{
    // user base
    "task": { "state_dir": "/user-base", },
    "[native]": { "task": { "state_dir": "/user-native", }, },
    "profiles": {
      "work": {
        "task": { "state_dir": "/profile-base", },
        "[senpi]": { "task": { "state_dir": "/profile-senpi", }, },
      },
      "alt": {
        "task": { "state_dir": "/alt-base", },
        "[senpi]": { "task": { "state_dir": "/alt-senpi", }, },
        "[native]": { "task": { "state_dir": "/alt-native", }, },
      },
    },
  }`)

  // Farthest project layer overrides user [native] via legacy [senpi] block (canonicalized per file).
  await writeFile(join(parent, '.omo', 'omo.json'), `{
    "[senpi]": { "task": { "state_dir": "/parent-senpi" } }
  }`)

  // Nearest project layer is malformed — fails closed without breaking earlier layers.
  await writeFile(join(project, '.omo', 'omo.jsonc'), '{ broken jsonc')

  assert.equal(
    await resolveOmoTaskStateDir(project, { env: { HOME: home }, accountHomeDir: home }),
    '/parent-senpi',
  )

  // Profile overlays via OMO_PROFILE, OCX_PROFILE, and OPENCODE_CONFIG_DIR.
  assert.equal(
    await resolveOmoTaskStateDir(project, { env: { HOME: home, OMO_PROFILE: 'work' }, accountHomeDir: home }),
    '/profile-senpi',
  )
  assert.equal(
    await resolveOmoTaskStateDir(project, { env: { HOME: home, OCX_PROFILE: 'alt' }, accountHomeDir: home }),
    '/alt-native',
  )
  assert.equal(
    await resolveOmoTaskStateDir(project, {
      env: { HOME: home, OPENCODE_CONFIG_DIR: '/etc/opencode/profiles/work/' },
      accountHomeDir: home,
    }),
    '/profile-senpi',
  )

  // Same-file [native] drops [senpi] on the same container (matches OmO canonicalizeLegacyHarnessBlocks).
  await writeFile(join(project, '.omo', 'omo.jsonc'), `{
    "task": { "state_dir": "/proj-base", },
    "[senpi]": { "task": { "state_dir": "/proj-dropped-senpi", }, },
    "[native]": { "model_profile": "only-model", },
  }`)
  // Note: parent's canonicalized [native].task.state_dir = "/parent-senpi" deep-merges with project's [native]!
  assert.equal(
    await resolveOmoTaskStateDir(project, { env: { HOME: home }, accountHomeDir: home }),
    '/parent-senpi',
  )

  // When project sets [native].task.state_dir explicitly, it wins verbatim.
  await writeFile(join(project, '.omo', 'omo.jsonc'), `{
    "[native]": { "task": { "state_dir": "relative/verbatim-store", }, },
  }`)
  assert.equal(
    await resolveOmoTaskStateDir(project, { env: { HOME: home }, accountHomeDir: home }),
    'relative/verbatim-store',
  )

  if (process.platform !== 'win32') {
    // Symlinked project omo.jsonc is ignored and falls back to regular omo.json.
    const outside = join(root, 'outside.jsonc')
    await writeFile(outside, '{"task":{"state_dir":"/evil-link"}}')
    await rm(join(project, '.omo', 'omo.jsonc'))
    await symlink(outside, join(project, '.omo', 'omo.jsonc'))
    await writeFile(join(project, '.omo', 'omo.json'), '{"[native]":{"task":{"state_dir":"/proj-json-fallback"}}}')
    assert.equal(
      await resolveOmoTaskStateDir(project, { env: { HOME: home }, accountHomeDir: home }),
      '/proj-json-fallback',
    )

    // Symlinked project .omo directory is skipped entirely.
    const symlinkedProject = join(parent, 'linked-omo-proj')
    const fakeOmo = join(root, 'fake-omo')
    await mkdir(symlinkedProject, { recursive: true })
    await mkdir(fakeOmo, { recursive: true })
    await writeFile(join(fakeOmo, 'omo.jsonc'), '{"[native]":{"task":{"state_dir":"/from-symlink-dir"}}}')
    await symlink(fakeOmo, join(symlinkedProject, '.omo'))
    assert.equal(
      await resolveOmoTaskStateDir(symlinkedProject, { env: { HOME: home }, accountHomeDir: home }),
      '/parent-senpi',
    )

    // Home boundary via symlinked path never treats $HOME/.omo as a project layer.
    const homeAlias = join(root, 'home-alias')
    await symlink(home, homeAlias)
    const otherHome = join(root, 'other-home')
    await mkdir(otherHome, { recursive: true })
    assert.equal(
      await resolveOmoTaskStateDir(homeAlias, { env: { HOME: otherHome }, accountHomeDir: home }),
      join(otherHome, '.omo', 'agent', 'projects', projectStateKey(homeAlias), 'senpi-task'),
    )
  }
})

test('OmoSubagents folds direct child + grandchild + revived runs and reads incremental UTF-8/partial/shrink/inode/id-less JSONL', async t => {
  const root = await makeTempRoot(t)
  const home = join(root, 'home')
  const agentDir = join(root, 'agent')
  const project = join(root, 'proj')
  await mkdir(home, { recursive: true })
  await mkdir(project, { recursive: true })

  const stateDir = join(agentDir, 'projects', projectStateKey(project), 'senpi-task')
  const env = { HOME: home, OMO_CODING_AGENT_DIR: agentDir }
  const reader = new OmoSubagents({ env, accountHomeDir: home })

  // Direct child st_00000001 (paused -> active 1s cadence) spawns grandchild st_00000002 (completed).
  await writeTask(stateDir, 'st_00000001', {
    parent_session_id: 'main-sess',
    root_session_id: 'main-sess',
    child_session_id: 'child-1-sess',
    status: 'paused',
  })
  await writeTask(stateDir, 'st_00000002', {
    parent_session_id: 'child-1-sess',
    root_session_id: 'main-sess',
    child_session_id: 'grandchild-sess',
    status: 'completed',
  })
  // Unrelated session task, tombstone, invalid task_id, and malformed JSON must all be ignored.
  await writeTask(stateDir, 'st_99999999', {
    parent_session_id: 'other-sess',
    root_session_id: 'other-sess',
    status: 'running',
  })
  await writeChildJsonl(stateDir, 'st_99999999', '001.jsonl', assistantLine({ id: 'u1', input: 5000, output: 5000 }))
  await writeTask(stateDir, 'st_00000003', {
    parent_session_id: 'main-sess',
    root_session_id: 'main-sess',
    status: 'completed',
  }, 'st_00000003.json.expunging')
  await writeFile(join(stateDir, 'tasks', 'bad-id.json'), JSON.stringify({
    task_id: '../escape', parent_session_id: 'main-sess', root_session_id: 'main-sess', status: 'running',
  }))
  await writeFile(join(stateDir, 'tasks', 'st_00000004.json'), '{not-json')

  // Child 1 run 1: split multi-byte UTF-8 ("中文🚀") inside an observable runtimeItemKey across polls,
  // plus partial line, id-less entries, and a malformed line.
  const line1 = assistantLine({
    input: 100, output: 20, tools: [{ name: 'read' }, { name: 'bash', runtimeItemKey: 'rt:1' }],
  })
  const line2 = assistantLine({
    input: 50, output: 10, tools: [{ name: 'bash', runtimeItemKey: 'rt:1' }, { name: 'write' }],
  })
  const utf8Line = Buffer.from(assistantLine({
    id: 'c1-utf8',
    input: 30,
    output: 5,
    tools: [{ name: 'read', runtimeItemKey: 'rt:中文🚀' }],
    text: '中文🚀done',
  }), 'utf8')
  // Split right inside the 3-byte UTF-8 sequence for '中' (0xE4 0xB8 0xAD) inside runtimeItemKey.
  const keyAt = utf8Line.indexOf(Buffer.from('rt:中文🚀', 'utf8'))
  assert.ok(keyAt > utf8Line.indexOf('runtimeItemKey'))
  const splitAt = keyAt + 5
  const child1File1 = await writeChildJsonl(
    stateDir, 'st_00000001', '001.jsonl',
    Buffer.concat([Buffer.from(line1 + '{corrupt-line\n' + line2, 'utf8'), utf8Line.subarray(0, splitAt)]),
  )

  // Grandchild: 200+50 tokens, 1 tool, plus missing child dir for a pending sibling st_00000005.
  await writeChildJsonl(stateDir, 'st_00000002', '001.jsonl', assistantLine({
    id: 'gc-1', input: 200, output: 50, tools: [{ name: 'grep' }],
  }))
  await writeTask(stateDir, 'st_00000005', {
    parent_session_id: 'main-sess',
    root_session_id: 'main-sess',
    status: 'pending',
  })

  t.mock.method(Date, 'now', () => 0)

  // Poll 1: line1 (120 tok, 2 tools) + line2 (60 tok, 1 new tool after runtimeItemKey dedup) + gc-1 (250 tok, 1 tool).
  // Partial UTF-8 line is held in carry, not parsed yet.
  const snap1 = await reader.refresh(project, 'main-sess', 100_000)
  assert.equal(snap1.tokens, 120 + 60 + 250)
  assert.equal(snap1.tools, 2 + 1 + 1)
  assert.deepEqual([...snap1.taskIds].sort(), ['st_00000001', 'st_00000002', 'st_00000005'])

  // Poll 2 after completing the split UTF-8 line + appending a repeat of the same UTF-8 runtimeItemKey
  // (which only deduplicates if raw-Buffer carry preserved the exact UTF-8 bytes without \uFFFD corruption)
  // + adding a revived run 2 file `002.jsonl`.
  await appendFile(child1File1, Buffer.concat([
    utf8Line.subarray(splitAt),
    Buffer.from(assistantLine({
      id: 'c1-utf8-dup',
      input: 0,
      output: 0,
      tools: [{ name: 'read', runtimeItemKey: 'rt:中文🚀' }],
    }), 'utf8'),
    Buffer.from(spawnResultLine('c1-spawn', ['st_00000002']), 'utf8'),
  ]))
  const child1File2 = await writeChildJsonl(stateDir, 'st_00000001', '002.jsonl', assistantLine({
    id: 'c1-revive', input: 70, output: 30, tools: [{ name: 'edit' }],
  }))

  // Paused child enforces 1000ms cadence: 100_999 is throttled, 101_000 rescans.
  const throttled = await reader.refresh(project, 'main-sess', 100_999)
  assert.equal(throttled.tokens, 430)

  const snap2 = await reader.refresh(project, 'main-sess', 101_000)
  assert.equal(snap2.tokens, 430 + 35 + 100)
  assert.equal(snap2.tools, 4 + 1 + 1)
  assert.deepEqual([...snap2.taskIds].sort(), ['st_00000001', 'st_00000002', 'st_00000005'])

  // File shrink resets from offset 0.
  await writeFile(child1File2, assistantLine({ id: 'c1-short', input: 10, output: 5 }))
  const snap3 = await reader.refresh(project, 'main-sess', 102_000)
  assert.equal(snap3.tokens, 430 + 35 + 15)
  assert.equal(snap3.tools, 5)

  // Atomic rename (inode change, even with larger or same size) resets from offset 0.
  const tmpReplace = `${child1File2}.tmp`
  await writeFile(tmpReplace, assistantLine({ id: 'c1-short', input: 40, output: 10, tools: [{ name: 'bash' }] }))
  await rename(tmpReplace, child1File2)
  const snap4 = await reader.refresh(project, 'main-sess', 103_000)
  assert.equal(snap4.tokens, 430 + 35 + 50)
  assert.equal(snap4.tools, 6)

  // Expunging st_00000002 & st_00000005 drops their counts and prunes their caches.
  // (st_00000002 remains in taskIds because child 1's own JSONL recorded its accepted spawn!)
  await rm(join(stateDir, 'tasks', 'st_00000002.json'))
  await rm(join(stateDir, 'tasks', 'st_00000005.json'))
  await writeTask(stateDir, 'st_00000001', {
    parent_session_id: 'main-sess',
    root_session_id: 'main-sess',
    child_session_id: 'child-1-sess',
    status: 'completed',
  })
  const snap5 = await reader.refresh(project, 'main-sess', 104_000)
  assert.equal(snap5.tokens, 180 + 35 + 50)
  assert.equal(snap5.tools, 5)
  assert.deepEqual([...snap5.taskIds].sort(), ['st_00000001', 'st_00000002'])

  // All tasks are now terminal -> idle 5000ms cadence unless forced (1000ms floor).
  await appendFile(child1File2, assistantLine({ id: 'c1-late', input: 20, output: 5 }))
  assert.equal((await reader.refresh(project, 'main-sess', 108_999)).tokens, 265)
  assert.equal((await reader.refresh(project, 'main-sess', 104_999, true)).tokens, 265)
  assert.equal((await reader.refresh(project, 'main-sess', 105_000, true)).tokens, 290)
  await appendFile(child1File2, assistantLine({ id: 'c1-idle', input: 10, output: 0 }))
  assert.equal((await reader.refresh(project, 'main-sess', 109_999)).tokens, 290)
  assert.equal((await reader.refresh(project, 'main-sess', 110_000)).tokens, 300)

  // Session change resets snapshot and caches cleanly.
  const emptyOther = await reader.refresh(project, 'brand-new-sess', 110_001)
  assert.equal(emptyOther.tokens, 0)
  assert.equal(emptyOther.tools, 0)
  assert.equal(emptyOther.taskIds.size, 0)

  // Disposal clears snapshot and ignores future refreshes.
  await reader.refresh(project, 'main-sess', 110_002)
  assert.equal(reader.snapshot.tokens, 300)
  reader.dispose()
  assert.equal(reader.snapshot.tokens, 0)
  assert.equal((await reader.refresh(project, 'main-sess', 120_000, true)).tokens, 0)
})

test('OmoSubagents handles slow-scan 10x holdoff, backward clock steps, cycles, and unreadable dirs without rejecting', async t => {
  const root = await makeTempRoot(t)
  const home = join(root, 'home')
  const agentDir = join(root, 'agent')
  const project = join(root, 'proj')
  await mkdir(home, { recursive: true })
  await mkdir(project, { recursive: true })

  const stateDir = join(agentDir, 'projects', projectStateKey(project), 'senpi-task')
  // Cycle: A <-> B
  await writeTask(stateDir, 'st_0000000a', {
    parent_session_id: 'root-sess',
    root_session_id: 'root-sess',
    child_session_id: 'sess-a',
    status: 'running',
  })
  await writeTask(stateDir, 'st_0000000b', {
    parent_session_id: 'sess-a',
    root_session_id: 'root-sess',
    child_session_id: 'root-sess',
    status: 'running',
  })
  const fileA = await writeChildJsonl(stateDir, 'st_0000000a', '001.jsonl', assistantLine({ id: 'a1', input: 10, output: 5 }))

  let clock = 0
  t.mock.method(Date, 'now', () => {
    const now = clock
    clock += 600
    return now
  })
  const reader = new OmoSubagents({ env: { HOME: home, OMO_CODING_AGENT_DIR: agentDir }, accountHomeDir: home })
  const first = await reader.refresh(project, 'root-sess', 100_000)
  assert.equal(first.tokens, 15)
  assert.deepEqual([...first.taskIds].sort(), ['st_0000000a', 'st_0000000b'])

  // 600ms scan -> 6000ms holdoff after end (100_000 + 600 + 6000 = 106_600), even when active or forced.
  await appendFile(fileA, assistantLine({ id: 'a2', input: 20, output: 5 }))
  assert.equal((await reader.refresh(project, 'root-sess', 106_599, true)).tokens, 15)
  assert.equal((await reader.refresh(project, 'root-sess', 106_600, true)).tokens, 40)

  // Backward clock step must not freeze readings.
  await appendFile(fileA, assistantLine({ id: 'a3', input: 10, output: 0 }))
  assert.equal((await reader.refresh(project, 'root-sess', 99_999)).tokens, 50)

  // Unreadable tasks dir never rejects.
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const locked = join(root, 'locked-state')
    await mkdir(join(locked, 'tasks'), { recursive: true })
    await chmod(join(locked, 'tasks'), 0o000)
    t.after(() => chmod(join(locked, 'tasks'), 0o700).catch(() => {}))
    const lockedReader = new OmoSubagents({
      env: { HOME: home, OMO_CODING_AGENT_DIR: agentDir },
      accountHomeDir: home,
    })
    await mkdir(join(project, '.omo'), { recursive: true })
    await writeFile(join(project, '.omo', 'omo.jsonc'), JSON.stringify({ task: { state_dir: locked } }))
    const res = await lockedReader.refresh(project, 'root-sess', 200_000)
    assert.equal(res.tokens, 0)
  }
})

test('OmoSubagents coalesces concurrent refreshes and resets cleanly on cwd change', async t => {
  const root = await makeTempRoot(t)
  const home = join(root, 'home')
  const agentDir = join(root, 'agent')
  const projA = join(root, 'proj-a')
  const projB = join(root, 'proj-b')
  await mkdir(home, { recursive: true })
  await mkdir(projA, { recursive: true })
  await mkdir(projB, { recursive: true })

  const stateA = join(agentDir, 'projects', projectStateKey(projA), 'senpi-task')
  const stateB = join(agentDir, 'projects', projectStateKey(projB), 'senpi-task')
  await writeTask(stateA, 'st_00000001', { parent_session_id: 's1', root_session_id: 's1', status: 'completed' })
  await writeChildJsonl(stateA, 'st_00000001', '001.jsonl', assistantLine({ id: 'a1', input: 100, output: 20 }))
  await writeTask(stateB, 'st_00000002', { parent_session_id: 's1', root_session_id: 's1', status: 'completed' })
  await writeChildJsonl(stateB, 'st_00000002', '001.jsonl', assistantLine({ id: 'b1', input: 300, output: 50 }))

  const reader = new OmoSubagents({ env: { HOME: home, OMO_CODING_AGENT_DIR: agentDir }, accountHomeDir: home })
  const [r1, r2] = await Promise.all([
    reader.refresh(projA, 's1', 10_000),
    reader.refresh(projA, 's1', 10_000, true),
  ])
  assert.equal(r1.tokens, 120)
  assert.equal(r1, r2)

  // Concurrent cwd change immediately resets snapshot and resolves to the new cwd's store.
  const first = reader.refresh(projA, 's1', 20_000)
  const second = reader.refresh(projB, 's1', 20_000)
  assert.equal(reader.snapshot.tokens, 0)
  await first
  const bSnap = await second
  assert.equal(bSnap.tokens, 350)
  assert.deepEqual([...bSnap.taskIds], ['st_00000002'])
})

test('OmoSubagents matches byParent and byRoot independently and recovers after transient task read errors', async t => {
  const root = await makeTempRoot(t)
  const home = join(root, 'home')
  const agentDir = join(root, 'agent')
  const project = join(root, 'proj')
  await mkdir(home, { recursive: true })
  await mkdir(project, { recursive: true })

  const stateDir = join(agentDir, 'projects', projectStateKey(project), 'senpi-task')
  const env = { HOME: home, OMO_CODING_AGENT_DIR: agentDir }
  const reader = new OmoSubagents({ env, accountHomeDir: home })

  // Child-1 (parent=main, root=main) -> Grandchild (parent=child-1, root=main) -> Great-grandchild (parent=gc-1, root=main).
  // Sibling-2 (parent=main, root=main).
  // Orphan-root (parent=gone-intermediate, root=main) is reachable ONLY via root_session_id.
  await writeTask(stateDir, 'st_00000001', {
    parent_session_id: 'main', root_session_id: 'main', child_session_id: 'child-1', status: 'completed',
  })
  await writeTask(stateDir, 'st_00000002', {
    parent_session_id: 'child-1', root_session_id: 'main', child_session_id: 'gc-1', status: 'completed',
  })
  await writeTask(stateDir, 'st_00000003', {
    parent_session_id: 'gc-1', root_session_id: 'main', status: 'completed',
  })
  await writeTask(stateDir, 'st_00000004', {
    parent_session_id: 'main', root_session_id: 'main', status: 'completed',
  })
  await writeTask(stateDir, 'st_00000005', {
    parent_session_id: 'expunged-mid', root_session_id: 'main', status: 'completed',
  })
  await writeChildJsonl(stateDir, 'st_00000002', '001.jsonl', assistantLine({ id: 'g1', input: 100, output: 0 }))
  await writeChildJsonl(stateDir, 'st_00000003', '001.jsonl', assistantLine({ id: 'gg1', input: 50, output: 0 }))
  await writeChildJsonl(stateDir, 'st_00000004', '001.jsonl', assistantLine({ id: 's1', input: 900, output: 0 }))
  await writeChildJsonl(stateDir, 'st_00000005', '001.jsonl', assistantLine({ id: 'o1', input: 70, output: 0 }))

  // Viewing from child-1: matches ONLY via parent_session_id closure (st_00000002 -> st_00000003);
  // excludes parent st_00000001, sibling st_00000004, and orphan st_00000005 (all have root=main).
  const childView = await reader.refresh(project, 'child-1', 10_000)
  assert.equal(childView.tokens, 150)
  assert.deepEqual([...childView.taskIds].sort(), ['st_00000002', 'st_00000003'])

  // Viewing from main: also admits st_00000005 solely via root_session_id despite missing intermediate parent.
  const mainView = await reader.refresh(project, 'main', 20_000)
  assert.equal(mainView.tokens, 150 + 900 + 70)
  assert.deepEqual([...mainView.taskIds].sort(), [
    'st_00000001', 'st_00000002', 'st_00000003', 'st_00000004', 'st_00000005',
  ])

  // Transient read error (stat succeeds, open/read fails) must NOT poison taskCache with null
  // when the file becomes readable again with unchanged (ino, mtimeMs, size).
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const taskFile = join(stateDir, 'tasks', 'st_00000006.json')
    await writeTask(stateDir, 'st_00000006', {
      parent_session_id: 'transient-sess', root_session_id: 'transient-sess', status: 'completed',
    })
    await writeChildJsonl(stateDir, 'st_00000006', '001.jsonl', assistantLine({ id: 't1', input: 400, output: 200 }))
    await chmod(taskFile, 0o000)
    t.after(() => chmod(taskFile, 0o644).catch(() => {}))

    t.mock.method(Date, 'now', () => 0)
    const transientReader = new OmoSubagents({ env, accountHomeDir: home })
    const failed = await transientReader.refresh(project, 'transient-sess', 100_000)
    assert.equal(failed.tokens, 0)
    assert.equal(failed.taskIds.size, 0)

    await chmod(taskFile, 0o644)
    const recovered = await transientReader.refresh(project, 'transient-sess', 101_000, true)
    assert.equal(recovered.tokens, 600)
    assert.deepEqual([...recovered.taskIds], ['st_00000006'])
  }
})

test('OmoSubagents excludes confirmed pre-launch refused task records while keeping children that ran and later failed', async t => {
  const root = await makeTempRoot(t)
  const home = join(root, 'home')
  const agentDir = join(root, 'agent')
  const project = join(root, 'proj')
  await mkdir(home, { recursive: true })
  await mkdir(project, { recursive: true })

  const stateDir = join(agentDir, 'projects', projectStateKey(project), 'senpi-task')
  const reader = new OmoSubagents({ env: { HOME: home, OMO_CODING_AGENT_DIR: agentDir }, accountHomeDir: home })

  // 1. Confirmed pre-launch refusal (no child_session_id, no recorded child work): must NOT enter taskIds.
  await writeTask(stateDir, 'st_00000001', {
    parent_session_id: 'root',
    root_session_id: 'root',
    status: 'error',
    failure_kind: 'model_unavailable',
    failure_reason: 'model_not_in_child_profile',
  })

  // 2. Accepted completed child.
  await writeTask(stateDir, 'st_00000002', {
    parent_session_id: 'root',
    root_session_id: 'root',
    child_session_id: 'child-2',
    status: 'completed',
  })
  // Child 2 also recorded a refused grandchild spawn receipt in its own JSONL (must be excluded too).
  await writeChildJsonl(stateDir, 'st_00000002', '001.jsonl', [
    assistantLine({ id: 'c2-a1', input: 100, output: 20, tools: [{ name: 'task' }] }),
    JSON.stringify({
      id: 'c2-r1',
      type: 'message',
      timestamp: '2026-11-23T00:00:01Z',
      message: {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'task',
        details: {
          mode: 'spawn',
          task_id: 'st_00000009',
          status: 'error',
          failure_kind: 'model_unavailable',
          failure_reason: 'model_not_in_child_profile',
        },
      },
    }) + '\n',
  ].join(''))

  const snap1 = await reader.refresh(project, 'root', 10_000)
  assert.deepEqual([...snap1.taskIds], ['st_00000002'])
  assert.equal(snap1.tokens, 120)
  assert.equal(snap1.tools, 1)

  // 3. Controls that actually ran and later errored MUST stay counted along with their work:
  //    (a) bare status:'error' with runtime work; (b) paused child that failed resume with session_unavailable + child_session_id;
  //    (c) reused task_id whose record later got overwritten with a pre-launch refusal but still has recorded JSONL work.
  await writeTask(stateDir, 'st_00000003', {
    parent_session_id: 'root',
    root_session_id: 'root',
    child_session_id: 'child-3',
    status: 'error',
    error_message: 'runtime failure',
  })
  await writeChildJsonl(stateDir, 'st_00000003', '001.jsonl', assistantLine({
    id: 'c3-a1', input: 200, output: 50, tools: [{ name: 'read' }],
  }))
  await writeTask(stateDir, 'st_00000004', {
    parent_session_id: 'root',
    root_session_id: 'root',
    child_session_id: 'child-4',
    status: 'error',
    failure_kind: 'session_unavailable',
  })
  await writeTask(stateDir, 'st_00000005', {
    parent_session_id: 'root',
    root_session_id: 'root',
    status: 'error',
    failure_kind: 'model_unavailable',
  })
  await writeChildJsonl(stateDir, 'st_00000005', '001.jsonl', assistantLine({
    id: 'c5-a1', input: 30, output: 10,
  }))
  await writeTask(stateDir, 'st_00000006', {
    parent_session_id: 'root',
    root_session_id: 'root',
    status: 'error',
    failure_kind: 'host_unavailable',
    pid: 9876,
  })
  await writeTask(stateDir, 'st_00000007', {
    parent_session_id: 'root',
    root_session_id: 'root',
    status: 'error',
    failure_kind: 'session_unavailable',
    host_session: { session_path: '/tmp/child.jsonl' },
  })
  await writeTask(stateDir, 'st_00000008', {
    parent_session_id: 'root',
    root_session_id: 'root',
    status: 'error',
    failure_kind: 'host_unavailable',
    effective_model: { model_id: 'gpt-6.1-sol' },
  })

  const snap2 = await reader.refresh(project, 'root', 20_000, true)
  assert.deepEqual(
    [...snap2.taskIds].sort(),
    ['st_00000002', 'st_00000003', 'st_00000004', 'st_00000005', 'st_00000006', 'st_00000007', 'st_00000008'],
  )
  assert.equal(snap2.tokens, 120 + 250 + 40)
  assert.equal(snap2.tools, 2)
})

test('OmoSubagents folds and deduplicates explicitly resolved grandchild skills across child JSONLs and expunge', async t => {
  const root = await makeTempRoot(t)
  const home = join(root, 'home')
  const agentDir = join(root, 'agent')
  const project = join(root, 'proj')
  await mkdir(home, { recursive: true })
  await mkdir(project, { recursive: true })

  const stateDir = join(agentDir, 'projects', projectStateKey(project), 'senpi-task')
  const reader = new OmoSubagents({ env: { HOME: home, OMO_CODING_AGENT_DIR: agentDir }, accountHomeDir: home })

  await writeTask(stateDir, 'st_00000001', {
    parent_session_id: 'root',
    root_session_id: 'root',
    child_session_id: 'child-1',
    status: 'running',
  })
  await writeChildJsonl(stateDir, 'st_00000001', '001.jsonl', [
    JSON.stringify({
      id: 'gc-spawn-1',
      type: 'message',
      timestamp: '2026-11-23T00:00:01Z',
      message: {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'task',
        details: {
          mode: 'spawn',
          items: [
            {
              task_id: 'st_00000002',
              status: 'completed',
              skills: { requested: ['review', 'audit', 'missing'], resolved: ['review', 'audit'], missing: ['missing'] },
            },
            {
              task_id: 'st_00000003',
              status: 'error',
              failure_kind: 'model_unavailable',
              skills: { requested: ['blocked'], resolved: ['blocked'], missing: [] },
            },
          ],
        },
      },
    }) + '\n',
  ].join(''))
  // Revived run 002.jsonl replays ('st_00000002', 'review') and adds ('st_00000002', 'lint') without
  // overwriting or aliasing 001.jsonl's cached ('st_00000002', 'audit').
  const run2Path = await writeChildJsonl(stateDir, 'st_00000001', '002.jsonl', [
    JSON.stringify({
      id: 'gc-spawn-2',
      type: 'message',
      timestamp: '2026-11-23T00:00:02Z',
      message: {
        role: 'toolResult',
        toolCallId: 'call-2',
        toolName: 'task',
        details: {
          mode: 'spawn',
          task_id: 'st_00000002',
          status: 'completed',
          skills: { requested: ['review', 'lint'], resolved: ['review', 'lint'], missing: [] },
        },
      },
    }) + '\n',
  ].join(''))

  const snap1 = await reader.refresh(project, 'root', 10_000)
  assert.deepEqual([...snap1.taskIds].sort(), ['st_00000001', 'st_00000002'])
  assert.deepEqual([...snap1.skills.keys()], ['st_00000002'])
  assert.deepEqual([...snap1.skills.get('st_00000002')!].sort(), ['audit', 'lint', 'review'])

  // Shrinking 002.jsonl drops 'lint' while preserving 001.jsonl's cached ['audit', 'review'].
  await writeFile(run2Path, '')
  const snapShrunk = await reader.refresh(project, 'root', 15_000, true)
  assert.deepEqual([...snapShrunk.skills.keys()], ['st_00000002'])
  assert.deepEqual([...snapShrunk.skills.get('st_00000002')!].sort(), ['audit', 'review'])

  // Expunging child 1 drops its nested grandchild skill receipts cleanly.
  await rm(join(stateDir, 'tasks', 'st_00000001.json'))
  const snap2 = await reader.refresh(project, 'root', 20_000, true)
  assert.equal(snap2.skills.size, 0)
  assert.equal(snap2.taskIds.size, 0)
})

test('OmoSubagents excludes admission-exhausted chains, carries refused run fences, and reconciles queued grandchild receipts', async t => {
  const root = await makeTempRoot(t)
  const home = join(root, 'home')
  const agentDir = join(root, 'agent')
  const project = join(root, 'proj')
  await mkdir(home, { recursive: true })
  await mkdir(project, { recursive: true })

  const stateDir = join(agentDir, 'projects', projectStateKey(project), 'senpi-task')
  const reader = new OmoSubagents({ env: { HOME: home, OMO_CODING_AGENT_DIR: agentDir }, accountHomeDir: home })

  // 1. Two-model fallback chain exhausted at admission (no child_session_id, explicit admission reason):
  //    must be excluded from taskIds and exposed in refusedTasks with [run_start_epoch, run_epoch].
  await writeTask(stateDir, 'st_00000001', {
    parent_session_id: 'root',
    root_session_id: 'root',
    status: 'error',
    failure_kind: 'model_chain_exhausted',
    failure_reason: 'model_not_in_child_profile',
    notification: { run_epoch: 1, notified_epoch: -1 },
    run_start_epoch: 0,
  })

  // 2. Control: child started, stored child_session_id, and exhausted model chain mid-turn (no failure_reason):
  //    MUST stay in taskIds and NOT appear in refusedTasks.
  await writeTask(stateDir, 'st_00000002', {
    parent_session_id: 'root',
    root_session_id: 'root',
    child_session_id: 'child-mid-turn',
    status: 'error',
    failure_kind: 'model_chain_exhausted',
    notification: { run_epoch: 1, notified_epoch: 1 },
    run_start_epoch: 0,
  })
  await writeChildJsonl(stateDir, 'st_00000002', '001.jsonl', [
    assistantLine({ id: 'c2-a1', input: 100, output: 20, tools: [{ name: 'task' }] }),
    // Child 2 queued grandchild st_00000003 (pending, run_epoch 0) with resolved skill `audit`,
    // plus grandchild st_00000004 (earlier run 0 pending + later run 1 refused in store).
    JSON.stringify({
      id: 'c2-r1',
      type: 'message',
      timestamp: '2026-11-23T00:00:01Z',
      message: {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'task',
        details: {
          mode: 'spawn',
          items: [
            {
              task_id: 'st_00000003',
              run_epoch: 0,
              status: 'pending',
              queue_position: 1,
              skills: { requested: ['audit'], resolved: ['audit'], missing: [] },
            },
            {
              task_id: 'st_00000004',
              run_epoch: 0,
              status: 'pending',
              queue_position: 1,
              skills: { requested: ['kept'], resolved: ['kept'], missing: [] },
            },
            {
              task_id: 'st_00000004',
              run_epoch: 1,
              status: 'pending',
              queue_position: 1,
              skills: { requested: ['dropped'], resolved: ['dropped'], missing: [] },
            },
          ],
        },
      },
    }) + '\n',
  ].join(''))

  // 3. Queued grandchild st_00000003 refused at admission (run 0).
  await writeTask(stateDir, 'st_00000003', {
    parent_session_id: 'child-mid-turn',
    root_session_id: 'root',
    status: 'error',
    failure_kind: 'model_unavailable',
    failure_reason: 'model_not_in_child_profile',
    notification: { run_epoch: 0, notified_epoch: -1 },
    run_start_epoch: 0,
  })

  // 4. Reused grandchild st_00000004 whose revived run 1 (run_start_epoch 1) was refused at admission:
  //    run 0 (`kept`) must survive, while run 1 (`dropped`) is reconciled away.
  await writeTask(stateDir, 'st_00000004', {
    parent_session_id: 'child-mid-turn',
    root_session_id: 'root',
    status: 'error',
    failure_kind: 'model_unavailable',
    failure_reason: 'model_not_in_child_profile',
    notification: { run_epoch: 1, notified_epoch: -1 },
    run_start_epoch: 1,
  })

  // 5. Legacy store refusal (notification.run_epoch without run_start_epoch) uses exact-epoch fence,
  //    and prior_runs_cost_usd > 0 marks a previously launched task (never a pre-launch refusal).
  await writeTask(stateDir, 'st_00000005', {
    parent_session_id: 'root',
    root_session_id: 'root',
    status: 'error',
    failure_kind: 'model_unavailable',
    notification: { run_epoch: 2 },
  })
  await writeTask(stateDir, 'st_00000006', {
    parent_session_id: 'root',
    root_session_id: 'root',
    status: 'error',
    failure_kind: 'model_unavailable',
    prior_runs_cost_usd: 0.05,
    notification: { run_epoch: 1 },
    run_start_epoch: 1,
  })
  // Malformed notification / inverted epoch fence must fail closed (never emit a bogus refusal fence).
  await writeTask(stateDir, 'st_00000007', {
    parent_session_id: 'root',
    root_session_id: 'root',
    status: 'error',
    failure_kind: 'model_unavailable',
    notification: { run_epoch: 1 },
    run_start_epoch: 3,
  })

  const snap = await reader.refresh(project, 'root', 10_000)
  assert.deepEqual([...snap.taskIds].sort(), ['st_00000002', 'st_00000004', 'st_00000006'])
  assert.equal(snap.tokens, 120)
  assert.equal(snap.tools, 1)
  assert.deepEqual([...snap.skills.keys()], ['st_00000004'])
  assert.deepEqual([...snap.skills.get('st_00000004')!], ['kept'])
  assert.deepEqual(snap.refusedTasks.get('st_00000001'), [{ runStartEpoch: 0, runEpoch: 1 }])
  assert.equal(snap.refusedTasks.has('st_00000002'), false)
  assert.deepEqual(snap.refusedTasks.get('st_00000003'), [{ runStartEpoch: 0, runEpoch: 0 }])
  assert.deepEqual(snap.refusedTasks.get('st_00000004'), [{ runStartEpoch: 1, runEpoch: 1 }])
  assert.deepEqual(snap.refusedTasks.get('st_00000005'), [{ runStartEpoch: 2, runEpoch: 2 }])
  assert.equal(snap.refusedTasks.has('st_00000006'), false)
  assert.equal(snap.refusedTasks.has('st_00000007'), false)

  const id = 'st_00000004'
  await rm(join(stateDir, 'tasks', id + '.json'))
  const expired = await reader.refresh(project, 'root', 20_000)
  assert.deepEqual([...expired.skills.get(id)!], ['kept'])

  // A launched run between two refusals keeps its own skill, even after both records expire.
  const parent = { parent_session_id: 'child-mid-turn', root_session_id: 'root' }
  const receipt = (epoch: number, skill: string) => JSON.stringify({
    id: 'spawn-' + epoch, type: 'message', message: {
      role: 'toolResult', toolName: 'task',
      details: { mode: 'spawn', task_id: id, run_epoch: epoch, status: 'pending', skills: { resolved: [skill] } },
    },
  }) + '\n'
  await writeChildJsonl(stateDir, 'st_00000002', '002.jsonl', receipt(2, 'review'))
  await writeTask(stateDir, id, { ...parent, status: 'completed', child_session_id: 'revived',
    run_start_epoch: 2, notification: { run_epoch: 2 } })
  const launched = await reader.refresh(project, 'root', 30_000)
  assert.ok(launched.taskIds.has(id))
  assert.deepEqual([...launched.skills.get(id)!].sort(), ['kept', 'review'])

  await writeChildJsonl(stateDir, 'st_00000002', '003.jsonl', receipt(3, 'lint'))
  const later = await writeTask(stateDir, id, { ...parent, status: 'error', failure_kind: 'model_unavailable',
    run_start_epoch: 3, notification: { run_epoch: 3 } })
  await reader.refresh(project, 'root', 40_000)
  await rm(later)
  const expiredAgain = await reader.refresh(project, 'root', 50_000)
  assert.deepEqual([...expiredAgain.skills.get(id)!].sort(), ['kept', 'review'])
  assert.deepEqual(expired.refusedTasks.get(id), [{ runStartEpoch: 1, runEpoch: 1 }])

  // Subsequent evidence of a launch corrects epoch 3 alone. Epoch 1's skill stays excluded.
  await writeTask(stateDir, id, { ...parent, status: 'completed', child_session_id: 'confirmed',
    run_start_epoch: 3, notification: { run_epoch: 3 } })
  const corrected = await reader.refresh(project, 'root', 60_000)
  assert.deepEqual([...corrected.skills.get(id)!].sort(), ['kept', 'lint', 'review'])

  await mkdir(join(project, '.omo'))
  await writeFile(join(project, '.omo', 'omo.json'), JSON.stringify({ task: { state_dir: join(root, 'other-store') } }))
  assert.equal((await reader.refresh(project, 'root', 70_000)).refusedTasks.size, 0)
})
