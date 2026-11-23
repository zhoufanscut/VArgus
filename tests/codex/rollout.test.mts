import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, appendFile, rm, mkdir, symlink, readFile, utimes, cp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import zlib from 'node:zlib'
import { syncBuiltinESMExports } from 'node:module'
import { RolloutReader, findRollout, savedTranscript } from '../../src/hosts/codex/rollout.ts'
import { cachedModelDefault } from '../../src/hosts/codex/model-defaults.ts'
import { FooterSettings } from '../../src/hosts/codex/footer.ts'
import { codexLine } from '../../src/cli/codex/line.ts'
import { resolveCodexOptions } from '../../src/hosts/codex/options.ts'
import { makeTheme } from '../../src/theme/index.ts'

const meta = { type: 'session_meta', payload: { id: 'thread-a', cwd: '/repo', timestamp: '2026-11-08T05:41:17Z' } }
const amount = { input_tokens: 42424, cached_input_tokens: 40000, output_tokens: 777, total_tokens: 43201 }
const count = { type: 'event_msg', payload: { type: 'token_count', info: {
  total_token_usage: amount, last_token_usage: amount, model_context_window: 190000,
}, rate_limits: { limit_id: 'codex', primary: { used_percent: 27.5, window_minutes: 300, resets_at: null } } } }
const settings = { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: 'thread-a',
  thread_settings: { model: 'gpt-6.1-sol', reasoning_effort: 'low', cwd: '/repo' } } }

test('official rollout readings replay cumulative usage, settings and limits without counting user-shell controls', () => {
  const r = new RolloutReader('/unused', 'thread-a', '/repo', '/home/user')
  r.observe(meta); r.observe(settings); r.observe(count); r.observe(count)
  r.observe({ type: 'event_msg', payload: { type: 'item_completed', thread_id: 'thread-a',
    item: { type: 'CommandExecution', id: 'user', source: 'user_shell' } } })
  assert.equal(r.collector.snapshot()!.session.counts.tools, 0)
  const tool = { type: 'event_msg', payload: { type: 'item_completed', thread_id: 'thread-a',
    item: { type: 'CommandExecution', id: 'tool', source: 'agent' } } }
  r.observe(tool); r.observe(tool)
  const v = r.collector.snapshot()!
  assert.equal(v.session.model, 'gpt-6.1-sol'); assert.equal(v.session.effort, 'low')
  assert.equal(v.session.counts.tokens, 3201); assert.equal(v.session.counts.tools, 1)
  assert.equal(v.session.contextPercent, 18); assert.partialDeepStrictEqual(v.limits[0], { percent: 27.5 })
  r.observe({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: 'other',
    thread_settings: { model: 'wrong', cwd: '/wrong' } } })
  assert.equal(v.session.model, 'gpt-6.1-sol')
  r.observe({ type: 'compacted', payload: {} }); assert.equal(v.session.contextPercent, undefined)
  r.observe(count); assert.equal(v.session.contextPercent, 18)
})

test('a tool request without fresh usage clears the cache suffix while a duplicate quota update keeps it', () => {
  const r = new RolloutReader('/unused', 'thread-a', '/repo', '/home/user')
  r.observe(meta)
  r.observe(count)
  const session = r.collector.snapshot()!.session
  const hit = session.cacheHitPercent
  assert.equal(Math.round(hit!), 94)
  r.observe(count)
  assert.equal(session.cacheHitPercent, hit)
  r.observe({ type: 'response_item', payload: { type: 'function_call', name: 'tool', call_id: 'c' } })
  r.observe(count)
  r.observe(count)
  assert.equal(session.cacheHitPercent, undefined)
})

