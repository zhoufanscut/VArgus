import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, appendFile, rm, mkdir, symlink, readFile, utimes, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { RolloutReader, findRollout } from '../../src/hosts/codex/rollout.ts'

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
  assert.equal(v.session.contextPercent, 18); assert.equal(v.limits.engine[0]!.percentUsed, 27.5)
  r.observe({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: 'other',
    thread_settings: { model: 'wrong', cwd: '/wrong' } } })
  assert.equal(v.session.model, 'gpt-6.1-sol')
  r.observe({ type: 'compacted', payload: {} }); assert.equal(v.session.contextPercent, undefined)
  r.observe(count); assert.equal(v.session.contextPercent, 18)
})

test('rollout polling waits for complete UTF-8 JSONL records and selects the exact thread filename', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-rollout-'))
  try {
    await mkdir(join(dir, 'sessions'))
    const file = join(dir, 'sessions', 'rollout-date-thread-a.jsonl')
    await writeFile(file, JSON.stringify(meta) + '\n')
    await writeFile(join(dir, 'sessions', 'rollout-date-thread-b.jsonl'), 'other conversation')
    assert.equal(await findRollout(dir, 'thread-a'), file)
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
  assert.deepEqual(r.collector.snapshot()!.session.counts, { tokens: 0, tools: 0, agents: 2, skills: 0, workflows: 0 })
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
      cwd: 'file:///repo', parsed_cmd: [{ type: 'read', path }], status: 'completed', exit_code: 0, ...extra },
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

test('the Bash entry resolves an external symlink and runs from a different cwd', async () => {
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
    assert.deepEqual(r.collector.snapshot()!.session.counts, { tokens: 0, tools: 0, agents: 0, skills: 0, workflows: 0 })
    await appendFile(file, jsonl(rows.slice(8)))
    await r.poll(); await r.poll()
    const v = r.collector.snapshot()!
    assert.equal(v.core.cwd, '/repo'); assert.equal(v.session.model, 'gpt-6.1-sol')
    assert.deepEqual(v.session.counts, { tokens: 3201, tools: 1, agents: 1, skills: 1, workflows: 0 })
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


test('Codex reported path selects the current session-suffixed history, not the newest filename', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-rollout-alias-')), priorPath = process.env.PATH
  try {
    await mkdir(join(dir, 'sessions')); await mkdir(join(dir, 'bin'))
    const old = join(dir, 'sessions', 'rollout-date-thread-a.jsonl')
    const current = join(dir, 'sessions', 'rollout-date-thread-a_11111111-1111-1111-1111-111111111111.jsonl')
    for (const file of [old, current]) await writeFile(file, JSON.stringify(meta) + '\n')
    await utimes(old, new Date('2030-01-01'), new Date('2030-01-01'))
    await utimes(current, new Date('2020-01-01'), new Date('2020-01-01'))
    const reported = join(dir, 'reported.json'), requests = join(dir, 'requests.jsonl')
    await writeFile(reported, JSON.stringify({ id: 'thread-a', path: current, ephemeral: false }))
    await writeFile(join(dir, 'bin', 'codex'), `#!${process.execPath}
const fs=require('node:fs'),r=require('node:readline').createInterface({input:process.stdin});r.on('line',l=>{const m=JSON.parse(l);if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{}}));else{fs.appendFileSync(${JSON.stringify(requests)},JSON.stringify({method:m.method,params:m.params})+'\\n');console.log(JSON.stringify({id:m.id,result:{thread:JSON.parse(fs.readFileSync(${JSON.stringify(reported)},'utf8'))}}));}});
`, { mode: 0o755 })
    process.env.PATH = join(dir, 'bin') + ':' + priorPath
    assert.equal(await findRollout(dir, 'thread-a'), current)
    await writeFile(reported, JSON.stringify({ id: 'thread-a', path: old, ephemeral: false }))
    assert.equal(await findRollout(dir, 'thread-a'), old, 'the API pointer can move to an older-named file too')
    const calls = (await readFile(requests, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(calls.map(c => c.method), ['thread/read', 'thread/read'])
    assert.ok(calls.every(c => c.params.includeTurns === false))
    await writeFile(reported, JSON.stringify({ id: 'thread-a', path: current, ephemeral: true }))
    await assert.rejects(findRollout(dir, 'thread-a'), /Ephemeral/)
    await writeFile(current, JSON.stringify({ ...meta, payload: { ...meta.payload, id: 'thread-b' } }) + '\n')
    await writeFile(reported, JSON.stringify({ id: 'thread-a', path: current, ephemeral: false }))
    await assert.rejects(findRollout(dir, 'thread-a'), /another Codex thread/)
  } finally {
    if (priorPath === undefined) delete process.env.PATH
    else process.env.PATH = priorPath
    await rm(dir, { recursive: true, force: true })
  }
})


test('saved model-specific quota metadata selects the named bucket before the general quota', () => {
  const r = new RolloutReader('/unused', 'thread-a', '/repo', '/home/user')
  r.observe(meta); r.observe(settings); r.observe(count)
  assert.equal(r.collector.snapshot()!.limits.engine[0]!.percentUsed, 27.5)
  r.observe({ type: 'event_msg', payload: { type: 'token_count', rate_limits: {
    limit_id: 'model-pool', normal_model_slug: 'gpt-6.1-sol',
    primary: { used_percent: 73, window_minutes: 300, resets_at: null },
  } } })
  assert.equal(r.collector.snapshot()!.limits.engine[0]!.percentUsed, 73)
  r.observe({ ...settings, payload: { ...settings.payload, thread_settings: { ...settings.payload.thread_settings, model: 'gpt-6-luna' } } })
  assert.equal(r.collector.snapshot()!.limits.engine[0]!.percentUsed, 27.5)
})
