import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { PaneInput } from '../../src/outputs/tmux/input'

const exec = promisify(execFile)
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"

for (const fixture of [
  { initialPrompt: '', selection: null },
  { initialPrompt: 'Explain app-server and exec-server', selection: ['session-id', 'model'] },
  { initialPrompt: '', selection: [] },
]) test(`official Codex standalone controls (${fixture.initialPrompt || 'fresh chat'}, footer ${JSON.stringify(fixture.selection)})`, { timeout: 90000 }, async () => {
  const { initialPrompt, selection } = fixture
  const dir = await mkdtemp(join(tmpdir(), 'vargus-standalone-test-'))
  const cfg = join(dir, 'codex'), project = join(dir, 'project'), temporary = join(dir, 'tmp')
  for (const folder of [cfg, project, temporary]) await mkdir(folder)
  const env = { ...process.env, CODEX_HOME: cfg, TMPDIR: temporary, VARGUS_LOCAL_TEST_KEY: 'local-test-only',
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', TMUX: '', TMUX_PANE: '' }
  let posts = 0
  const provider = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.end('{}'); return }
    let text = ''; for await (const part of req) text += String(part)
    const title = JSON.parse(text).text?.format !== undefined
    const id = `response_${++posts}`
    const events = [
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `msg_${id}`,
        content: [{ type: 'output_text', text: title ? JSON.stringify({ title: 'Local control test' }) : 'LOCAL CONTROL RESPONSE' }] } },
      { type: 'response.completed', response: { id, usage: { input_tokens: 42424, input_tokens_details: { cached_tokens: 40000 },
        output_tokens: 777, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 43201 } } },
    ]
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close',
      'x-codex-primary-used-percent': '27.5', 'x-codex-primary-window-minutes': '300' })
    res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''))
  })
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
  const port = (provider.address() as { port: number }).port
  await writeFile(join(cfg, 'config.toml'), `model = "gpt-6.1-sol"
model_provider = "local_mock"
model_reasoning_effort = "low"
model_context_window = 200000
check_for_update_on_startup = false
[tui]
${selection === null ? '' : 'status_line = ' + JSON.stringify(selection)}
screen_reader_detection_done = true
[tui.model_availability_nux]
"gpt-6.1-sol" = 99
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
  const socket = join(dir, 'tmux')
  const tmux = async (...args: string[]) => (await exec('tmux', ['-S', socket, ...args], { env })).stdout.replace(/\n$/, '')
  let pane = '', before = ''
  const screen = () => tmux('capture-pane', '-p', '-t', pane)
  const row = async () => {
    try { return await tmux('show-options', '-p', '-v', '-t', pane, '@vargus_line') } catch { return '' }
  }
  const wait = async (read: () => Promise<string>, match: RegExp) => {
    let got = '', until = Date.now() + 12000
    do { got = await read(); if (match.test(got)) return got; await delay(100) } while (Date.now() < until)
    assert.match(got, match, await screen()); return got
  }
  let controls = 0
  const submit = async (text: string) => {
    const marker = text.startsWith('!') ? `VARGUS_CONTROL_DONE_${++controls}` : ''
    if (marker) text += `; printf '\\n${marker}\\n'`
    const buffer = `vargus-test-${process.pid}-${Date.now()}`
    await tmux('set-buffer', '-b', buffer, text)
    await tmux('paste-buffer', '-p', '-d', '-b', buffer, '-t', pane)
    if (text !== '/exit') {
      const literal = text.replace(/\s+/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      await wait(async () => (await screen()).replace(/\s+/g, ''), new RegExp(literal))
    }
    await delay(200)
    await tmux('send-keys', '-t', pane, 'Enter')
    if (marker) {
      await wait(screen, new RegExp('^\\s*(?:└ )?' + marker + '\\s*$', 'm'))
      const activity = async () => {
        const text = await screen()
        return text.slice(text.lastIndexOf(marker) + marker.length)
      }
      const until = Date.now() + 3000
      while (/^• (?:Running|Working) /m.test(await activity()) && Date.now() < until) await delay(50)
      assert.doesNotMatch(await activity(), /^• (?:Running|Working) /m)
    }
  }
  const command = (action: string, extra = '') => '!COLUMNS=80 ' + quote(resolve('bin/vargus')) + ' ' + action + (extra ? ' ' + extra : '')
  try {
    // This daemon starts outside tmux: !command must not rely on inherited pane variables.
    await exec('codex', ['app-server', 'daemon', 'start'], { env })
    await tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'test', '-x', '157', '-y', '40', 'sleep 120')
    pane = await tmux('display-message', '-p', '#{pane_id}')
    await tmux('set-window-option', 'remain-on-exit', 'on')
    before = await tmux('show-options', '-t', 'test')
    const launch = ['env', `CODEX_HOME=${cfg}`, `TMPDIR=${temporary}`, 'VARGUS_LOCAL_TEST_KEY=local-test-only',
      'NO_PROXY=127.0.0.1,localhost', 'no_proxy=127.0.0.1,localhost', 'codex', '--no-alt-screen', '-C', project].map(quote).join(' ')
    await tmux('respawn-pane', '-k', '-t', pane, launch + (initialPrompt ? ' ' + quote(initialPrompt) : ''))
    await wait(screen, /Ask Codex/)
    await delay(700)
    if (initialPrompt) { await wait(screen, /LOCAL CONTROL RESPONSE/); await delay(1000) }
    const footer = async () => {
      const text = await screen()
      return text.slice(text.lastIndexOf('Ask Codex to do anything') + 'Ask Codex to do anything'.length)
    }
    const footerMatches = selection?.length === 0 ? /for shortcuts/ : selection ? /[0-9a-f]{8}-[0-9a-f-]{27}.*gpt-6\.1-sol/i : /gpt-6\.1-sol.*project/i
    await wait(footer, footerMatches)
    const savedConfig = await readFile(join(cfg, 'config.toml'), 'utf8')
    const beforeControls = posts
    if (initialPrompt) assert.ok(beforeControls > 0)
    else assert.equal(beforeControls, 0)
    const expectedTokens = initialPrompt ? '6.4k' : '3.2k'
    if (selection?.length) {
      await tmux('set-option', '-t', 'test', 'status', '5')
      await submit(command('on', '--socket ' + quote(socket)))
      await wait(screen, /maximum status rows/)
      await wait(footer, footerMatches)
      assert.equal(await row(), '')
      await tmux('set-option', '-u', '-t', 'test', 'status')
    }
    await submit(command('on', '--socket ' + quote(socket)))
    await wait(screen, /VArgus is on/)
    await wait(footer, /for shortcuts/)
    assert.doesNotMatch(await footer(), /gpt-6\.1-sol|[0-9a-f]{8}-[0-9a-f-]{27}/i)
    assert.equal(await readFile(join(cfg, 'config.toml'), 'utf8'), savedConfig)
    assert.equal(posts, beforeControls)
    // Changing saved settings while active must not overwrite the original backup.
    const changedConfig = /^status_line = /m.test(savedConfig)
      ? savedConfig.replace(/^status_line = .*$/m, 'status_line = ["model"]')
      : savedConfig.replace('[tui]', '[tui]\nstatus_line = ["model"]')
    await writeFile(join(cfg, 'config.toml'), changedConfig)
    await submit(command('on'))
    await wait(screen, /already on/)
    const footerDir = join(temporary, `vargus-control-${process.getuid?.() ?? 'user'}`, 'footers')
    const backups = await readdir(footerDir)
    const originalBackup = JSON.parse(await readFile(join(footerDir, backups[0]!), 'utf8'))
    assert.deepEqual(originalBackup.selection, selection)
    await writeFile(join(cfg, 'config.toml'), savedConfig)
    assert.equal(posts, beforeControls)
    await submit('Print a local test reply.')
    await wait(screen, /LOCAL CONTROL RESPONSE/)
    const metrics = await wait(row, new RegExp('sol:low.*5h:28%.*ctx:18%.*token:' + expectedTokens.replace('.', '\\.')))
    assert.doesNotMatch(metrics, /gpt-6\.1-sol/)
    await delay(1000); let afterTurn = posts
    assert.ok(afterTurn > 0, 'Positive control: a user turn reaches the same local model counter')
    // A second official TUI makes automatic pane selection ambiguous.
    const firstPane = pane
    // Read this real TUI's identity without another synthetic !/Enter exchange.
    // The main pane above covers that user-shell path; this pane tests selection.
    pane = await tmux('new-window', '-d', '-P', '-F', '#{pane_id}', '-t', 'test', launch + ' -c ' + quote('tui.status_line=["session-id"]') + ' ' + quote('Second-pane local fixture.'))
    await wait(screen, /LOCAL CONTROL RESPONSE/)
    await delay(1000)
    afterTurn = posts
    const identity = await wait(footer, /[0-9a-f]{8}-[0-9a-f-]{27}/)
    const secondThread = identity.match(/[0-9a-f]{8}-[0-9a-f-]{27}/)![0]
    const secondControl = (action: string, flags: string[] = []) => exec(resolve('bin/vargus'), [action, ...flags], {
      cwd: project, env: { ...env, CODEX_THREAD_ID: secondThread },
    })
    await assert.rejects(secondControl('on', ['--socket', socket]), /Select one codex pane/)
    assert.equal(await row(), '')
    await secondControl('on', ['--socket', socket, '--pane', pane])
    assert.equal(await tmux('show-options', '-v', '-t', 'test', 'status'), '2')
    await secondControl('off')
    await wait(row, /^$/)
    await wait(footer, footerMatches)
    pane = firstPane
    assert.ok((await row()).includes('token:' + expectedTokens))
    assert.equal(posts, afterTurn)
    await submit(command('status')); await wait(screen, /VArgus is on in/)
    // Exercise off from outside the composer while a real draft remains inside.
    const records = await readdir(join(temporary, `vargus-control-${process.getuid?.() ?? 'user'}`))
    let active: any, activeFile = ''
    for (const name of records.filter(n => n.endsWith('.json'))) {
      const value = JSON.parse(await readFile(join(temporary, `vargus-control-${process.getuid?.() ?? 'user'}`, name), 'utf8'))
      if (value.target.pane === pane) { active = value; activeFile = name }
    }
    assert.ok(active)
    await tmux('send-keys', '-l', '-t', pane, 'Ask Codex to do anything')
    await delay(100)
    await tmux('send-keys', '-t', pane, 'Home')
    await delay(100)
    const input = new PaneInput(active.target)
    const draftScreen = await input.snapshot()
    const deferred = await exec(resolve('bin/vargus'), ['off'], { cwd: project, env: { ...env, CODEX_THREAD_ID: active.thread } })
    assert.match(deferred.stdout, /VArgus is off;.*pending restoration/)
    assert.equal(await row(), '')
    const afterDraft = await input.snapshot()
    assert.equal(afterDraft.lines[afterDraft.y], draftScreen.lines[draftScreen.y], 'draft with placeholder words must be preserved')
    assert.equal(afterDraft.x, draftScreen.x)
    await tmux('send-keys', '-t', pane, 'End', 'C-u')
    await submit(command('off')); await wait(() => tmux('show-options', '-t', 'test'), new RegExp('^' + before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'))
    assert.equal(await tmux('show-options', '-t', 'test'), before)
    await wait(footer, footerMatches)
    assert.equal(await readFile(join(cfg, 'config.toml'), 'utf8'), savedConfig)
    assert.equal(posts, afterTurn)
    // Replay must restore existing totals without another model request.
    await submit(command('on', '--socket ' + quote(socket) + ' --pane ' + pane))
    await wait(row, new RegExp('token:' + expectedTokens.replace('.', '\\.')))
    assert.equal(posts, afterTurn)
    // Kill only this test's helper. Footer recovery must outlive its PID record.
    const live = JSON.parse(await readFile(join(temporary, `vargus-control-${process.getuid?.() ?? 'user'}`, activeFile), 'utf8'))
    process.kill(live.pid, 'SIGKILL')
    await delay(300)
    await submit(command('off'))
    await wait(footer, footerMatches)
    await wait(row, /^$/)
    await submit(command('on', '--socket ' + quote(socket) + ' --pane ' + pane))
    await wait(row, new RegExp('token:' + expectedTokens.replace('.', '\\.')))
    if (selection?.length) {
      await submit(command('off'))
      await wait(row, /^$/)
      const staleSelection = ['session-id', 'vargus-unknown-item']
      await writeFile(join(cfg, 'config.toml'), savedConfig.replace(/^status_line = .*$/m, 'status_line = ' + JSON.stringify(staleSelection)))
      await submit(command('on', '--socket ' + quote(socket) + ' --pane ' + pane))
      await wait(row, new RegExp('token:' + expectedTokens.replace('.', '\\.')))
      await writeFile(join(cfg, 'config.toml'), savedConfig)
      for (let attempt = 0; attempt < 2; attempt++) {
        await submit(command('off'))
        await wait(screen, /completion is inconclusive/)
        assert.equal(await row(), '', 'off removes the row while restoration remains pending')
        const names = await readdir(footerDir)
        assert.equal(names.length, 1)
        assert.deepEqual(JSON.parse(await readFile(join(footerDir, names[0]!), 'utf8')).selection, staleSelection)
        assert.doesNotMatch(await footer(), /[0-9a-f]{8}-[0-9a-f-]{27}/i)
        assert.equal(posts, afterTurn)
      }
    }
    await submit('/exit')
    await wait(() => tmux('display-message', '-p', '-t', pane, '#{pane_dead}'), /^1$/)
    await wait(() => tmux('show-options', '-t', 'test'), new RegExp('^' + before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'))
    assert.equal(await tmux('show-options', '-t', 'test'), before)
    assert.equal(posts, afterTurn)
    console.log(JSON.stringify({ postsBeforeControls: beforeControls, postsAfterTurn: afterTurn, finalPosts: posts, metrics }))
  } finally {
    await tmux('kill-server').catch(() => {})
    await exec('codex', ['app-server', 'daemon', 'stop'], { env }).catch(() => {})
    provider.closeAllConnections(); await new Promise<void>(done => provider.close(() => done()))
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
