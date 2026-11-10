import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { RolloutReader } from '../../src/hosts/codex/rollout.ts'
import { render } from '../../src/render/index.ts'
import { DEFAULTS } from '../../src/options.ts'
import { makeTheme } from '../../src/theme/index.ts'
import { en } from '../../src/i18n/en.ts'

// Real engine settings and saved records; the localhost provider measures no speed or billing.
test('official Codex Fast settings update the saved-log model fragment without another turn', { timeout: 45000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-fast-test-'))
  const cfg = join(dir, 'codex'), project = join(dir, 'project')
  await mkdir(cfg); await mkdir(project)
  let posts = 0
  const provider = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.end('{}'); return }
    for await (const part of req) { /* consume the local request */ }
    const id = `fast_fixture_${++posts}`
    const events = [
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `msg_${id}`,
        content: [{ type: 'output_text', text: 'LOCAL FAST FIXTURE COMPLETE' }] } },
      { type: 'response.completed', response: { id, usage: { input_tokens: 1000, output_tokens: 5, total_tokens: 1005 } } },
    ]
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
    res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''))
  })
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
  const port = (provider.address() as { port: number }).port
  await writeFile(join(cfg, 'config.toml'), `model = "gpt-6.1-sol"
model_provider = "local_mock"
model_reasoning_effort = "max"
service_tier = "default"
check_for_update_on_startup = false
[features]
fast_mode = true
[model_providers.local_mock]
name = "Local Fast fixture"
base_url = "http://127.0.0.1:${port}/v1"
env_key = "VARGUS_LOCAL_TEST_KEY"
wire_api = "responses"
supports_websockets = false
requires_openai_auth = false
[projects.${JSON.stringify(project)}]
trust_level = "trusted"
`)
  const child = spawn('codex', ['app-server', '--stdio'], { cwd: project,
    env: { ...process.env, CODEX_HOME: cfg, VARGUS_LOCAL_TEST_KEY: 'local-test-only',
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' }, stdio: ['pipe', 'pipe', 'pipe'] })
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
    await rpc('initialize', { clientInfo: { name: 'vargus_fast_test', version: '0.1.0' }, capabilities: { experimentalApi: true } })
    const started = await rpc('thread/start', { cwd: project, approvalPolicy: 'never', sandbox: 'read-only' })
    const threadId = started.thread.id
    const reader = new RolloutReader(started.thread.path, threadId, project, dir)
    const turn = async () => {
      const { turn } = await rpc('turn/start', { threadId, input: [{ type: 'text', text: 'Local Fast settings fixture.' }] })
      const completed = () => events.find(m => m.method === 'turn/completed' && m.params.turn.id === turn.id)
      const until = Date.now() + 12000
      while (!completed() && Date.now() < until) await delay(50)
      assert.equal(completed()?.params.turn.status, 'completed', errors)
    }
    const row = async (expected: string) => {
      const until = Date.now() + 8000
      let text = ''
      do {
        await reader.poll()
        text = render({ v: reader.collector.snapshot()!, o: DEFAULTS, l: en, t: makeTheme('graphite', true), now: Date.now() })
        if (text.split(' | ').includes(expected)) break
        await delay(50)
      } while (Date.now() < until)
      assert.ok(text.split(' | ').includes(expected), text)
      assert.equal(reader.collector.snapshot()!.session.model, 'gpt-6.1-sol')
    }
    await turn(); await row('sol:max')
    const before = posts
    await rpc('thread/settings/update', { threadId, serviceTier: 'fast' })
    await row('sol:max(fast)')
    await rpc('thread/settings/update', { threadId, serviceTier: null })
    await row('sol:max')
    await rpc('thread/settings/update', { threadId, serviceTier: 'priority' })
    await row('sol:max(fast)')
    assert.equal(posts, before, 'settings changes must not send another provider request')
    await turn(); await row('sol:max(fast)')
    const replay = new RolloutReader(started.thread.path, threadId, project, dir)
    await replay.poll()
    assert.equal(replay.collector.snapshot()!.session.fast, true)
    await rpc('thread/settings/update', { threadId, serviceTier: 'default' })
    await row('sol:max')
  } finally {
    for (const request of pending.values()) clearTimeout(request.timer)
    lines.close()
    const exit = once(child, 'exit'); child.kill('SIGTERM')
    const kill = setTimeout(() => child.kill('SIGKILL'), 2000)
    try { await exit } finally { clearTimeout(kill) }
    provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()))
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