test('rollout polling waits for complete UTF-8 JSONL records and selects the exact thread filename', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-rollout-'))
  try {
    await mkdir(join(dir, 'sessions'))
    const file = join(dir, 'sessions', 'rollout-date-thread-a.jsonl')
    await writeFile(file, JSON.stringify(meta) + '\n')
    await writeFile(join(dir, 'sessions', 'rollout-date-thread-b.jsonl'), 'other conversation')
    assert.equal(await findRollout(dir, 'thread-a'), await realpath(file))
    const r = new RolloutReader(file, 'thread-a', '/repo', dir)
    await r.poll()
    const text = JSON.stringify({ type: 'turn_context', payload: { model: 'model', cwd: '/repo/中文', effort: 'low' } }) + '\n'
    const data = Buffer.from(text), split = data.indexOf(Buffer.from('中文')) + 1
    await appendFile(file, data.subarray(0, split)); await r.poll()
    assert.equal(r.collector.snapshot()!.core.cwd, '/repo')
    await appendFile(file, data.subarray(split)); await r.poll()
    assert.equal(r.collector.snapshot()!.core.cwd, '/repo/中文')
    await appendFile(file, JSON.stringify(count) + '\n'); await r.poll()
    assert.equal(r.collector.snapshot()!.session.counts.tokens, 3201)
    await writeFile(file, ''); await assert.rejects(r.poll(), /replaced/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('Codex effort colour follows the exact model in the current local catalog', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-model-default-'))
  try {
    const file = join(dir, 'rollout.jsonl'), catalog = join(dir, 'models_cache.json')
    const theme = makeTheme('graphite', false)
    const r = new RolloutReader(file, 'thread-a', '/repo', dir, cachedModelDefault(dir, () => null))
    const options = resolveCodexOptions({ repo: false, branch: false, status: false })
    const line = codexLine(r.collector, options, theme)
    const calm = theme.paint('label', 'sol:') + theme.paint('calm', 'low')
    const alert = theme.paint('label', 'sol:') + theme.paint('alert', 'low')
    const saveCatalog = (originalSol: string) => writeFile(catalog, JSON.stringify({ models: [
      { slug: 'gpt-6.1-sol', default_reasoning_level: 'low' },
      { slug: 'gpt-6-sol', default_reasoning_level: originalSol },
    ] }))
    await saveCatalog('medium')
    const first = { ...meta, payload: { ...meta.payload, model_provider: 'openai' } }
    await writeFile(file, [first, settings].map(record => JSON.stringify(record) + '\n').join(''))
    await r.poll()
    assert.ok((await line(200)).includes(calm))
    await appendFile(file, JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-sol', cwd: '/repo', effort: 'low' } }) + '\n')
    await r.poll()
    assert.ok((await line(200)).includes(alert))
    await saveCatalog('low')
    await r.poll()
    assert.ok((await line(200)).includes(calm))
    await rm(catalog)
    await r.poll()
    assert.ok((await line(200)).includes(alert))
    await saveCatalog('low')
    await appendFile(file, JSON.stringify({ ...settings, payload: { ...settings.payload,
      thread_settings: { ...settings.payload.thread_settings, model_provider_id: 'local_mock' } } }) + '\n')
    await r.poll()
    assert.ok((await line(200)).includes(alert))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('Codex uses a configured catalog for the saved workspace before the home cache', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-model-catalog-'))
  try {
    const file = join(dir, 'rollout.jsonl'), catalog = join(dir, 'configured.json')
    const model = 'gpt-6.1-sol'
    const models = (effort: string) => JSON.stringify({ models: [{ slug: model, default_reasoning_level: effort }] })
    await writeFile(join(dir, 'models_cache.json'), models('low'))
    await writeFile(catalog, models('xhigh'))
    const footer = new FooterSettings(async cwd => ({ selection: null, modelCatalog: cwd === '/custom' ? catalog : null }))
    await footer.preload(['/repo', '/custom'])
    const reader = new RolloutReader(file, 'thread-a', '/repo', dir,
      cachedModelDefault(dir, cwd => footer.modelCatalog(cwd)))
    const theme = makeTheme('graphite', false)
    const options = resolveCodexOptions({ repo: false, branch: false, status: false })
    const line = codexLine(reader.collector, options, theme)
    const context = (cwd: string, effort: string) => JSON.stringify({ type: 'turn_context', payload: { model, cwd, effort } }) + '\n'
    const first = { ...meta, payload: { ...meta.payload, model_provider: 'openai' } }
    await writeFile(file, JSON.stringify(first) + '\n' + context('/repo', 'low'))
    await reader.poll()
    assert.ok((await line(200)).includes(theme.paint('calm', 'low')))
    await appendFile(file, context('/custom', 'high'))
    await reader.poll()
    assert.ok((await line(200)).includes(theme.paint('alert', 'high')))
    await rm(catalog)
    await appendFile(file, context('/custom', 'low'))
    await reader.poll()
    assert.ok((await line(200)).includes(theme.paint('alert', 'low')))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('Fast selection follows thread settings and survives same-model turn contexts', () => {
  const r = new RolloutReader('/unused', 'thread-a', '/repo', '/home/user')
  r.observe(meta)
  const v = r.collector.snapshot()!
  assert.equal(v.session.fast, undefined)
  const select = (service_tier: string | null | undefined, thread_id = 'thread-a') => r.observe({
    ...settings, payload: { ...settings.payload, thread_id, thread_settings: { ...settings.payload.thread_settings, service_tier } },
  })
  select('priority')
  assert.equal(v.session.fast, true)
  r.observe({ type: 'turn_context', payload: { model: 'gpt-6.1-sol', cwd: '/repo', effort: 'max' } })
  assert.equal(v.session.fast, true)
  select('default', 'other')
  assert.equal(v.session.fast, true)
  for (const tier of ['default', null, undefined, 'flex', 'ultrafast']) {
    select(tier)
    assert.equal(v.session.fast, false)
    select('fast')
    assert.equal(v.session.fast, true)
  }
  r.observe({ type: 'turn_context', payload: { model: 'gpt-6-luna', cwd: '/repo' } })
  assert.equal(v.session.fast, undefined)
})

test('recorded subagent starts count once without changing tool totals or summing child histories', () => {
  const r = new RolloutReader('/unused', 'thread-a', '/repo', '/home/user')
  r.observe(meta)
  const item = (id: string, extra: Record<string, unknown>) => ({ type: 'event_msg', payload: {
    type: 'item_completed', thread_id: 'thread-a', item: { id, ...extra },
  } })
  const spawn = item('first', { type: 'SubAgentActivity', kind: 'started', agent_thread_id: 'child' })
  r.observe(spawn); r.observe(spawn)
  r.observe(item('first', { type: 'CollabAgentToolCall', tool: 'spawn_agent', status: 'completed' }))
  r.observe(item('second', { type: 'CollabAgentToolCall', tool: 'spawn_agent', status: 'completed' }))
  r.observe(item('failed', { type: 'CollabAgentToolCall', tool: 'spawn_agent', status: 'failed' }))
  r.observe(item('interaction', { type: 'SubAgentActivity', kind: 'interacted' }))
  r.observe({ type: 'event_msg', payload: { ...spawn.payload, thread_id: 'child', item: { ...spawn.payload.item, id: 'nested' } } })
  assert.deepEqual(r.collector.snapshot()!.session.counts, { tokens: 0, tools: 0, agents: 2, skills: 0 })
})

test('skill loads use marked injections or successful catalogued reads, once per skill per turn', () => {
  const r = new RolloutReader('/unused', 'thread-a', '/repo', '/home/user')
  r.observe(meta)
  const start = (turn_id: string) => r.observe({ type: 'event_msg', payload: { type: 'task_started', turn_id } })
  const message = (role: string, kind: string, text: string, turn_id = 'one') => r.observe({ type: 'response_item', payload: {
    type: 'message', role, content: [{ type: 'input_text', text }],
    internal_chat_message_metadata_passthrough: { turn_id, content_item_kinds: [kind] },
  } })
  message('developer', 'host_skills.instructions', '<skills_instructions>\n### Skill roots\n- `r0` = `/repo/.agents/skills`\n### Available skills\n- alpha: Fixture. (file: r0/alpha/SKILL.md)\n- beta: Fixture. (file: /repo/.agents/skills/beta/SKILL.md)\n</skills_instructions>')
  start('one')
  const injection = '<skill>\n<name>alpha</name>\n<path>/repo/.agents/skills/alpha/SKILL.md</path>\ninstructions\n</skill>'
  message('user', 'skills.selected_skill_instructions', injection)
  message('user', 'skills.selected_skill_instructions', injection)
  message('user', 'user.text', injection.replaceAll('alpha', 'beta'))
  const read = (path: string, id = path, extra: Record<string, unknown> = {}, thread_id = 'thread-a', turn_id = 'one') => r.observe({ type: 'event_msg', payload: {
    type: 'item_completed', thread_id, turn_id, item: { id, type: 'CommandExecution', source: 'unified_exec_startup',
      cwd: pathToFileURL(resolve('/repo')).href, parsed_cmd: [{ type: 'read', path }], status: 'completed', exit_code: 0, ...extra },
  } })
  read('.agents/skills/alpha/SKILL.md')
  read('.agents/skills/beta/SKILL.md', 'failed', { exit_code: 1 })
  read('.agents/skills/beta/SKILL.md', 'child', {}, 'child')
  read('.agents/skills/beta/SKILL.md', 'control', { source: 'user_shell' })
  read('/other/SKILL.md')
  read('.agents/skills/alpha/references/details.md')
  assert.equal(r.collector.snapshot()!.session.counts.skills, 1)
  read('.agents/skills/beta/SKILL.md'); read('.agents/skills/beta/SKILL.md')
  assert.equal(r.collector.snapshot()!.session.counts.skills, 2)
  start('two')
  read('.agents/skills/alpha/SKILL.md', 'later', {}, 'thread-a', 'two')
  message('user', 'skills.selected_skill_instructions', injection, 'two')
  assert.equal(r.collector.snapshot()!.session.counts.skills, 3)
})

test('the Bash entry resolves an external symlink and runs from a different cwd', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus entry '))
  try {
    const install = join(dir, 'install')
    for (const name of ['src', 'bin', 'package.json']) await cp(resolve(name), join(install, name), { recursive: true })
    const link = join(dir, 'vargus')
    await symlink(join(install, 'bin/vargus'), link)
    const { stdout } = await promisify(execFile)(link, ['--help'], { cwd: dir })
    assert.match(stdout, /vargus on\|off\|status/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('mixed-thread history omits agent and skill counts across later polling retries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-mixed-history-'))
  const file = join(dir, 'history.jsonl')
  const start = (turn_id: string) => ({ type: 'event_msg', payload: { type: 'task_started', turn_id } })
  const injection = (turn_id: string) => ({ type: 'response_item', payload: {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: '<skill>\n<name>alpha</name>\n<path>/repo/alpha/SKILL.md</path>\ninstructions\n</skill>' }],
    internal_chat_message_metadata_passthrough: { turn_id, content_item_kinds: ['skills.selected_skill_instructions'] },
  } })
  const spawn = (id: string) => ({ type: 'event_msg', payload: { type: 'item_completed', thread_id: 'thread-a',
    item: { type: 'SubAgentActivity', kind: 'started', id },
  } })
  const jsonl = (records: unknown[]) => records.map(record => JSON.stringify(record) + '\n').join('')
  try {
    await writeFile(file, jsonl([meta, start('own'), injection('own'), spawn('own')]))
    const r = new RolloutReader(file, 'thread-a', '/repo', dir)
    await r.poll()
    assert.equal(r.collector.snapshot()!.session.counts.skills, 1)
    assert.equal(r.collector.snapshot()!.session.counts.agents, 1)
    await appendFile(file, jsonl([{ ...meta, payload: { ...meta.payload, id: 'parent' } }, start('copied'), injection('copied')]))
    await assert.rejects(r.poll(), /another Codex thread/)
    assert.equal(r.collector.snapshot()!.session.counts.skills, 0)
    assert.equal(r.collector.snapshot()!.session.counts.agents, 0)
    // Later appends also keep agent and skill counts omitted once counters are unattributed.
    await appendFile(file, jsonl([start('later'), injection('later'), spawn('later')]))
    await r.poll(); await r.poll()
    assert.equal(r.collector.snapshot()!.session.counts.skills, 0)
    assert.equal(r.collector.snapshot()!.session.counts.agents, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('paginated child history skips the inherited prefix but retains its skill catalog', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-child-history-'))
  const file = join(dir, 'history.jsonl')
  const childMeta = { ...meta, ordinal: 0, payload: { ...meta.payload,
    history_mode: 'paginated', subagent_history_start_ordinal: 8 } }
  const message = (role: string, kind: string, text: string) => ({ type: 'response_item', payload: {
    type: 'message', role, content: [{ type: 'input_text', text }],
    internal_chat_message_metadata_passthrough: { turn_id: 'parent-turn', content_item_kinds: [kind] },
  } })
  const rows = [childMeta,
    { ...meta, payload: { ...meta.payload, id: 'parent' } },
    { type: 'turn_context', payload: { model: 'parent-model', cwd: '/parent' } },
    count,
    message('developer', 'host_skills.instructions', '- alpha: Fixture. (file: /repo/alpha/SKILL.md)'),
    message('user', 'skills.selected_skill_instructions', '<skill>\n<name>alpha</name>\n<path>/repo/alpha/SKILL.md</path>\ninstructions\n</skill>'),
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'parent-turn' } },
    { type: 'event_msg', payload: { type: 'item_completed', thread_id: 'parent', item: { type: 'CommandExecution', id: 'parent-tool' } } },
    settings,
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'child-turn' } },
    { type: 'event_msg', payload: { type: 'item_completed', thread_id: 'thread-a', turn_id: 'child-turn',
      item: { type: 'CommandExecution', id: 'own-read', source: 'agent', cwd: '/repo',
        parsed_cmd: [{ type: 'read', path: 'alpha/SKILL.md' }], exit_code: 0, status: 'completed' } } },
    { type: 'event_msg', payload: { type: 'item_completed', thread_id: 'thread-a',
      item: { type: 'SubAgentActivity', id: 'own-spawn', kind: 'started' } } },
    count,
  ].map((record, ordinal) => ({ ...record, ordinal }))
  const jsonl = (records: unknown[]) => records.map(r => JSON.stringify(r) + '\n').join('')
  try {
    await writeFile(file, jsonl(rows.slice(0, 8)))
    const r = new RolloutReader(file, 'thread-a', '/repo', dir)
    await r.poll(); await r.poll()
    assert.equal(r.collector.snapshot()!.session.model, undefined)
    assert.deepEqual(r.collector.snapshot()!.session.counts, { tokens: 0, tools: 0, agents: 0, skills: 0 })
    await appendFile(file, jsonl(rows.slice(8)))
    await r.poll(); await r.poll()
    const v = r.collector.snapshot()!
    assert.equal(v.core.cwd, '/repo'); assert.equal(v.session.model, 'gpt-6.1-sol')
    assert.deepEqual(v.session.counts, { tokens: 3201, tools: 1, agents: 1, skills: 1 })
    const replay = new RolloutReader(file, 'thread-a', '/repo', dir)
    await replay.poll()
    assert.deepEqual(replay.collector.snapshot()!.session, v.session)
    // An ordinal-less append must not reopen attribution on the next retry.
    await appendFile(file, jsonl([count]))
    await assert.rejects(r.poll(), /valid ordinal/)
    await appendFile(file, jsonl([{ ...count, ordinal: rows.length }]))
    await assert.rejects(r.poll(), /valid ordinal/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})


test('Codex reported path selects the current session-suffixed history, not the newest filename', { skip: process.platform === 'win32' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-rollout-alias-')), priorPath = process.env.PATH
  const readDirectory = fs.promises.readdir
  let scans = 0
  const scan = t.mock.method(fs.promises, 'readdir', (...args: Parameters<typeof readDirectory>) => {
    if (args[0] === join(dir, 'sessions')) scans++
    return Reflect.apply(readDirectory, fs.promises, args)
  })
  syncBuiltinESMExports()
  try {
    await mkdir(join(dir, 'sessions')); await mkdir(join(dir, 'bin'))
    const old = join(dir, 'sessions', 'rollout-date-thread-a.jsonl')
    const current = join(dir, 'sessions', 'rollout-date-thread-a_11111111-1111-1111-1111-111111111111.jsonl')
    for (const file of [old, current]) await writeFile(file, JSON.stringify(meta) + '\n')
    await utimes(old, new Date('2030-01-01'), new Date('2030-01-01'))
    await utimes(current, new Date('2020-01-01'), new Date('2020-01-01'))
    const reported = join(dir, 'reported.json'), requests = join(dir, 'requests.jsonl'), unavailable = join(dir, 'unavailable')
    await writeFile(reported, JSON.stringify({ id: 'thread-a', path: current, ephemeral: false }))
    await writeFile(join(dir, 'bin', 'codex'), `#!${process.execPath}
const fs=require('node:fs'),r=require('node:readline').createInterface({input:process.stdin});r.on('line',l=>{const m=JSON.parse(l);if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{}}));else{fs.appendFileSync(${JSON.stringify(requests)},JSON.stringify({method:m.method,params:m.params})+'\\n');console.log(JSON.stringify({id:m.id,...(fs.existsSync(${JSON.stringify(unavailable)})?{error:{message:'metadata unavailable'}}:{result:{thread:JSON.parse(fs.readFileSync(${JSON.stringify(reported)},'utf8'))}})}));}});
`, { mode: 0o755 })
    process.env.PATH = join(dir, 'bin') + ':' + priorPath
    assert.equal(await findRollout(dir, 'thread-a'), current)
    await writeFile(reported, JSON.stringify({ id: 'thread-a', path: old, ephemeral: false }))
    assert.equal(await findRollout(dir, 'thread-a'), old, 'the API pointer can move to an older-named file too')
    const calls = (await readFile(requests, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(calls.map(c => c.method), ['thread/read', 'thread/read'])
    assert.ok(calls.every(c => c.params.includeTurns === false))
    assert.equal(scans, 0, 'successful metadata reads do not enumerate saved sessions')
    await writeFile(reported, JSON.stringify({ id: 'thread-a', path: current, ephemeral: true }))
    await assert.rejects(findRollout(dir, 'thread-a'), /Ephemeral/)
    await writeFile(current, JSON.stringify({ ...meta, payload: { ...meta.payload, id: 'thread-b' } }) + '\n')
    await writeFile(reported, JSON.stringify({ id: 'thread-a', path: current, ephemeral: false }))
    await assert.rejects(findRollout(dir, 'thread-a'), /another Codex thread/)
    await rm(current)
    await writeFile(unavailable, '')
    assert.equal(await findRollout(dir, 'thread-a'), old, 'a failed RPC still uses the single matching filename')
    assert.equal(scans, 1, 'positive control: RPC failure reaches the recursive fallback scan')
  } finally {
    scan.mock.restore()
    syncBuiltinESMExports()
    if (priorPath === undefined) delete process.env.PATH
    else process.env.PATH = priorPath
    await rm(dir, { recursive: true, force: true })
  }
})


test('saved model-specific quota metadata selects the named bucket before the general quota', () => {
  const r = new RolloutReader('/unused', 'thread-a', '/repo', '/home/user')
  r.observe(meta); r.observe(settings); r.observe(count)
  assert.partialDeepStrictEqual(r.collector.snapshot()!.limits[0], { percent: 27.5 })
  r.observe({ type: 'event_msg', payload: { type: 'token_count', rate_limits: {
    limit_id: 'model-pool', normal_model_slug: 'gpt-6.1-sol',
    primary: { used_percent: 73, window_minutes: 300, resets_at: null },
  } } })
  assert.partialDeepStrictEqual(r.collector.snapshot()!.limits[0], { percent: 73 })
  r.observe({ ...settings, payload: { ...settings.payload, thread_settings: { ...settings.payload.thread_settings, model: 'gpt-6-luna' } } })
  assert.partialDeepStrictEqual(r.collector.snapshot()!.limits[0], { percent: 27.5 })
})

test('Codex rollout computes decode t/s from model item spans and token_usage_record', () => {
  const r = new RolloutReader('/unused', 'thread-a', '/repo', '/home/user')
  r.observe(meta)
  r.observe(settings)
  // Reasoning (400ms) + mid-step quota-only token_count (info: null) + AgentMessage (600ms) => 1000ms for 150 tokens => 150t/s
  r.observe({ type: 'event_msg', payload: { type: 'item_completed', thread_id: 'thread-a',
    item: { type: 'Reasoning', id: 'rs1' }, started_at_ms: 1000, completed_at_ms: 1400 } })
  r.observe({ type: 'response_item', payload: { type: 'reasoning', id: 'rs1' } })
  r.observe({ type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'codex' } } })
  r.observe({ type: 'event_msg', payload: { type: 'item_completed', thread_id: 'thread-a',
    item: { type: 'AgentMessage', id: 'm1' }, started_at_ms: 1400, completed_at_ms: 2000 } })
  r.observe({ type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'm1' } })
  r.observe({ type: 'token_usage_record', payload: { thread_id: 'thread-a', usage: { output_tokens: 150 } } })
  r.observe(count)
  assert.equal(r.collector.snapshot()!.session.tokensPerSecond, 150)

  // Incoming inter-agent mailbox message (response_item type:"agent_message") before task_complete
  // is input, not model output, and must keep both cache hit and t/s intact.
  r.observe({ type: 'response_item', payload: { type: 'agent_message', author: '/root/child', recipient: '/root',
    content: [{ type: 'input_text', text: 'FINAL_ANSWER' }] } })
  r.observe({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } })
  assert.equal(r.collector.snapshot()!.session.tokensPerSecond, 150)
  assert.notEqual(r.collector.snapshot()!.session.cacheHitPercent, undefined)

  // Reasoning (400ms) + trailing client function_call (+300ms) => 700ms for 140 tokens => 200t/s
  r.observe({ type: 'event_msg', payload: { type: 'item_completed', thread_id: 'thread-a',
    item: { type: 'Reasoning', id: 'rs2' }, started_at_ms: 5000, completed_at_ms: 5400 } })
  r.observe({ type: 'response_item', payload: { type: 'reasoning', id: 'rs2' } })
  r.observe({ type: 'response_item', timestamp: new Date(5700).toISOString(),
    payload: { type: 'function_call', name: 'exec_command', call_id: 'c1' } })
  r.observe({ type: 'token_usage_record', payload: { thread_id: 'thread-a', usage: { output_tokens: 140 } } })
  assert.equal(r.collector.snapshot()!.session.tokensPerSecond, 200)
  r.observe({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1' } })

  // Pure function_call-only step (no started_at_ms) and 0ms burst preserve prior rate.
  r.observe({ type: 'response_item', timestamp: new Date(7000).toISOString(),
    payload: { type: 'function_call', name: 'exec_command', call_id: 'c2' } })
  r.observe({ type: 'token_usage_record', payload: { thread_id: 'thread-a', usage: { output_tokens: 30 } } })
  assert.equal(r.collector.snapshot()!.session.tokensPerSecond, 200)
  r.observe({ type: 'event_msg', payload: { type: 'item_completed', thread_id: 'thread-a',
    item: { type: 'AgentMessage', id: 'burst' }, started_at_ms: 8000, completed_at_ms: 8000 } })
  r.observe({ type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'burst' } })
  r.observe({ type: 'token_usage_record', payload: { thread_id: 'thread-a', usage: { output_tokens: 80 } } })
  assert.equal(r.collector.snapshot()!.session.tokensPerSecond, 200)
  r.observe(count)
  assert.equal(r.collector.snapshot()!.session.tokensPerSecond, 200)

  // Missing usage (new model output followed by stale repeated token_count) clears rate.
  r.observe({ type: 'event_msg', payload: { type: 'item_completed', thread_id: 'thread-a',
    item: { type: 'AgentMessage', id: 'nousage' }, started_at_ms: 9000, completed_at_ms: 9600 } })
  r.observe({ type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'nousage' } })
  r.observe(count)
  assert.equal(r.collector.snapshot()!.session.tokensPerSecond, undefined)

  // Fallback without token_usage_record across function_call_output -> token_count.
  r.observe({ type: 'event_msg', payload: { type: 'item_completed', thread_id: 'thread-a',
    item: { type: 'Reasoning', id: 'rs3' }, started_at_ms: 10_000, completed_at_ms: 10_600 } })
  r.observe({ type: 'response_item', payload: { type: 'reasoning', id: 'rs3' } })
  r.observe({ type: 'response_item', timestamp: new Date(11_000).toISOString(),
    payload: { type: 'function_call', name: 'exec_command', call_id: 'c3' } })
  r.observe({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c3' } })
  const nextTotal = { input_tokens: 50000, cached_input_tokens: 45000, output_tokens: 877, total_tokens: 50877 }
  const nextLast = { input_tokens: 7576, cached_input_tokens: 5000, output_tokens: 100, total_tokens: 7676 }
  r.observe({ type: 'event_msg', payload: { type: 'token_count', info: {
    total_token_usage: nextTotal, last_token_usage: nextLast, model_context_window: 190000,
  } } })
  assert.equal(r.collector.snapshot()!.session.tokensPerSecond, 100)

  // Abandoned fallback duration from a step missing both token_usage_record and token_count
  // must not leak into a subsequent pure function_call step's token_count.
  r.observe({ type: 'event_msg', payload: { type: 'item_completed', thread_id: 'thread-a',
    item: { type: 'Reasoning', id: 'rs-abandoned' }, started_at_ms: 11_100, completed_at_ms: 11_700 } })
  r.observe({ type: 'response_item', payload: { type: 'reasoning', id: 'rs-abandoned' } })
  r.observe({ type: 'response_item', timestamp: new Date(11_900).toISOString(),
    payload: { type: 'function_call', name: 'exec_command', call_id: 'c-abandoned' } })
  r.observe({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c-abandoned' } })
  r.observe({ type: 'response_item', timestamp: new Date(12_000).toISOString(),
    payload: { type: 'function_call', name: 'exec_command', call_id: 'c-next' } })
  r.observe({ type: 'event_msg', payload: { type: 'token_count', info: {
    total_token_usage: { ...nextTotal, output_tokens: 977, total_tokens: 50977 },
    last_token_usage: { ...nextLast, output_tokens: 100 },
    model_context_window: 190000,
  } } })
  assert.equal(r.collector.snapshot()!.session.tokensPerSecond, 100)

  // Quota-only update keeps the rate; task_complete after usage-less output clears it.
  r.observe({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { limit_id: 'codex' } } })
  assert.equal(r.collector.snapshot()!.session.tokensPerSecond, 100)
  r.observe({ type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'no-tc' } })
  r.observe({ type: 'token_usage_record', payload: { thread_id: 'thread-a', usage: { output_tokens: 0 } } })
  r.observe({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 't2' } })
  assert.equal(r.collector.snapshot()!.session.tokensPerSecond, undefined)

  // Compaction, model switch, and Fast toggle (including undefined -> priority) each clear rate.
  const recordRate = (id: string, startMs: number) => {
    r.observe({ type: 'event_msg', payload: { type: 'item_completed', thread_id: 'thread-a',
      item: { type: 'Plan', id }, started_at_ms: startMs, completed_at_ms: startMs + 1000 } })
    r.observe({ type: 'response_item', payload: { type: 'message', role: 'assistant', id } })
    r.observe({ type: 'token_usage_record', payload: { thread_id: 'thread-a', usage: { output_tokens: 100 } } })
    assert.equal(r.collector.snapshot()!.session.tokensPerSecond, 100)
  }
  recordRate('p1', 12_000)
  r.observe({ type: 'compacted', payload: {} })
  assert.equal(r.collector.snapshot()!.session.tokensPerSecond, undefined)

  recordRate('p2', 14_000)
  r.observe({ type: 'turn_context', payload: { model: 'gpt-6-luna', cwd: '/repo', effort: 'high' } })
  assert.equal(r.collector.snapshot()!.session.tokensPerSecond, undefined)
  assert.equal(r.collector.snapshot()!.session.fast, undefined)

  recordRate('p3', 16_000)
  r.observe({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: 'thread-a',
    thread_settings: { model: 'gpt-6-luna', cwd: '/repo', service_tier: 'priority' } } })
  assert.equal(r.collector.snapshot()!.session.tokensPerSecond, undefined)

  recordRate('p4', 18_000)
  r.observe({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: 'thread-a',
    thread_settings: { model: 'gpt-6-luna', cwd: '/repo', service_tier: 'default' } } })
  assert.equal(r.collector.snapshot()!.session.tokensPerSecond, undefined)
})

test('RolloutReader.attributable gates clean, paginated, mixed and replaced-then-regrown transcripts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-attributable-'))
  const jsonl = (records: unknown[]) => records.map(r => JSON.stringify(r) + '\n').join('')
  try {
    // 1. Clean transcript: false before session_meta, true after, then latches false if replaced even after regrowing.
    const cleanFile = join(dir, 'clean.jsonl')
    await writeFile(cleanFile, '')
    const clean = new RolloutReader(cleanFile, 'thread-a', '/repo', dir)
    assert.equal(clean.attributable, false)
    await clean.poll(false)
    assert.equal(clean.attributable, false)
    await writeFile(cleanFile, jsonl([meta, count]))
    await clean.poll(false)
    assert.equal(clean.attributable, true)
    assert.equal(clean.collector.snapshot()!.session.counts.tokens, 3201)
    // Shrink file to trigger replacement detection, then regrow beyond previous offset.
    await writeFile(cleanFile, '')
    await assert.rejects(clean.poll(false), /replaced/)
    assert.equal(clean.attributable, false)
    await writeFile(cleanFile, jsonl([meta, count, count, count]))
    await assert.rejects(clean.poll(false), /replaced/, 'replaced-file error must stay latched after later growth')
    assert.equal(clean.attributable, false)

    // 2. Paginated forked child stays attributable until an ordinal-less record arrives.
    const paginatedFile = join(dir, 'paginated.jsonl')
    const childMeta = { ...meta, ordinal: 0, payload: { ...meta.payload,
      history_mode: 'paginated', subagent_history_start_ordinal: 2 } }
    await writeFile(paginatedFile, jsonl([
      childMeta,
      { ...meta, ordinal: 1, payload: { ...meta.payload, id: 'parent' } },
      { ...count, ordinal: 2 },
    ]))
    const paginated = new RolloutReader(paginatedFile, 'thread-a', '/repo', dir)
    await paginated.poll(false)
    assert.equal(paginated.attributable, true)
    assert.equal(paginated.collector.snapshot()!.session.counts.tokens, 3201)
    await appendFile(paginatedFile, jsonl([count]))
    await assert.rejects(paginated.poll(false), /valid ordinal/)
    assert.equal(paginated.attributable, false)

    // 3. Non-paginated mixed child flips attributable to false and stays false after clean appends.
    const mixedFile = join(dir, 'mixed.jsonl')
    await writeFile(mixedFile, jsonl([meta, { ...meta, payload: { ...meta.payload, id: 'parent' } }]))
    const mixed = new RolloutReader(mixedFile, 'thread-a', '/repo', dir)
    await assert.rejects(mixed.poll(false), /another Codex thread/)
    assert.equal(mixed.attributable, false)
    await appendFile(mixedFile, jsonl([count]))
    await mixed.poll(false)
    assert.equal(mixed.attributable, false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('RolloutReader.poll(false) skips modelDefault lookups and poll(true) resolves them on unchanged file size', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-poll-default-'))
  try {
    const file = join(dir, 'rollout.jsonl')
    const first = { ...meta, payload: { ...meta.payload, model_provider: 'openai' } }
    await writeFile(file, [first, settings].map(record => JSON.stringify(record) + '\n').join(''))
    let lookups = 0
    const modelDefault = async (model: string, cwd: string) => {
      lookups++
      assert.equal(model, 'gpt-6.1-sol')
      assert.equal(cwd, '/repo')
      return 'high'
    }
    const reader = new RolloutReader(file, 'thread-a', '/repo', dir, modelDefault)
    await reader.poll(false)
    assert.equal(lookups, 0)
    assert.equal(reader.collector.snapshot()!.session.defaultEffort, undefined)
    await reader.poll(false)
    assert.equal(lookups, 0)
    // Promoting the reader to active view resolves defaultEffort even when file size has not changed.
    await reader.poll(true)
    assert.equal(lookups, 1)
    assert.equal(reader.collector.snapshot()!.session.defaultEffort, 'high')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('corrupt or malformed JSONL records latch a permanent history error and drop attribution', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-rollout-corrupt-'))
  const jsonl = (records: unknown[]) => records.map(r => JSON.stringify(r) + '\n').join('')
  const nextCount = {
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 50000, cached_input_tokens: 40000, output_tokens: 1000, total_tokens: 51000 },
        last_token_usage: { input_tokens: 50000, cached_input_tokens: 40000, output_tokens: 1000, total_tokens: 51000 },
        model_context_window: 190000,
      },
    },
  }
  try {
    // 1. Mid-chunk corrupt JSON followed by trailing valid record stays latched across same-size and appended polls.
    const brokenFile = join(dir, 'broken.jsonl')
    await writeFile(brokenFile, jsonl([meta, count]) + '{broken\n' + jsonl([nextCount]))
    const broken = new RolloutReader(brokenFile, 'thread-a', '/repo', dir)
    await assert.rejects(broken.poll(false), /invalid JSON/)
    assert.equal(broken.attributable, false)
    await assert.rejects(broken.poll(false), /invalid JSON/, 'unchanged file size must stay latched')
    assert.equal(broken.attributable, false)
    await appendFile(brokenFile, jsonl([nextCount]))
    await assert.rejects(broken.poll(false), /invalid JSON/, 'later appends must stay latched')
    assert.throws(() => broken.observe(count), /invalid JSON/)

    // 2. Non-object JSONL values and typeless JSON objects latch invalid record error.
    for (const [name, badLine] of [
      ['null', 'null\n'],
      ['array', '[]\n'],
      ['number', '42\n'],
      ['string', '"oops"\n'],
      ['boolean', 'true\n'],
      ['empty-object', '{}\n'],
      ['missing-type', '{"foo":1}\n'],
      ['non-string-type', '{"type":123}\n'],
      ['empty-type', '{"type":""}\n'],
    ] as const) {
      const file = join(dir, `${name}.jsonl`)
      await writeFile(file, jsonl([meta, count]) + badLine + jsonl([nextCount]))
      const reader = new RolloutReader(file, 'thread-a', '/repo', dir)
      await assert.rejects(reader.poll(false), /invalid record/)
      assert.equal(reader.attributable, false)
      await assert.rejects(reader.poll(false), /invalid record/)
      assert.equal(reader.attributable, false)
    }

    // 3. Structurally malformed record throwing inside observe() latches invalid record error
    //    via both poll() and direct observe(), including after a prior foreign session_meta.
    const malformedFile = join(dir, 'malformed.jsonl')
    await writeFile(malformedFile, jsonl([meta, count, { type: 'event_msg' }, nextCount]))
    const malformed = new RolloutReader(malformedFile, 'thread-a', '/repo', dir)
    await assert.rejects(malformed.poll(false), /invalid record/)
    assert.equal(malformed.attributable, false)
    await assert.rejects(malformed.poll(false), /invalid record/)

    const direct = new RolloutReader('/unused', 'thread-a', '/repo', dir)
    direct.observe(meta)
    assert.equal(direct.attributable, true)
    assert.throws(() => direct.observe({ type: 'event_msg' } as any), /invalid record/)
    assert.equal(direct.attributable, false)
    assert.throws(() => direct.observe(count), /invalid record/)

    const mixedThenMalformed = join(dir, 'mixed-malformed.jsonl')
    await writeFile(mixedThenMalformed, jsonl([
      meta,
      { ...meta, payload: { ...meta.payload, id: 'parent' } },
      { type: 'event_msg' },
      nextCount,
    ]))
    const reader = new RolloutReader(mixedThenMalformed, 'thread-a', '/repo', dir)
    await assert.rejects(reader.poll(false), /another Codex thread/)
    assert.equal(reader.attributable, false)
    // Next poll on unchanged size drains buffered records and hits the malformed record.
    await assert.rejects(reader.poll(false), /invalid record/)
    await assert.rejects(reader.poll(false), /invalid record/)

    // 4. Valid Codex records with non-local or malformed file:// URLs in skill/read paths must not falsely latch.
    const urlFile = join(dir, 'urls.jsonl')
    await writeFile(urlFile, jsonl([
      meta,
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'u1' } },
      { type: 'response_item', payload: {
        type: 'message', role: 'developer',
        content: [{ type: 'input_text', text: '- remote: Fixture. (file: file://example.com/SKILL.md)\n- bad: Fixture. (file: file://%ZZ/SKILL.md)' }],
        internal_chat_message_metadata_passthrough: { turn_id: 'u1', content_item_kinds: ['host_skills.instructions'] },
      } },
      { type: 'response_item', payload: {
        type: 'message', role: 'user',
        content: [{ type: 'input_text', text: '<skill>\n<name>remote</name>\n<path>file://example.com/SKILL.md</path>\nbody\n</skill>' }],
        internal_chat_message_metadata_passthrough: { turn_id: 'u1', content_item_kinds: ['skills.selected_skill_instructions'] },
      } },
      { type: 'event_msg', payload: {
        type: 'item_completed', thread_id: 'thread-a', turn_id: 'u1',
        item: {
          id: 'cmd-url', type: 'CommandExecution', source: 'agent',
          cwd: 'file://example.com/repo',
          parsed_cmd: [
            { type: 'read', path: 'file://example.com/foo' },
            { type: 'read', path: 'file://%ZZ' },
            { type: 'read', path: 'alpha/SKILL.md' },
          ],
          status: 'completed', exit_code: 0,
        },
      } },
      count,
    ]))
    const urlReader = new RolloutReader(urlFile, 'thread-a', '/repo', dir)
    await urlReader.poll(false)
    assert.equal(urlReader.attributable, true)
    assert.equal(urlReader.collector.snapshot()!.session.counts.tokens, 3201)
    assert.equal(urlReader.collector.snapshot()!.session.counts.tools, 1)
    assert.equal(urlReader.collector.snapshot()!.session.counts.skills, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('buffered complete records after foreign session_meta drain on unchanged size and across 64 KiB UTF-8 splits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-rollout-drain-'))
  const jsonl = (records: unknown[]) => records.map(r => JSON.stringify(r) + '\n').join('')
  try {
    // 1. Same-chunk trailing record after foreign session_meta drains on poll 2 without file growth,
    //    and blank CRLF lines are ignored cleanly.
    const file = join(dir, 'same-size.jsonl')
    await writeFile(file, jsonl([meta]) + '\r\n' + jsonl([{ ...meta, payload: { ...meta.payload, id: 'parent' } }, count]))
    const reader = new RolloutReader(file, 'thread-a', '/repo', dir)
    await assert.rejects(reader.poll(false), /another Codex thread/)
    assert.equal(reader.attributable, false)
    assert.equal(reader.collector.snapshot()!.session.counts.tokens, 0)
    await reader.poll(false)
    assert.equal(reader.attributable, false)
    assert.equal(reader.collector.snapshot()!.session.counts.tokens, 3201)

    // 2. Multi-chunk (>64 KiB) read with foreign session_meta in chunk 1 and a split UTF-8 record across 64 KiB.
    const chunkedFile = join(dir, 'chunked.jsonl')
    const prefix = jsonl([meta, { ...meta, payload: { ...meta.payload, id: 'parent' } }])
    const tailRecord = JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6.1-sol', cwd: '/repo/中文', effort: 'low' } }) + '\n'
    const utf8ByteOffset = Buffer.from(tailRecord).indexOf(Buffer.from('中文')) + 1
    const fillerBase = JSON.stringify({ type: 'note', payload: { pad: '' } }) + '\n'
    const padNeeded = 65536 - Buffer.byteLength(prefix) - Buffer.byteLength(fillerBase) - utf8ByteOffset
    assert.ok(padNeeded > 0)
    const filler = JSON.stringify({ type: 'note', payload: { pad: 'x'.repeat(padNeeded) } }) + '\n'
    await writeFile(chunkedFile, prefix + filler + tailRecord + jsonl([count]))
    const chunked = new RolloutReader(chunkedFile, 'thread-a', '/repo', dir)
    await assert.rejects(chunked.poll(false), /another Codex thread/)
    assert.equal(chunked.attributable, false)
    await chunked.poll(false)
    assert.equal(chunked.attributable, false)
    assert.equal(chunked.collector.snapshot()!.core.cwd, '/repo/中文')
    assert.equal(chunked.collector.snapshot()!.session.counts.tokens, 3201)

    // 3. File replacement (size < offset) while records are buffered in pending must latch /replaced/
    //    without draining stale buffered records, and stay latched even after the file regrows.
    const replacedBuffered = join(dir, 'replaced-buffered.jsonl')
    await writeFile(replacedBuffered, jsonl([meta, { ...meta, payload: { ...meta.payload, id: 'parent' } }, count]))
    const rb = new RolloutReader(replacedBuffered, 'thread-a', '/repo', dir)
    await assert.rejects(rb.poll(false), /another Codex thread/)
    assert.equal(rb.collector.snapshot()!.session.counts.tokens, 0)
    await writeFile(replacedBuffered, '')
    await assert.rejects(rb.poll(false), /replaced/)
    assert.equal(rb.attributable, false)
    assert.equal(rb.collector.snapshot()!.session.counts.tokens, 0, 'buffered records must not drain after replacement')
    await writeFile(replacedBuffered, jsonl([meta, count, count, count]))
    await assert.rejects(rb.poll(false), /replaced/, 'replaced error must remain latched after regrowth')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('RolloutReader replays .jsonl.zst with stat caching, paginated boundaries and latched corruption', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-rollout-zst-'))
  const sessions = join(dir, 'sessions')
  await mkdir(sessions)
  const jsonl = (records: unknown[]) => records.map(r => JSON.stringify(r) + '\n').join('')
  const origZstd = zlib.createZstdDecompress
  let decompressCalls = 0
  const spy = t.mock.method(zlib, 'createZstdDecompress', (...args: Parameters<typeof origZstd>) => {
    decompressCalls++
    return Reflect.apply(origZstd, zlib, args)
  })
  syncBuiltinESMExports()
  try {
    // 1. Clean compressed transcript with UTF-8, stat-cached across repeated polls, and modelDefault on promotion.
    const cleanZst = join(sessions, 'rollout-date-thread-a.jsonl.zst')
    const first = { ...meta, payload: { ...meta.payload, model_provider: 'openai' } }
    const utf8Ctx = { type: 'turn_context', payload: { model: 'gpt-6.1-sol', cwd: '/repo/中文', effort: 'low' } }
    await writeFile(cleanZst, zlib.zstdCompressSync(Buffer.from(jsonl([first, utf8Ctx, count]))))
    assert.equal(await savedTranscript(dir, 'thread-a', cleanZst), await realpath(cleanZst))
    assert.equal(await findRollout(dir, 'thread-a'), await realpath(cleanZst))

    let defaultLookups = 0
    const reader = new RolloutReader(cleanZst, 'thread-a', '/repo', dir, async () => { defaultLookups++; return 'high' })
    const beforePoll = decompressCalls
    await reader.poll(false)
    assert.equal(decompressCalls, beforePoll + 1)
    assert.equal(defaultLookups, 0)
    assert.equal(reader.attributable, true)
    assert.equal(reader.collector.snapshot()!.core.cwd, '/repo/中文')
    assert.equal(reader.collector.snapshot()!.session.counts.tokens, 3201)

    // Repeated unchanged polls do zero decompression; promoting to active view resolves modelDefault from cache.
    await reader.poll(false)
    await reader.poll(true)
    assert.equal(decompressCalls, beforePoll + 1, 'unchanged .jsonl.zst must not re-decompress')
    assert.equal(defaultLookups, 1)
    assert.equal(reader.collector.snapshot()!.session.defaultEffort, 'high')

    // Replacing a previously replayed .jsonl.zst latches a replacement error.
    await writeFile(cleanZst, zlib.zstdCompressSync(Buffer.from(jsonl([first, count, count]))))
    await assert.rejects(reader.poll(false), /replaced/)
    assert.equal(reader.attributable, false)
    await assert.rejects(reader.poll(false), /replaced/)

    // 2. Paginated compressed child preserves subagent_history_start_ordinal and inherited skill catalog.
    const paginatedZst = join(sessions, 'rollout-paginated.jsonl.zst')
    const childMeta = { ...meta, ordinal: 0, payload: { ...meta.payload,
      history_mode: 'paginated', subagent_history_start_ordinal: 4 } }
    const paginatedRows = [
      childMeta,
      { ...meta, ordinal: 1, payload: { ...meta.payload, id: 'parent' } },
      { ...count, ordinal: 2 },
      { type: 'response_item', ordinal: 3, payload: {
        type: 'message', role: 'developer',
        content: [{ type: 'input_text', text: '- alpha: Fixture. (file: /repo/alpha/SKILL.md)' }],
        internal_chat_message_metadata_passthrough: { turn_id: 'p1', content_item_kinds: ['host_skills.instructions'] },
      } },
      { ...count, ordinal: 4 },
      { type: 'event_msg', ordinal: 5, payload: { type: 'task_started', turn_id: 'c1' } },
      { type: 'event_msg', ordinal: 6, payload: { type: 'item_completed', thread_id: 'thread-a', turn_id: 'c1',
        item: { id: 'own-read', type: 'CommandExecution', source: 'agent', cwd: '/repo',
          parsed_cmd: [{ type: 'read', path: 'alpha/SKILL.md' }], exit_code: 0, status: 'completed' } } },
    ]
    await writeFile(paginatedZst, zlib.zstdCompressSync(Buffer.from(jsonl(paginatedRows))))
    const paginated = new RolloutReader(paginatedZst, 'thread-a', '/repo', dir)
    await paginated.poll(false)
    assert.equal(paginated.attributable, true)
    assert.deepEqual(paginated.collector.snapshot()!.session.counts, { tokens: 3201, tools: 1, agents: 0, skills: 1 })

    // 3. Corrupt framing (garbage, single-block, multi-block >128 KiB, multi-frame, checksum-truncated,
    //    trailing garbage), corrupted compressed payload and corrupt JSON all latch and drop attribution.
    const garbageZst = join(sessions, 'rollout-garbage.jsonl.zst')
    await writeFile(garbageZst, Buffer.from('not zstd bytes\n'))
    const garbage = new RolloutReader(garbageZst, 'thread-a', '/repo', dir)
    const callsBeforeGarbage = decompressCalls
    await assert.rejects(garbage.poll(false), /decompressed/)
    assert.equal(garbage.attributable, false)
    await assert.rejects(garbage.poll(false), /decompressed/)
    assert.equal(decompressCalls, callsBeforeGarbage, 'invalid zstd framing is rejected before allocating a decompressor')

    // Valid frame header with corrupted checksum hits ZSTD_error_checksum_wrong inside createZstdDecompress and latches.
    const checksumValid = zlib.zstdCompressSync(Buffer.from(jsonl([meta, count])), {
      params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
    })
    const badChecksum = Buffer.from(checksumValid)
    badChecksum[badChecksum.length - 1]! ^= 0xff
    const corruptPayloadZst = join(sessions, 'rollout-corrupt-payload.jsonl.zst')
    await writeFile(corruptPayloadZst, badChecksum)
    const corruptPayload = new RolloutReader(corruptPayloadZst, 'thread-a', '/repo', dir)
    const callsBeforeCorrupt = decompressCalls
    await assert.rejects(corruptPayload.poll(false), /decompressed/)
    assert.equal(corruptPayload.attributable, false)
    await assert.rejects(corruptPayload.poll(false), /decompressed/)
    assert.equal(decompressCalls, callsBeforeCorrupt + 1, 'latched zstd payload error must not re-decompress')

    const fullCompressed = zlib.zstdCompressSync(Buffer.from(jsonl([meta, count])))
    const multiBlockPrefix = jsonl([meta, count])
    const padLen = 131072 - Buffer.byteLength(multiBlockPrefix) - Buffer.byteLength('{"type":"note","payload":{"p":""}}\n')
    const multiBlockJsonl = multiBlockPrefix
      + JSON.stringify({ type: 'note', payload: { p: 'x'.repeat(padLen) } }) + '\n'
      + Array.from({ length: 1200 }, (_, i) => JSON.stringify({ type: 'note', payload: { i, v: Math.cos(i * 777).toString(36) } }) + '\n').join('')
      + jsonl([count])
    const multiBlockCompressed = zlib.zstdCompressSync(Buffer.from(multiBlockJsonl))
    const frame2 = zlib.zstdCompressSync(Buffer.from(jsonl([count])))
    const checksumCompressed = zlib.zstdCompressSync(Buffer.from(jsonl([meta, count])), {
      params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
    })

    for (const [label, bytes] of [
      ['single-truncated', fullCompressed.subarray(0, Math.floor(fullCompressed.length / 2))],
      ['multiblock-truncated', multiBlockCompressed.subarray(0, multiBlockCompressed.length - 1)],
      ['multiframe-truncated', Buffer.concat([fullCompressed, frame2.subarray(0, Math.floor(frame2.length / 2))])],
      ['checksum-truncated', checksumCompressed.subarray(0, checksumCompressed.length - 1)],
      ['trailing-garbage', Buffer.concat([fullCompressed, Buffer.from('TRAILING_GARBAGE')])],
    ] as const) {
      const f = join(sessions, `rollout-${label}.jsonl.zst`)
      await writeFile(f, bytes)
      const r = new RolloutReader(f, 'thread-a', '/repo', dir)
      await assert.rejects(r.poll(false), /decompressed/, label)
      assert.equal(r.attributable, false, label)
    }

    const badJsonZst = join(sessions, 'rollout-badjson.jsonl.zst')
    await writeFile(badJsonZst, zlib.zstdCompressSync(Buffer.from(jsonl([meta]) + '{broken\n')))
    const badJson = new RolloutReader(badJsonZst, 'thread-a', '/repo', dir)
    await assert.rejects(badJson.poll(false), /invalid JSON/)
    assert.equal(badJson.attributable, false)

    // 4. Non-paginated mixed history inside .jsonl.zst drops attribution, preserves remaining viewed records
    //    for poll 2 (matching plain JSONL), avoids re-decompressing unchanged file, and latches trailing errors/replacement.
    const mixedBytes = Buffer.from(jsonl([meta, { ...meta, payload: { ...meta.payload, id: 'parent' } }, count]))
    const mixedPlain = join(sessions, 'rollout-mixed.jsonl')
    const mixedZst = join(sessions, 'rollout-mixed.jsonl.zst')
    await writeFile(mixedPlain, mixedBytes)
    await writeFile(mixedZst, zlib.zstdCompressSync(mixedBytes))
    const mixedOpts = resolveCodexOptions({ session: false, repo: false, branch: false, status: false })
    const mixedTheme = makeTheme('graphite', true)

    const plainMixed = new RolloutReader(mixedPlain, 'thread-a', '/repo', dir)
    await assert.rejects(plainMixed.poll(false), /another Codex thread/)
    assert.equal(plainMixed.attributable, false)
    assert.equal(plainMixed.collector.snapshot()!.session.counts.tokens, 0)
    await plainMixed.poll(false)
    assert.equal(plainMixed.attributable, false)
    assert.equal(plainMixed.collector.snapshot()!.session.counts.tokens, 3201)
    assert.match(await codexLine(plainMixed.collector, mixedOpts, mixedTheme)(200), /token:3\.2k\(94\.3%\)/)

    const mixed = new RolloutReader(mixedZst, 'thread-a', '/repo', dir)
    const callsBeforeMixed = decompressCalls
    await assert.rejects(mixed.poll(false), /another Codex thread/)
    assert.equal(mixed.attributable, false)
    assert.equal(mixed.collector.snapshot()!.session.counts.tokens, 0)
    await mixed.poll(false)
    assert.equal(mixed.attributable, false)
    assert.equal(mixed.collector.snapshot()!.session.counts.tokens, 3201)
    assert.match(await codexLine(mixed.collector, mixedOpts, mixedTheme)(200), /token:3\.2k\(94\.3%\)/)
    await mixed.poll(false)
    assert.equal(decompressCalls, callsBeforeMixed + 1, 'unchanged mixed .jsonl.zst must not re-decompress')

    // Multi-frame mixed .jsonl.zst with split UTF-8 and no trailing newline drains all remaining records on poll 2.
    const mixedUtf8Tail = Buffer.from(jsonl([utf8Ctx]))
    const mixedUtf8Split = mixedUtf8Tail.indexOf(Buffer.from('中文')) + 1
    const mixedNoTrailingNl = Buffer.from(JSON.stringify(count))
    const mixedMultiFrameZst = join(sessions, 'rollout-mixed-multiframe.jsonl.zst')
    await writeFile(mixedMultiFrameZst, Buffer.concat([
      zlib.zstdCompressSync(Buffer.concat([
        Buffer.from(jsonl([meta, { ...meta, payload: { ...meta.payload, id: 'parent' } }])),
        mixedUtf8Tail.subarray(0, mixedUtf8Split),
      ])),
      zlib.zstdCompressSync(Buffer.concat([mixedUtf8Tail.subarray(mixedUtf8Split), mixedNoTrailingNl])),
    ]))
    const mixedMf = new RolloutReader(mixedMultiFrameZst, 'thread-a', '/repo', dir)
    const callsBeforeMixedMf = decompressCalls
    await assert.rejects(mixedMf.poll(false), /another Codex thread/)
    assert.equal(mixedMf.attributable, false)
    assert.equal(mixedMf.collector.snapshot()!.session.counts.tokens, 0)
    await mixedMf.poll(false)
    assert.equal(mixedMf.attributable, false)
    assert.equal(mixedMf.collector.snapshot()!.core.cwd, '/repo/中文')
    assert.equal(mixedMf.collector.snapshot()!.session.counts.tokens, 3201)
    assert.equal(decompressCalls, callsBeforeMixedMf + 2, 'multi-frame mixed .jsonl.zst must not re-decompress on poll 2')

    // Trailing invalid JSON after foreign session_meta inside .jsonl.zst latches on poll 2 without re-decompressing.
    const mixedCorruptZst = join(sessions, 'rollout-mixed-corrupt.jsonl.zst')
    await writeFile(mixedCorruptZst, zlib.zstdCompressSync(Buffer.from(
      jsonl([meta, { ...meta, payload: { ...meta.payload, id: 'parent' } }]) + '{broken\n' + jsonl([count]),
    )))
    const mixedCorrupt = new RolloutReader(mixedCorruptZst, 'thread-a', '/repo', dir)
    const callsBeforeMixedCorrupt = decompressCalls
    await assert.rejects(mixedCorrupt.poll(false), /another Codex thread/)
    await assert.rejects(mixedCorrupt.poll(false), /invalid JSON/)
    await assert.rejects(mixedCorrupt.poll(false), /invalid JSON/)
    assert.equal(mixedCorrupt.attributable, false)
    assert.equal(decompressCalls, callsBeforeMixedCorrupt + 1)

    // Replacing a mixed .jsonl.zst before poll 2 latches /replaced/ without draining buffered records.
    const mixedReplacedZst = join(sessions, 'rollout-mixed-replaced.jsonl.zst')
    await writeFile(mixedReplacedZst, zlib.zstdCompressSync(mixedBytes))
    const mixedReplaced = new RolloutReader(mixedReplacedZst, 'thread-a', '/repo', dir)
    await assert.rejects(mixedReplaced.poll(false), /another Codex thread/)
    assert.equal(mixedReplaced.collector.snapshot()!.session.counts.tokens, 0)
    await writeFile(mixedReplacedZst, zlib.zstdCompressSync(Buffer.from(jsonl([meta, count, count]))))
    await assert.rejects(mixedReplaced.poll(false), /replaced/)
    assert.equal(mixedReplaced.collector.snapshot()!.session.counts.tokens, 0)

    // Foreign session_meta in Frame 1 followed by a bad zstd checksum in Frame 2 must still latch /decompressed/
    // on poll 1 and stay latched on poll 2 without re-decompressing.
    const mixedBadFrame2 = Buffer.from(zlib.zstdCompressSync(Buffer.from(jsonl([count])), {
      params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
    }))
    mixedBadFrame2[mixedBadFrame2.length - 1]! ^= 0xff
    const mixedBadChecksumZst = join(sessions, 'rollout-mixed-bad-f2.jsonl.zst')
    await writeFile(mixedBadChecksumZst, Buffer.concat([
      zlib.zstdCompressSync(Buffer.from(jsonl([meta, { ...meta, payload: { ...meta.payload, id: 'parent' } }]))),
      mixedBadFrame2,
    ]))
    const mixedBadChecksum = new RolloutReader(mixedBadChecksumZst, 'thread-a', '/repo', dir)
    const callsBeforeMixedBadChecksum = decompressCalls
    await assert.rejects(mixedBadChecksum.poll(false), /decompressed/)
    assert.equal(mixedBadChecksum.attributable, false)
    assert.equal(mixedBadChecksum.collector.snapshot()!.session.counts.tokens, 0)
    await assert.rejects(mixedBadChecksum.poll(false), /decompressed/)
    assert.equal(decompressCalls, callsBeforeMixedBadChecksum + 2)

    // Multiple foreign session_meta lines drain across polls 2 and 3 and resolve modelDefault once drained, with 1 decompression.
    const multiForeignZst = join(sessions, 'rollout-multi-foreign.jsonl.zst')
    await writeFile(multiForeignZst, zlib.zstdCompressSync(Buffer.from(jsonl([
      first,
      { ...meta, payload: { ...meta.payload, id: 'parent-1' } },
      { ...meta, payload: { ...meta.payload, id: 'parent-2' } },
      settings,
      count,
    ]))))
    let mfDefaultLookups = 0
    const multiForeign = new RolloutReader(multiForeignZst, 'thread-a', '/repo', dir, async () => { mfDefaultLookups++; return 'high' })
    const callsBeforeMultiForeign = decompressCalls
    await assert.rejects(multiForeign.poll(true), /another Codex thread/)
    assert.equal(multiForeign.collector.snapshot()!.session.counts.tokens, 0)
    assert.equal(mfDefaultLookups, 0)
    await assert.rejects(multiForeign.poll(true), /another Codex thread/)
    assert.equal(multiForeign.collector.snapshot()!.session.counts.tokens, 0)
    assert.equal(mfDefaultLookups, 0)
    await multiForeign.poll(true)
    assert.equal(multiForeign.attributable, false)
    assert.equal(multiForeign.collector.snapshot()!.session.counts.tokens, 3201)
    assert.equal(multiForeign.collector.snapshot()!.session.defaultEffort, 'high')
    assert.equal(mfDefaultLookups, 1)
    assert.equal(decompressCalls, callsBeforeMultiForeign + 1)

    // 5. Multi-frame and skippable-frame .jsonl.zst: replays every data frame (including split UTF-8/lines),
    //    skips skippable frames, rejects corrupt Frame 2+ payloads/JSON/skippable-only, and honours RFC 8878 FHD bits.
    const skippable = (payload: string, variant = 0) => {
      const body = Buffer.from(payload)
      const header = Buffer.alloc(8)
      header.writeUInt32LE(0x184D2A50 + variant, 0)
      header.writeUInt32LE(body.length, 4)
      return Buffer.concat([header, body])
    }
    const count2 = {
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 6000, cached_input_tokens: 1000, output_tokens: 500, total_tokens: 6500 },
          last_token_usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100, total_tokens: 1100 },
          model_context_window: 200000,
        },
        rate_limits: null,
      },
    }
    const splitLineBytes = Buffer.from(jsonl([utf8Ctx]))
    const splitPoint = splitLineBytes.indexOf(Buffer.from('中文')) + 2 // mid-UTF-8 character
    const metaBytes = Buffer.from(jsonl([meta]))
    const metaSplit = Math.floor(metaBytes.length / 2)
    const multiFrameBytes = Buffer.concat([
      skippable('lead-meta', 0),
      zlib.zstdCompressSync(metaBytes.subarray(0, metaSplit)),
      zlib.zstdCompressSync(Buffer.concat([metaBytes.subarray(metaSplit), Buffer.from(jsonl([count]))])),
      zlib.zstdCompressSync(splitLineBytes.subarray(0, splitPoint)),
      skippable('mid-meta', 3),
      zlib.zstdCompressSync(Buffer.concat([splitLineBytes.subarray(splitPoint), Buffer.from(jsonl([count2]))])),
    ])
    const multiFrameZst = join(sessions, 'rollout-multiframe.jsonl.zst')
    await writeFile(multiFrameZst, multiFrameBytes)
    assert.equal(await savedTranscript(dir, 'thread-a', multiFrameZst), await realpath(multiFrameZst))
    const mfReader = new RolloutReader(multiFrameZst, 'thread-a', '/repo', dir)
    const callsBeforeMf = decompressCalls
    await mfReader.poll(false)
    assert.equal(mfReader.attributable, true)
    assert.equal(mfReader.collector.snapshot()!.core.cwd, '/repo/中文')
    assert.equal(mfReader.collector.snapshot()!.session.counts.tokens, 5500)
    assert.equal(decompressCalls, callsBeforeMf + 4)
    await mfReader.poll(false)
    assert.equal(decompressCalls, callsBeforeMf + 4, 'unchanged multi-frame .jsonl.zst must not re-decompress')

    // Frame 1 valid + Frame 2 corrupted checksum or invalid JSON must reject instead of stopping after Frame 1.
    const f2BadChecksum = Buffer.from(zlib.zstdCompressSync(Buffer.from(jsonl([count2])), {
      params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
    }))
    f2BadChecksum[f2BadChecksum.length - 1]! ^= 0xff
    const mfBadChecksumZst = join(sessions, 'rollout-mf-bad-checksum.jsonl.zst')
    await writeFile(mfBadChecksumZst, Buffer.concat([fullCompressed, f2BadChecksum]))
    const mfBadChecksum = new RolloutReader(mfBadChecksumZst, 'thread-a', '/repo', dir)
    await assert.rejects(mfBadChecksum.poll(false), /decompressed/)
    assert.equal(mfBadChecksum.attributable, false)

    const mfBadJsonZst = join(sessions, 'rollout-mf-bad-json.jsonl.zst')
    await writeFile(mfBadJsonZst, Buffer.concat([fullCompressed, zlib.zstdCompressSync(Buffer.from('{not valid json\n'))]))
    const mfBadJson = new RolloutReader(mfBadJsonZst, 'thread-a', '/repo', dir)
    await assert.rejects(mfBadJson.poll(false), /invalid JSON/)
    assert.equal(mfBadJson.attributable, false)

    const skipOnlyZst = join(sessions, 'rollout-skip-only.jsonl.zst')
    await writeFile(skipOnlyZst, skippable('only-skippable', 1))
    await assert.rejects(savedTranscript(dir, 'thread-a', skipOnlyZst), /decompressed/)
    const skipOnly = new RolloutReader(skipOnlyZst, 'thread-a', '/repo', dir)
    await assert.rejects(skipOnly.poll(false), /decompressed/)
    assert.equal(skipOnly.attributable, false)

    // RFC 8878 §3.1.1.1.1: Unused_bit (0x10) is accepted, Reserved_bit (0x08) is rejected before decompression.
    const unusedBitBytes = Buffer.from(fullCompressed)
    unusedBitBytes[4]! |= 0x10
    const unusedBitZst = join(sessions, 'rollout-unused-bit.jsonl.zst')
    await writeFile(unusedBitZst, unusedBitBytes)
    const unusedBitReader = new RolloutReader(unusedBitZst, 'thread-a', '/repo', dir)
    await unusedBitReader.poll(false)
    assert.equal(unusedBitReader.attributable, true)
    assert.equal(unusedBitReader.collector.snapshot()!.session.counts.tokens, 3201)

    const reservedBitBytes = Buffer.from(fullCompressed)
    reservedBitBytes[4]! |= 0x08
    const reservedBitZst = join(sessions, 'rollout-reserved-bit.jsonl.zst')
    await writeFile(reservedBitZst, reservedBitBytes)
    const reservedBitReader = new RolloutReader(reservedBitZst, 'thread-a', '/repo', dir)
    const callsBeforeReserved = decompressCalls
    await assert.rejects(reservedBitReader.poll(false), /decompressed/)
    assert.equal(reservedBitReader.attributable, false)
    assert.equal(decompressCalls, callsBeforeReserved)
  } finally {
    spy.mock.restore()
    syncBuiltinESMExports()
    await rm(dir, { recursive: true, force: true })
  }
})
