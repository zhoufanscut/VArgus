import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, appendFile, rm, mkdir, symlink, readFile, utimes, cp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { RolloutReader, findRollout } from '../../src/hosts/codex/rollout.ts'
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
    const calm = theme.paint('label', 'sol:') + theme.paint('gradLow', 'low')
    const alert = theme.paint('label', 'sol:') + theme.paint('gradHigh', 'low')
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
    assert.ok((await line(200)).includes(theme.paint('gradLow', 'low')))
    await appendFile(file, context('/custom', 'high'))
    await reader.poll()
    assert.ok((await line(200)).includes(theme.paint('gradHigh', 'high')))
    await rm(catalog)
    await appendFile(file, context('/custom', 'low'))
    await reader.poll()
    assert.ok((await line(200)).includes(theme.paint('gradHigh', 'low')))
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
    // New bytes make the existing reader resume its buffered records.
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
