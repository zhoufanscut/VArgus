import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { findRollout, RolloutReader } from '../../src/hosts/codex/rollout'
import { render } from '../../src/render'
import { DEFAULTS } from '../../src/options'
import { makeTheme } from '../../src/theme'
import { en } from '../../src/i18n/en'

// Official engine and real shell reads; only the Responses provider is mocked.
// This verifies recorded signals, not a model deciding when to use a skill.
test('official Codex skill loads deduplicate injections and reads within each turn', { timeout: 45000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-skills-test-'))
  const cfg = join(dir, 'codex'), project = join(dir, 'project')
  for (const folder of [cfg, project]) await mkdir(folder)
  const skills = new Map<string, string>()
  for (const name of ['alpha', 'beta']) {
    const folder = join(project, '.agents/skills', name)
    await mkdir(folder, { recursive: true })
    const path = join(folder, 'SKILL.md'); skills.set(name, path)
    await writeFile(path, `---\nname: ${name}\ndescription: ${name} skill counter fixture.\n---\n${name} fixture instructions.\n`)
  }
  let posts = 0, commands = 0, pendingReads: string[] = [], spawnNext = false, childReads = 0
  const provider = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.end('{}'); return }
    let raw = ''; for await (const part of req) raw += String(part)
    const request = JSON.parse(raw), title = request.text?.format !== undefined
    const task = request.input?.filter((i: any) => i.type === 'agent_message').at(-1)
    const isChild = task?.recipient === '/root/counter_child'
    const wantSpawn = spawnNext && !title && !isChild
    if (wantSpawn) spawnNext = false
    const id = `response_${++posts}`, path = title || wantSpawn ? undefined : isChild
      ? childReads++ === 0 ? skills.get('beta') : undefined : pendingReads.shift()
    const item = wantSpawn ? {
      type: 'function_call', name: 'spawn_agent', namespace: 'collaboration', id: 'fc_spawn', call_id: 'call_spawn',
      arguments: JSON.stringify({ message: 'FORK_CHILD_READ_BETA fixture. Reply immediately.',
        agent_type: 'default', task_name: 'counter_child', fork_turns: 'all' }),
    } : path ? {
      type: 'function_call', name: 'exec_command', namespace: 'functions', id: `fc_${++commands}`, call_id: `call_${commands}`,
      arguments: JSON.stringify({ cmd: 'cat ' + JSON.stringify(path), workdir: project, max_output_tokens: 1000 }),
    } : { type: 'message', role: 'assistant', id: `msg_${id}`, content: [{ type: 'output_text', text: title ? JSON.stringify({ title: 'Skills fixture' }) : 'SKILL FIXTURE COMPLETE' }] }
    const events = [
      { type: 'response.created', response: { id } },
      ...(path || wantSpawn ? [
        { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
        { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments },
      ] : []),
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id, usage: { input_tokens: 2000, output_tokens: 20, total_tokens: 2020 } } },
    ]
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
    res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''))
  })
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
  const port = (provider.address() as { port: number }).port
  await writeFile(join(cfg, 'config.toml'), `model = "gpt-6.1-sol"
model_provider = "local_mock"
model_reasoning_effort = "low"
check_for_update_on_startup = false
[model_providers.local_mock]
name = "Local test"
base_url = "http://127.0.0.1:${port}/v1"
env_key = "VARGUS_LOCAL_TEST_KEY"
wire_api = "responses"
supports_websockets = false
requires_openai_auth = false
[projects.${JSON.stringify(project)}]
trust_level = "trusted"
`)
  const child = spawn('codex', ['app-server', '--stdio'], {
    cwd: project, env: { ...process.env, CODEX_HOME: cfg, VARGUS_LOCAL_TEST_KEY: 'local-test-only',
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = createInterface({ input: child.stdout })
  let errors = '', sequence = 0
  child.stderr.on('data', data => { errors = (errors + String(data)).slice(-4000) })
  const events: any[] = []
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  lines.on('line', line => {
    let message: any; try { message = JSON.parse(line) } catch { return }
    events.push(message)
    const request = pending.get(message.id)
    if (request) {
      pending.delete(message.id); clearTimeout(request.timer)
      if (message.error) request.reject(new Error(JSON.stringify(message.error)))
      else request.resolve(message.result)
    }
  })
  const rpc = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => reject(new Error(method + ' timed out: ' + errors)), 12000)
    pending.set(id, { resolve, reject, timer })
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
  })
  try {
    await rpc('initialize', { clientInfo: { name: 'vargus_skills_test', version: '0.1.0' }, capabilities: { experimentalApi: true } })
    const started = await rpc('thread/start', { cwd: project, approvalPolicy: 'never', sandbox: 'danger-full-access' })
    const thread = started.thread.id
    let reader: RolloutReader | undefined
    const counts: number[] = []
    for (const fixture of [
      { explicit: true, reads: [], count: 1 },
      { explicit: false, reads: ['alpha', 'alpha'], count: 2 },
      { explicit: true, reads: ['alpha', 'beta'], count: 4 },
    ]) {
      pendingReads = fixture.reads.map(name => skills.get(name)!)
      const from = events.length
      const input = [{ type: 'text', text: 'Run the local skill counter fixture.' }, ...(fixture.explicit ? [{ type: 'skill', name: 'alpha', path: skills.get('alpha')! }] : [])]
      const { turn } = await rpc('turn/start', { threadId: thread, input })
      const completed = () => events.slice(from).find(m => m.method === 'turn/completed' && m.params?.turn?.id === turn.id)
      const until = Date.now() + 12000
      while (!completed() && Date.now() < until) await delay(50)
      assert.equal(completed()?.params.turn.status, 'completed', errors)
      assert.deepEqual(pendingReads, [])
      reader ??= new RolloutReader(await findRollout(cfg, thread), thread, project, dir)
      do {
        await reader.poll()
        if (reader.collector.snapshot()!.session.counts.skills === fixture.count) break
        await delay(50)
      } while (Date.now() < until)
      const v = reader.collector.snapshot()!
      counts.push(v.session.counts.skills)
      assert.equal(v.session.counts.skills, fixture.count)
      const row = render({ v, o: DEFAULTS, l: en, t: makeTheme('graphite', true), now: Date.now() })
      assert.match(row, new RegExp('⚡' + fixture.count + '(?: |$)'))
      assert.match(row, /sol:low/)
      assert.doesNotMatch(row, /⚡~/)
      const before = v.session.counts.skills
      await reader.poll(); assert.equal(v.session.counts.skills, before, 'polling existing history must not add loads')
    }
    assert.equal(commands, 4)
    assert.equal(reader!.collector.snapshot()!.session.counts.tools, commands)
    const beforeReplay = posts
    const replay = new RolloutReader(await findRollout(cfg, thread), thread, project, dir)
    await replay.poll()
    assert.equal(replay.collector.snapshot()!.session.counts.skills, 4)
    assert.ok(posts > 0, 'positive control: turns reached the localhost provider')
    assert.equal(posts, beforeReplay)
    console.log('SKILL_COUNTS', JSON.stringify({ counts, commands, posts, replay: replay.collector.snapshot()!.session.counts.skills }))
    spawnNext = true
    await rpc('turn/start', { threadId: thread, input: [{ type: 'text', text: 'Spawn the fork fixture.' }] })
    const untilSpawn = Date.now() + 16000
    let childRecords: any[] = [], childFile = ''
    do {
      for (const name of await readdir(join(cfg, 'sessions'), { recursive: true })) {
        if (!name.endsWith('.jsonl')) continue
        const file = join(cfg, 'sessions', name)
        const raw = await readFile(file, 'utf8')
        const rows = raw.slice(0, raw.lastIndexOf('\n')).split('\n').filter(Boolean).map(line => JSON.parse(line))
        if (rows[0]?.payload.parent_thread_id === thread) { childRecords = rows; childFile = file }
      }
      if (childRecords.some(r => r.type === 'event_msg' && r.payload.type === 'task_complete'
        && r.ordinal >= childRecords[0].payload.subagent_history_start_ordinal)) break
      await delay(50)
    } while (Date.now() < untilSpawn)
    const childMeta = childRecords[0]?.payload
    assert.ok(childMeta?.subagent_history_start_ordinal > 0, 'engine must mark the inherited boundary')
    assert.ok(childRecords.some(r => r.type === 'session_meta' && r.payload.id === thread), 'fixture must include parent metadata')
    assert.ok(childRecords.some(r => r.type === 'event_msg' && r.payload.type === 'task_complete'
      && r.ordinal >= childMeta.subagent_history_start_ordinal), 'child must finish its own turn')
    const childReader = new RolloutReader(childFile, childMeta.id, project, dir)
    await childReader.poll(); await childReader.poll()
    const childValues = childReader.collector.snapshot()!
    assert.equal(childValues.session.model, 'gpt-6.1-sol')
    assert.deepEqual(childValues.session.counts, { tokens: 4040, tools: 1, skills: 1, agents: 0, workflows: 0 })
    await reader!.poll()
    assert.equal(reader!.collector.snapshot()!.session.counts.skills, 4)
    assert.equal(reader!.collector.snapshot()!.session.counts.agents, 1)
    console.log('FORK_CHILD_COUNTS', JSON.stringify(childValues.session.counts))
  } finally {
    for (const request of pending.values()) clearTimeout(request.timer)
    lines.close()
    const exit = once(child, 'exit'); child.kill('SIGTERM')
    const kill = setTimeout(() => child.kill('SIGKILL'), 2000)
    try { await exit } finally { clearTimeout(kill) }
    provider.closeAllConnections(); await new Promise<void>(done => provider.close(() => done()))
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
