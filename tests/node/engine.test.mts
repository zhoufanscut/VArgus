import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

const exec = promisify(execFile)
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"

// Real TUI + engine + bridge; the Responses provider is localhost only. Title
// and user usage differ deliberately, so selecting the helper fails this test.
test('real Codex turns retain user metrics while background title generation runs', { timeout: 45000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-engine-test-'))
  const cfg = join(dir, 'codex'), project = join(dir, 'project'), temporary = join(dir, 'tmp')
  for (const folder of [cfg, project, temporary]) await mkdir(folder)
  const socket = join(dir, 'tmux')
  const tmux = async (...args: string[]) => (await exec('tmux', ['-S', socket, ...args], {
    env: { ...process.env, TMUX: '' },
  })).stdout.replace(/\n$/, '')
  let userRequests = 0, titleRequests = 0, lastRequestAt = 0
  const provider = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(200); res.end('{}'); return }
    let text = ''
    for await (const chunk of req) text += String(chunk)
    const request = JSON.parse(text) as { text?: { format?: unknown } }
    const title = request.text?.format !== undefined
    if (title) titleRequests++
    else userRequests++
    lastRequestAt = Date.now()
    const responseId = `response_${userRequests}_${titleRequests}`
    const events = [
      { type: 'response.created', response: { id: responseId } },
      { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `message_${responseId}`, content: [{ type: 'output_text',
        text: title ? JSON.stringify({ title: 'Local test' }) : `LOCAL MOCK COMPLETE ${userRequests}`,
      }] } },
      { type: 'response.completed', response: { id: responseId, usage: {
        input_tokens: title ? 777 : 42424, input_tokens_details: { cached_tokens: title ? 0 : 40000 },
        output_tokens: title ? 9 : 777, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: title ? 786 : 43201,
      } } },
    ]
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close',
      'x-codex-primary-used-percent': '27.5', 'x-codex-primary-window-minutes': '300',
      'x-codex-secondary-used-percent': '61', 'x-codex-secondary-window-minutes': '10080',
    })
    res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''))
  })
  provider.listen(0, '127.0.0.1')
  await once(provider, 'listening')
  const port = (provider.address() as { port: number }).port
  await writeFile(join(cfg, 'config.toml'), `model = "gpt-6.1-sol"
model_provider = "local_mock"
model_reasoning_effort = "low"
model_context_window = 200000
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
  const options = join(dir, 'options.json')
  await writeFile(options, JSON.stringify({ folder: false, repo: false, branch: false, status: false }))
  let pane = '', before = ''
  const stopWrapper = async () => {
    if (!pane || await tmux('display-message', '-p', '-t', pane, '#{pane_dead}') === '1') return
    const pid = Number(await tmux('display-message', '-p', '-t', pane, '#{pane_pid}'))
    process.kill(pid, 'SIGTERM')
    const until = Date.now() + 7000
    while (Date.now() < until && await tmux('display-message', '-p', '-t', pane, '#{pane_dead}') !== '1') await delay(100)
  }
  try {
    await tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'test', '-x', '157', '-y', '40', 'sleep 120')
    pane = await tmux('display-message', '-p', '#{pane_id}')
    await tmux('set-window-option', 'remain-on-exit', 'on')
    before = await tmux('show-options', '-t', 'test')
    const env = { CODEX_HOME: cfg, TMPDIR: temporary, VARGUS_LOCAL_TEST_KEY: 'local-test-only',
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' }
    const command = ['env', ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
      fileURLToPath(new URL('../../bin/vargus', import.meta.url)), 'codex', '--tmux', '--config', options,
      '--', '--no-alt-screen', '-C', project, 'Print LOCAL MOCK.'].map(quote).join(' ')
    await tmux('respawn-pane', '-k', '-t', pane, command)
    const reading = async () => {
      let row = ''
      try { row = await tmux('show-options', '-p', '-v', '-t', pane, '@vargus_line') } catch { /* startup */ }
      return { row, screen: await tmux('capture-pane', '-p', '-t', pane) }
    }
    const waitForTurn = async (number: number, tokens: string) => {
      const until = Date.now() + 15000
      let got = await reading()
      while (Date.now() < until) {
        got = await reading()
        if (userRequests >= number && titleRequests > 0 && Date.now() - lastRequestAt > 1500
          && got.screen.includes(`LOCAL MOCK COMPLETE ${number}`) && got.row.includes(`token:${tokens}`)) break
        await delay(100)
      }
      assert.match(got.row, new RegExp(`token:${tokens.replace('.', '\\.')}`), JSON.stringify(got))
      assert.match(got.row, /sol:low/)
      assert.doesNotMatch(got.row, /gpt-6\.1-sol/)
      assert.match(got.row, /ctx:18%/)
      assert.match(got.row, /5h:28%.*7d:61%/)
      assert.match(got.screen, /82% context left/)
    }
    await waitForTurn(1, '3.2k')
    assert.ok(titleRequests > 0, 'Control: the background title request actually ran')
    await tmux('send-keys', '-l', '-t', pane, 'Second local request.')
    await delay(300)
    await tmux('send-keys', '-t', pane, 'Enter')
    await waitForTurn(2, '6.4k')
    await stopWrapper()
    assert.equal(await tmux('show-options', '-t', 'test'), before)
  } finally {
    await stopWrapper().catch(() => {})
    await tmux('kill-server').catch(() => {})
    provider.closeAllConnections()
    await new Promise<void>(resolve => provider.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})
