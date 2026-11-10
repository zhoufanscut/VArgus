import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { applicationProcesses, applicationArguments } from '../../src/outputs/tmux/process.ts'
import { applicationTargets } from '../../src/outputs/tmux/target.ts'
import { PaneInput } from '../../src/outputs/tmux/input.ts'
import { TmuxOutput } from '../../src/outputs/tmux/client.ts'

const exec = promisify(execFile)
const windows = process.platform === 'win32'
const quote = (text: string) => "'" + text.replaceAll("'", "''") + "'"

test('Windows process queries identify a real Node PID and its JSON worker token', { skip: !windows }, async () => {
  assert.equal((await applicationProcesses()).find(p => p.pid === process.pid)?.command, 'node')
  const token = 'windows-native-token'
  const code = 'setInterval(() => {}, 1000)'
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, ['-e', code, '__row', JSON.stringify({ token })], { windowsHide: true })
  try {
    const args = await applicationArguments(child.pid!)
    assert.ok(args.includes('__row') && args.includes(`"token":"${token}"`), args)
  } finally { const exit = once(child, 'exit'); child.kill(); await exit }
})

test('Windows psmux refresh survives tty client names while retaining rendered readings', { skip: !windows, timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-windows-refresh-test-')), socket = join(dir, 'server')
  const run = async (...args: string[]) => (await exec('tmux', ['-S', socket, ...args],
    { windowsHide: true, env: { ...process.env, TMUX: '' } })).stdout.trimEnd()
  let output: TmuxOutput | undefined
  try {
    await run('new-session', '-d', '-s', 'test')
    const pane = await run('display-message', '-p', '#{pane_id}')
    class TtyClientOutput extends TmuxOutput {
      override async command(...args: string[]): Promise<string> {
        // Enumeration alone is seeded from the real attached Windows client
        // that reproduced the failure; every refresh still hits real psmux.
        if (args[0] === 'list-clients') return '/dev/pts/7532'
        return super.command(...args)
      }
    }
    output = new TtyClientOutput(socket, pane, join(dir, 'state'))
    await output.attach()
    for (const reading of ['FIRST READING', 'SECOND READING']) {
      await output.update(reading)
      await output.redraw()
      const frame = JSON.parse(await run('dump-state'))
      assert.ok(frame.status_left.includes(reading))
      assert.ok(frame.status_format[1].includes('test'))
      assert.equal(await run('show-options', '-v', 'status'), '2')
    }
    await output.detach()
    assert.equal(await run('show-options', '-v', 'status'), 'on')
  } finally {
    await output?.detach().catch(() => {})
    await run('kill-server').catch(() => {})
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('Windows built-in bar keeps session/window/right information below the VArgus header and restores scalar options', { skip: !windows, timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-windows-order-test-')), socket = join(dir, 'server')
  const run = async (...args: string[]) => (await exec('tmux', ['-S', socket, ...args],
    { windowsHide: true, env: { ...process.env, TMUX: '' } })).stdout.replace(/\r?\n$/, '')
  let output: TmuxOutput | undefined
  try {
    await run('new-session', '-d', '-s', 'test', '-n', 'ORIGINAL WINDOW', '-x', '160', '-y', '40')
    const pane = await run('display-message', '-p', '#{pane_id}')
    await run('set-option', 'status-left', 'LEFT #{session_name} ')
    await run('set-option', 'status-right', 'RIGHT %H:%M')
    await run('set-option', 'status-left-length', '30')
    await run('set-option', 'status-right-length', '30')
    output = new TmuxOutput(socket, pane, join(dir, 'state'))
    await output.attach(); await output.update('VARGUS HEADER')
    let frame = JSON.parse(await run('dump-state'))
    assert.ok(frame.status_left.includes('VARGUS HEADER'))
    assert.equal(frame.status_right_length, 0)
    assert.equal(frame.status_lines, 2)
    assert.ok(frame.status_format[1].includes('LEFT test'))
    assert.ok(frame.status_format[1].includes('ORIGINAL WINDOW'))
    assert.match(frame.status_format[1], /RIGHT \d{2}:\d{2}/)
    const stateFiles = (await readdir(join(dir, 'state'), { recursive: true })).filter(name => name.endsWith('state.json'))
    const stateFile = join(dir, 'state', stateFiles[0]!)
    const savedState = await readFile(stateFile, 'utf8')
    // Reproduce the existing writer's truncation interval without changing
    // the output's valid immutable attachment data.
    await writeFile(stateFile, '')
    try { await output.update('DURING SECOND OWNER SAVE') } finally { await writeFile(stateFile, savedState) }
    const unwrapped = await run('new-window', '-d', '-P', '-F', '#{pane_id}', '-n', 'UNWRAPPED')
    await run('select-window', '-t', unwrapped)
    frame = JSON.parse(await run('dump-state'))
    assert.ok(!frame.status_left.replace(/#\[[^\]]*\]/g, '').trim(), JSON.stringify({ header: frame.status_left, below: frame.status_format[1] }))
    assert.ok(frame.status_format[1].includes('LEFT test'))
    assert.match(frame.status_format[1], /RIGHT \d{2}:\d{2}/)
    await output.update('WRAPPED HEADER WHILE UNWRAPPED IS ACTIVE')
    frame = JSON.parse(await run('dump-state'))
    assert.ok(frame.status_format[1].includes('UNWRAPPED'))
    await run('select-window', '-t', pane)
    await output.detach()
    // The same raw scalar expressions and width settings are restored.
    assert.equal(await run('show-options', '-v', 'status-left'), 'LEFT #{session_name} ')
    assert.equal(await run('show-options', '-v', 'status-right'), 'RIGHT %H:%M')
    assert.equal(await run('show-options', '-v', 'status-left-length'), '30')
    assert.equal(await run('show-options', '-v', 'status-right-length'), '30')
    assert.equal(await run('show-options', '-v', 'status'), 'on')
    await output.attach(); await output.update('SECOND HEADER')
    await run('set-option', 'status-left', 'USER NEW LEFT')
    await output.detach()
    assert.equal(await run('show-options', '-v', 'status-left'), 'USER NEW LEFT')
    frame = JSON.parse(await run('dump-state'))
    assert.equal(frame.status_lines, 1)
  } finally {
    await output?.detach().catch(() => {})
    await run('kill-server').catch(() => {})
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('Windows updates publish only changed cells in one batch without forced refresh and keep shell formatters asynchronous', { skip: !windows, timeout: 60000 }, async () => {
  for (const scenario of ['steady', 'shell', 'bare-alias', 'separator']) {
    const dir = await mkdtemp(join(tmpdir(), 'vargus-windows-diff-test-')), socket = join(dir, 'server')
    const run = async (...args: string[]) => (await exec('tmux', ['-S', socket, ...args],
      { windowsHide: true, env: { ...process.env, TMUX: '' } })).stdout.replace(/\r?\n$/, '')
    let output: TmuxOutput | undefined
    try {
      await run('new-session', '-d', '-s', 'test', '-n', 'STABLE WINDOW', '-x', '160', '-y', '40')
      const pane = await run('display-message', '-p', '#{pane_id}')
      await run('set-window-option', 'automatic-rename', 'off')
      class CountedOutput extends TmuxOutput {
        mutations = 0
        refreshes = 0
        override async command(...args: string[]): Promise<string> {
          if (args.includes('set-option')) this.mutations++
          if (args[0] === 'refresh-client') this.refreshes++
          return super.command(...args)
        }
      }
      const counted = output = new CountedOutput(socket, pane, join(dir, 'state'))
      if (scenario === 'steady') {
        await run('set-option', 'status-right', 'RIGHT CONSTANT')
        await output.attach(); await output.update('UNCHANGED HEADER')
        const before = counted.mutations, refreshes = counted.refreshes
        await output.update('UNCHANGED HEADER')
        assert.equal(counted.mutations, before)
        assert.equal(counted.refreshes, refreshes)
        await output.update('CHANGED HEADER')
        assert.equal(counted.mutations, before + 1, 'publish changed values in one command batch')
      } else {
        const encoded = Buffer.from('Start-Sleep -Milliseconds 5200; Write-Output ASYNC_FORMATTER', 'utf16le').toString('base64')
        const format = `#(powershell.exe -NoProfile -EncodedCommand ${encoded})`
        if (scenario === 'bare-alias') await run('set-option', '@shell_value', format)
        const configured = scenario === 'bare-alias' ? '#{E:shell_value}' : format
        const option = scenario === 'separator' ? 'window-status-separator' : 'status-right'
        await run('set-option', '-g', option, configured)
        await output.attach()
        await output.update('HEADER WITH SLOW ORIGINAL FORMATTER')
        assert.equal(await run('show-options', '-v', 'status-left'), '[#S] ')
        assert.equal(await run('show-options', '-v', option), configured)
        // A later edit gets the same safe fallback before template evaluation.
        await output.detach()
        await run('set-option', '-g', option, 'PLAIN')
        await output.attach(); await output.update('TOP HEADER')
        await run('set-option', '-g', option, configured)
        await output.update('HEADER AFTER CONFIGURATION CHANGE')
        assert.equal(await run('show-options', '-v', 'status-left'), '[#S] ')
      }
    } finally {
      await output?.detach().catch(() => {})
      await run('kill-server').catch(() => {})
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})

test('Windows preserves expanded-empty custom slots and retries a partially assigned owned slot', { skip: !windows, timeout: 20000 }, async () => {
  for (const scenario of ['custom', 'partial']) {
    const dir = await mkdtemp(join(tmpdir(), 'vargus-windows-slot-test-')), socket = join(dir, 'server')
    const run = async (...args: string[]) => (await exec('tmux', ['-S', socket, ...args],
      { windowsHide: true, env: { ...process.env, TMUX: '' } })).stdout.trimEnd()
    let output: TmuxOutput | undefined
    try {
      await run('new-session', '-d', '-s', 'test')
      const pane = await run('display-message', '-p', '#{pane_id}')
      if (scenario === 'custom') {
        await run('set-option', 'status-format[1]', '#{@future}')
        await run('set-option', '@future', 'POSITIVE CONTROL')
        assert.equal(JSON.parse(await run('dump-state')).status_format[1], 'POSITIVE CONTROL')
        await run('set-option', '@future', '')
        output = new TmuxOutput(socket, pane, join(dir, 'state'))
        await assert.rejects(output.attach(), /existing inactive status slot/)
        await run('set-option', '@future', 'PRESERVED ORIGINAL EXPRESSION')
        assert.equal(JSON.parse(await run('dump-state')).status_format[1], 'PRESERVED ORIGINAL EXPRESSION')
        assert.equal(await run('show-options', '-v', 'status'), 'on')
      } else {
        const scalars = ['status-left', 'status-left-length', 'status-right-length', '@vargus_original_left', '@vargus_native_layout']
        const before = await Promise.all(scalars.map(option => run('show-options', '-v', option)))
        class InterruptedOutput extends TmuxOutput {
          override async command(...args: string[]): Promise<string> {
            if (args[0] === 'set-option' && args[1] === 'status' && args[2] === '2') throw new Error('CONTROLLED SETUP INTERRUPTION')
            return super.command(...args)
          }
        }
        await assert.rejects(new InterruptedOutput(socket, pane, join(dir, 'state')).attach(), /CONTROLLED SETUP INTERRUPTION/)
        assert.equal(await run('show-options', '-v', 'status'), 'on')
        assert.deepEqual(await Promise.all(scalars.map(option => run('show-options', '-v', option))), before)
        output = new TmuxOutput(socket, pane, join(dir, 'state'))
        await output.attach(); await output.update('RETRIED OWNED ROW'); await output.detach()
        assert.equal(await run('show-options', '-v', 'status'), 'on')
        // A later edit can also expand empty. It must survive shutdown
        // rather than being mistaken for our slot.
        await output.attach(); await output.update('OWNED ROW')
        await run('set-option', 'status-format[1]', '#{@future}')
        await output.detach()
        await run('set-option', '@future', 'PRESERVED USER EDIT')
        assert.equal(JSON.parse(await run('dump-state')).status_format[1], 'PRESERVED USER EDIT')
      }
    } finally {
      await output?.detach().catch(() => {})
      await run('kill-server').catch(() => {})
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})

test('Windows window-local bar formats and styles retain native rendering before attachment and after later edits', { skip: !windows, timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-windows-local-test-')), socket = join(dir, 'server')
  const run = async (...args: string[]) => (await exec('tmux', ['-S', socket, ...args],
    { windowsHide: true, env: { ...process.env, TMUX: '' } })).stdout.replace(/\r?\n$/, '')
  let output: TmuxOutput | undefined
  try {
    await run('new-session', '-d', '-s', 'test', '-n', 'LOCAL WINDOW')
    const pane = await run('display-message', '-p', '#{pane_id}')
    const window = await run('display-message', '-p', '#{window_id}')
    await run('set-window-option', '-t', window, 'automatic-rename', 'off')
    const left = await run('show-options', '-v', 'status-left')
    await run('set-window-option', '-t', window, 'window-status-current-format', 'CUSTOM LOCAL #W')
    output = new TmuxOutput(socket, pane, join(dir, 'state'))
    await output.attach(); await output.update('APPENDED HEADER')
    assert.equal(await run('show-options', '-v', 'status-left'), left)
    let frame = JSON.parse(await run('dump-state'))
    assert.match(frame.windows[0].tab_text, /CUSTOM LOCAL LOCAL WINDOW/)
    assert.match(frame.status_format[1], /APPENDED HEADER/)
    await output.detach()
    await run('set-window-option', '-u', '-t', window, 'window-status-current-format')
    await output.attach(); await output.update('TOP HEADER')
    assert.equal(await run('show-options', '-v', 'status-left'), '#{@vargus_header}')
    await run('set-window-option', '-t', window, 'window-status-current-format', 'LATER LOCAL #W')
    await run('set-window-option', '-t', window, 'window-status-current-style', 'fg=red,bold')
    await output.update('LATER APPENDED HEADER')
    assert.equal(await run('show-options', '-v', 'status-left'), left)
    frame = JSON.parse(await run('dump-state'))
    assert.match(frame.windows[0].tab_text, /LATER LOCAL LOCAL WINDOW/)
    assert.equal(frame.windows[0].wsc_style, 'fg=red,bold')
    assert.match(frame.status_format[1], /LATER APPENDED HEADER/)
    await output.detach()
    assert.equal(await run('show-options', '-v', 'status'), 'on')
  } finally {
    await output?.detach().catch(() => {})
    await run('kill-server').catch(() => {})
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('Windows psmux preserves existing custom rows and renders, reloads and restores official Codex', { skip: !windows, timeout: 120000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-windows-test-'))
  const home = join(dir, 'codex'), project = join(dir, 'project'), temporary = join(dir, 'tmp')
  for (const folder of [home, project, temporary]) await mkdir(folder)
  let posts = 0
  const provider = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.end('{}'); return }
    let body = ''; for await (const part of req) body += String(part)
    const title = JSON.parse(body).text?.format !== undefined
    const id = `windows_${++posts}`
    const events = [
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `msg_${id}`,
        content: [{ type: 'output_text', text: title ? JSON.stringify({ title: 'Windows native test' }) : 'WINDOWS NATIVE RESPONSE' }] } },
      { type: 'response.completed', response: { id, usage: { input_tokens: 42424, input_tokens_details: { cached_tokens: 40000 },
        output_tokens: 777, total_tokens: 43201 } } },
    ]
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
    res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''))
  })
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
  const port = (provider.address() as { port: number }).port
  const config = `model = "gpt-6.1-sol"
model_provider = "local_mock"
check_for_update_on_startup = false
[features]
hooks = true
[tui]
status_line = ["thread-id", "model-with-reasoning", "current-dir"]
screen_reader_detection_done = true
[tui.model_availability_nux]
"gpt-6.1-sol" = 99
[model_providers.local_mock]
name = "Windows local test"
base_url = "http://127.0.0.1:${port}/v1"
env_key = "VARGUS_LOCAL_TEST_KEY"
wire_api = "responses"
supports_websockets = false
requires_openai_auth = false
[projects.${JSON.stringify(project)}]
trust_level = "trusted"
`
  await writeFile(join(home, 'config.toml'), config)
  const socket = join(dir, 'server')
  await mkdir(join(home, 'vargus', 'autostart'), { recursive: true })
  const callback = (action: string) => ({ type: 'command',
    command: `& ${quote(resolve('bin/vargus.cmd'))} hook ${action} --socket ${quote(socket)}`, async: true, timeout: 30 })
  await writeFile(join(home, 'hooks.json'), JSON.stringify({ hooks: {
    SessionStart: [{ matcher: '^(startup|resume|clear|fork)$', hooks: [callback('session-start')] }],
    UserPromptSubmit: [{ hooks: [callback('prompt')] }],
  } }))
  const env = { ...process.env, CODEX_HOME: home, TMP: temporary, TEMP: temporary, TMUX: '', TMUX_PANE: '', VARGUS_LOCAL_TEST_KEY: 'local-test-only' }
  const run = async (...args: string[]) => (await exec('tmux', ['-S', socket, ...args], { env, windowsHide: true })).stdout.replace(/\r?\n$/, '')
  let pane = '', thread = ''
  const screen = () => run('capture-pane', '-p', '-t', pane)
  const wait = async (read: () => Promise<string>, pattern: RegExp) => {
    let value = ''; const until = Date.now() + 20000
    do { value = await read(); if (pattern.test(value)) return value; await delay(150) } while (Date.now() < until)
    assert.match(value, pattern, await screen()); return value
  }
  const control = async (action: string) => exec(process.execPath, [resolve('src/cli.ts'), action, '--socket', socket, '--pane', pane],
    { cwd: project, windowsHide: true, env: { ...env, VARGUS_CLI_MAIN: '1', CODEX_THREAD_ID: thread }, timeout: 25000 })
  const row = async () => { try { return await run('show-options', '-p', '-v', '-t', pane, '@vargus_line') } catch { return '' } }
  try {
    // Trust bypass is confined to this isolated home and these vetted test hooks.
    const script = `& codex --no-daemon --no-alt-screen --dangerously-bypass-hook-trust -C ${quote(project)}`
    await run('new-session', '-d', '-s', 'test', '-x', '180', '-y', '45',
      'pwsh -NoProfile -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64'))
    pane = await run('display-message', '-p', '#{pane_id}')
    await wait(screen, /Ask Codex to do anything/)
    const target = (await applicationTargets('codex', socket))[0]!
    assert.ok(target, JSON.stringify({ panes: await run('list-panes', '-a', '-F', '#{socket_path}|#{pane_id}|#{pane_pid}|#{pane_current_command}'),
      processes: (await applicationProcesses()).filter(p => ['codex', 'pwsh', 'node', 'cmd', 'tmux'].includes(p.command)) }))
    assert.equal(target.pane, pane)
    const snapshot = await new PaneInput(target).snapshot()
    assert.equal(snapshot.command, 'codex')
    assert.ok(Number.isFinite(snapshot.x) && Number.isFinite(snapshot.y) && snapshot.width === 180)
    // Preserve a custom first row without reading a raw status-format value.
    await run('set-option', 'status-format[0]', 'ORIGINAL WINDOWS ROW #{session_name}')
    const before = JSON.parse(await run('dump-state'))
    thread = (await wait(screen, /[0-9a-f]{8}-[0-9a-f-]{27}/)).match(/[0-9a-f]{8}-[0-9a-f-]{27}/)![0]
    await run('send-keys', '-l', '-t', pane, 'Windows local test prompt')
    await wait(screen, /Windows local test prompt/)
    await delay(250)
    await run('send-keys', '-t', pane, 'Enter')
    await wait(screen, /WINDOWS NATIVE RESPONSE/)
    await delay(500)
    const afterPrompt = posts
    assert.ok(afterPrompt > 0)
    await wait(row, /token:3\.2k/)
    console.log('WINDOWS_HOOK_ACTIVATED', thread)
    assert.match((await control('on')).stdout, /VArgus is (?:already )?on/)
    await wait(row, /token:3\.2k/)
    assert.equal(await run('show-options', '-v', 'status'), '2')
    assert.equal(JSON.parse(await run('dump-state')).status_format[0], before.status_format[0])
    assert.match((await control('status')).stdout, /VArgus is on/)
    assert.match((await control('reload')).stdout, /reloaded/)
    await wait(row, /token:3\.2k/)
    assert.match((await control('off')).stdout, /VArgus is off/)
    await wait(row, /^$/)
    await wait(screen, new RegExp(thread))
    assert.equal(await run('show-options', '-v', 'status'), 'on')
    assert.equal(JSON.parse(await run('dump-state')).status_format[0], before.status_format[0])
    assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), config)
    assert.equal(posts, afterPrompt, 'controls must not contact the model; the prompt is the positive control')
    // Two owners share a row; one departing owner must not remove the other.
    const first = new TmuxOutput(socket, pane, join(dir, 'owners'))
    const other = await run('new-window', '-d', '-P', '-F', '#{pane_id}')
    const second = new TmuxOutput(socket, other, join(dir, 'owners'))
    await first.attach(); await second.attach(); await first.detach()
    assert.equal(await run('show-options', '-v', 'status'), '2')
    await second.detach()
    assert.equal(await run('show-options', '-v', 'status'), 'on')
    console.log(JSON.stringify({ windowsNative: true, thread, pane, postsBeforeControls: afterPrompt, postsAfterControls: posts, originalRow: before.status_format[0] }))
  } finally {
    if (thread) await control('off').catch(() => {})
    await run('kill-server').catch(() => {})
    provider.closeAllConnections(); await new Promise<void>(done => provider.close(() => done()))
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
