import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, rename, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { PaneInput } from '../../src/outputs/tmux/input.ts'
import { startupDirectory, startupSuppressed, startupControl } from '../../src/cli/startup.ts'
import { codexComposer } from '../../src/hosts/codex/footer.ts'

const exec = promisify(execFile)
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"

for (const fixture of [
  { initialPrompt: '', selection: null },
  { initialPrompt: 'Explain app-server and exec-server', selection: ['session-id', 'model'] },
  { initialPrompt: '', selection: [] },
]) test(`official Codex standalone controls (${fixture.initialPrompt || 'fresh chat'}, footer ${JSON.stringify(fixture.selection)})`, { timeout: 120000 }, async () => {
  const { initialPrompt, selection } = fixture
  const dir = await mkdtemp(join(tmpdir(), 'vargus-standalone-test-'))
  const cfg = join(dir, 'codex'), project = join(dir, 'project'), temporary = join(dir, 'tmp')
  for (const folder of [cfg, project, temporary]) await mkdir(folder)
  // Exercise a source-only install: no dist or node_modules is copied.
  const install = join(dir, 'install')
  for (const name of ['src', 'bin', 'package.json']) await cp(resolve(name), join(install, name), { recursive: true })
  const entry = join(install, 'bin/vargus')
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
    try { return (await tmux('show-options', '-p', '-v', '-t', pane, '@vargus_line')).replace(/#\[[^\]]*\]/g, '') } catch { return '' }
  }
  let newThreadChoice = false
  const wait = async (read: () => Promise<string>, match: RegExp) => {
    let got = '', until = Date.now() + 12000
    do {
      if (newThreadChoice && (await screen()).includes('Where should the new conversation run?')) {
        newThreadChoice = false
        await tmux('send-keys', '-t', pane, 'Enter')
      }
      got = await read(); if (match.test(got)) return got; await delay(100)
    } while (Date.now() < until)
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
    if (text === '/new') newThreadChoice = true
    if (marker) {
      await wait(screen, new RegExp('^\\s*(?:└ )?' + marker + '\\s*$', 'm'))
      const activity = async () => {
        const text = await screen()
        return text.slice(text.lastIndexOf(marker) + marker.length)
      }
      // Shell stdout can precede Codex's completion event. Require its footer
      // before treating a momentarily absent Working indicator as settled.
      await wait(async () => {
        const value = await activity()
        return /^\s*Worked for /m.test(value) && !/^• (?:Running|Working) /m.test(value) ? 'idle' : 'busy'
      }, /^idle$/)
      assert.doesNotMatch(await activity(), /^• (?:Running|Working) /m)
    }
  }
  const command = (action: string, extra = '') => '!COLUMNS=80 ' + quote(entry) + ' ' + action + (extra ? ' ' + extra : '')
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
    const optionsFile = join(dir, 'options.json')
    await writeFile(optionsFile, JSON.stringify({ session: false, codexAgentCounts: false }))
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
    // A crash between opening an atomic-write temporary and renaming it must
    // not poison discovery of the completed backup, including ordinary off.
    const unfinished = join(footerDir, backups[0] + '.' + process.pid + '.tmp')
    await writeFile(unfinished, '')
    const controlEnv = { ...env, CODEX_THREAD_ID: originalBackup.thread }
    assert.match((await exec(entry, ['status'], { cwd: project, env: controlEnv })).stdout, /VArgus is on/)
    assert.match((await exec(entry, ['on'], { cwd: project, env: controlEnv })).stdout, /already on/)
    assert.match((await exec(entry, ['off'], { cwd: project, env: controlEnv })).stdout, /VArgus is off/)
    await wait(row, /^$/)
    await rm(unfinished)
    await submit(command('on', '--socket ' + quote(socket) + ' --pane ' + pane))
    await wait(row, /session:/)
    assert.equal(posts, beforeControls)
    await submit('Print a local test reply.')
    await wait(screen, /LOCAL CONTROL RESPONSE/)
    const metrics = await wait(row, new RegExp('sol:low.*5h:28%.*ctx:18%.*token:' + expectedTokens.replace('.', '\\.')))
    assert.doesNotMatch(metrics, /gpt-6\.1-sol/)
    await delay(1000); let afterTurn = posts
    assert.ok(afterTurn > 0, 'Positive control: a user turn reaches the same local model counter')
    if (!initialPrompt) {
      await tmux('send-keys', '-l', '-t', pane, 'Fresh default draft')
      await delay(1400)
      assert.doesNotMatch(await row(), /\[paused:/)
      assert.match(await row(), new RegExp('token:' + expectedTokens.replace('.', '\\.')))
      const controlDir = join(temporary, `vargus-control-${process.getuid?.() ?? 'user'}`)
      const runtimePath = join(controlDir, (await readdir(controlDir)).find(n => n.endsWith('.json'))!)
      const paused = JSON.parse(await readFile(runtimePath, 'utf8'))
      assert.equal(paused.selected, undefined)
      assert.equal(paused.paused.label, 'main')
      await tmux('send-keys', '-t', pane, 'C-e', 'C-u')
      await wait(async () => JSON.parse(await readFile(runtimePath, 'utf8')).selected ?? '', new RegExp(paused.thread))
      assert.equal(posts, afterTurn)
    }
    if (initialPrompt) {
      const controlDir = join(temporary, `vargus-control-${process.getuid?.() ?? 'user'}`)
      const file = (await readdir(controlDir)).find(name => name.endsWith('.json'))!
      const runtime = async () => JSON.parse(await readFile(join(controlDir, file), 'utf8'))
      const beforeUpgrade = await runtime()
      // Load a separate legacy-style worker: it reports v5 and retains the old
      // false option. Bare on must replace that Node process and drop the key.
      const legacyRoot = join(dir, 'legacy')
      await cp(install, legacyRoot, { recursive: true })
      const oldPath = join(legacyRoot, 'src/cli.ts')
      for (const [file, from, to] of [
        ['src/cli/codex.ts', 'const workerVersion = 7', 'const workerVersion = 5'],
        ['src/options.ts', 'export const DEFAULTS = {', 'export const DEFAULTS = { codexDraftHold: false,'],
        ['src/cli/codex.ts', 'const hold = !!(lastReadings', 'const hold = !!(options.codexDraftHold && lastReadings'],
      ] as const) {
        const path = join(legacyRoot, file), old = await readFile(path, 'utf8')
        assert.equal(old.split(from).length, 2, from)
        await writeFile(path, old.replace(from, to))
      }
      await exec(process.execPath, [oldPath, 'reload', '--config', optionsFile, '--theme', 'ember'], {
        cwd: project, env: { ...env, VARGUS_CLI_MAIN: '1', CODEX_THREAD_ID: beforeUpgrade.thread },
      })
      const legacy = await runtime()
      assert.equal(legacy.version, 5)
      assert.equal(legacy.reload.options.codexDraftHold, false)
      const backupName = (await readdir(footerDir))[0]!
      const backup = await readFile(join(footerDir, backupName), 'utf8')
      const upgraded = await exec(entry, ['on'], {
        cwd: project, env: { ...env, CODEX_THREAD_ID: legacy.thread },
      })
      assert.match(upgraded.stdout, /helper upgraded/)
      const active = await runtime(), input = new PaneInput(active.target)
      assert.notEqual(active.pid, legacy.pid)
      assert.equal(active.version, 7)
      assert.equal(active.thread, legacy.thread)
      assert.equal(active.transcript, legacy.transcript)
      assert.deepEqual(active.target, legacy.target)
      assert.equal(active.reload.home, legacy.reload.home)
      assert.equal(active.reload.options.theme, 'ember')
      assert.equal(active.reload.options.session, false)
      assert.equal(active.reload.options.codexAgentCounts, false)
      assert.equal('codexDraftHold' in active.reload.options, false)
      assert.equal(await readFile(join(footerDir, backupName), 'utf8'), backup)
      assert.equal(posts, afterTurn)
      console.log('LEGACY_UPGRADED', JSON.stringify({ legacyPid: legacy.pid, pid: active.pid, tuiPid: active.target.pid,
        thread: active.thread, options: active.reload.options, posts }))
      for (const text of ['normal draft', 'first line\nsecond line', 'a long draft '.repeat(25),
        'draft\n\n`/root/child` · ← for agents\nffffffff-ffff-ffff-ffff-ffffffffffff\n100% context left', '/stat', '!printf local-draft-only']) {
        const shell = text.startsWith('!')
        if (shell) { await tmux('send-keys', '-l', '-t', pane, '!'); await delay(200) }
        await tmux('set-buffer', '-b', 'typing-test', shell ? text.slice(1) : text)
        await tmux('paste-buffer', '-p', '-d', '-b', 'typing-test', '-t', pane)
        // Observe past the render interval so a stale pre-draft row cannot pass.
        await delay(1400)
        assert.match(await row(), /token:6\.4k/, JSON.stringify({ text, screen: await input.snapshot(), state: await runtime() }))
        assert.doesNotMatch(await row(), /\[paused:/)
        assert.equal((await runtime()).selected, undefined)
        assert.equal((await runtime()).paused.thread, active.thread)
        assert.equal(codexComposer(await input.snapshot(), ''), false)
        await tmux('send-keys', '-t', pane, 'C-a'); await delay(1200)
        assert.match(await row(), /token:6\.4k/, 'moving the draft caret must keep the row')
        assert.equal((await runtime()).selected, undefined)
        assert.equal((await runtime()).paused.thread, active.thread)
        assert.equal(await readFile(join(footerDir, backupName), 'utf8'), backup)
        assert.equal(posts, afterTurn)
        console.log('DRAFT_DISPLAY', JSON.stringify({ shell, multiline: text.includes('\n'), chars: text.length,
          thread: active.thread, selected: (await runtime()).selected, paused: (await runtime()).paused, postsBefore: afterTurn, postsAfter: posts }))
        await tmux('send-keys', '-t', pane, 'Escape'); await delay(200)
        for (let clear = 0; clear < 8; clear++) {
          await tmux('send-keys', '-t', pane, 'C-e'); await delay(40)
          await tmux('send-keys', '-t', pane, 'C-u'); await delay(40)
          await tmux('send-keys', '-t', pane, 'BSpace'); await delay(40)
        }
        assert.equal(codexComposer(await input.snapshot(), ''), true)
        await wait(row, /token:6\.4k/)
        const until = Date.now() + 3000
        while ((await runtime()).selected !== active.thread && Date.now() < until) await delay(100)
        assert.equal((await runtime()).selected, active.thread)
        assert.equal((await runtime()).paused, undefined)
      }
    }
    if (initialPrompt) {
      const controlDir = join(temporary, `vargus-control-${process.getuid?.() ?? 'user'}`)
      const runtimeName = (await readdir(controlDir)).find(name => name.endsWith('.json'))!
      const runtimePath = join(controlDir, runtimeName)
      const runtime = async () => JSON.parse(await readFile(runtimePath, 'utf8'))
      const first = await runtime()
      const backupName = (await readdir(footerDir))[0]!
      const original = await readFile(join(footerDir, backupName), 'utf8')
      // A separate source tree proves replacement loads changed code, rather
      // than acknowledging a request in the old Node process.
      const replacement = join(dir, 'replacement')
      await cp(install, replacement, { recursive: true })
      const entryPath = join(replacement, 'src/cli.ts')
      const sourcePath = join(replacement, 'src/cli/codex.ts')
      const source = await readFile(sourcePath, 'utf8'), entrySource = await readFile(entryPath, 'utf8')
      assert.equal(source.split('await output.update(line)').length, 2)
      const changed = source.replace('await output.update(line)', 'await output.update(line + " RELOAD_SOURCE_B")')
      await writeFile(sourcePath, changed)
      const control = (action: string, flags: string[] = []) => exec(process.execPath, [entryPath, action, ...flags], {
        cwd: project, env: { ...env, VARGUS_CLI_MAIN: '1', CODEX_THREAD_ID: first.thread },
      })
      // PID/token verification and TUI identity checks precede replacement.
      await writeFile(runtimePath, JSON.stringify({ ...first, token: 'unrelated-worker-token' }))
      assert.match((await control('reload', ['--socket', socket, '--pane', pane])).stdout, /nothing to reload/)
      assert.ok((await row()).includes('token:'))
      await writeFile(runtimePath, JSON.stringify({ ...first, version: 4, reload: undefined }))
      await assert.rejects(control('reload'), /older helper has no reload options metadata/)
      assert.equal((await runtime()).pid, first.pid)
      await writeFile(runtimePath, JSON.stringify({ ...first, target: { ...first.target, pid: process.pid } }))
      await assert.rejects(control('reload', ['--socket', socket, '--pane', pane]), /Codex process.*changed/)
      await writeFile(runtimePath, JSON.stringify(first))
      await rename(first.transcript, first.transcript + '.held')
      await assert.rejects(control('reload'))
      assert.equal((await runtime()).pid, first.pid, 'unreadable transcript keeps healthy helper')
      await rename(first.transcript + '.held', first.transcript)
      assert.match((await control('reload')).stdout, /helper reloaded/)
      await wait(row, /RELOAD_SOURCE_B/)
      const second = await runtime()
      assert.notEqual(second.pid, first.pid)
      assert.notEqual(second.token, first.token)
      assert.deepEqual(second.target, first.target, 'same official TUI process and pane')
      assert.equal(second.thread, first.thread)
      assert.equal(second.transcript, first.transcript)
      assert.equal(second.reload.options.theme, 'ember')
      assert.equal(second.reload.options.session, false)
      assert.equal(second.reload.options.codexAgentCounts, false)
      assert.equal('codexDraftHold' in second.reload.options, false)
      assert.match(await row(), /token:6\.4k/)
      assert.equal(await readFile(join(footerDir, backupName), 'utf8'), original)
      await writeFile(optionsFile, JSON.stringify({ session: true }))
      await control('reload', ['--config', optionsFile, '--theme', 'graphite'])
      assert.equal((await runtime()).reload.options.session, true)
      assert.equal((await runtime()).reload.options.codexAgentCounts, false)
      assert.equal((await runtime()).reload.options.theme, 'graphite')
      // Replacement failure keeps the handoff and backups for the next command.
      await writeFile(entryPath, 'if (process.argv[2] === "__row") throw new Error("CONTROLLED_START_FAILURE");\n' + entrySource)
      await assert.rejects(control('reload'), /CONTROLLED_START_FAILURE.*Footer backups.*retained/s)
      assert.equal(await row(), '')
      assert.equal(await readFile(join(footerDir, backupName), 'utf8'), original)
      await writeFile(entryPath, entrySource)
      await control('reload')
      await wait(row, /RELOAD_SOURCE_B/)
      assert.equal((await runtime()).reload.options.session, true)
      assert.equal(posts, afterTurn, 'reloads make no provider request; normal prompt above is positive control')
      console.log(JSON.stringify({ reload: { firstPid: first.pid, replacementPid: second.pid, tuiPid: second.target.pid,
        thread: second.thread, marker: 'RELOAD_SOURCE_B', tokens: '6.4k', postsBefore: afterTurn, postsAfter: posts } }))
    }
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
    const secondControl = (action: string, flags: string[] = []) => exec(entry, [action, ...flags], {
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
    if (initialPrompt) {
      await mkdir(startupDirectory(cfg), { recursive: true })
      // Fail after actual off admission but before worker delivery. The independent
      // real-TUI regression also terminates an off process at this boundary.
      await assert.rejects(startupControl(cfg, active.target, active.thread, 'off', false, async () => {
        throw new Error('off interrupted before request delivery')
      }), /off interrupted/)
      const previous = JSON.parse(await readFile(join(temporary, `vargus-control-${process.getuid?.() ?? 'user'}`, activeFile), 'utf8'))
      assert.equal(previous.mode, 'on')
      const result = await exec(entry, ['reload'], { cwd: project, env: { ...env, CODEX_THREAD_ID: active.thread } })
      assert.match(result.stdout, /helper reloaded.*VArgus is off/s)
      const replacement = JSON.parse(await readFile(join(temporary, `vargus-control-${process.getuid?.() ?? 'user'}`, activeFile), 'utf8'))
      assert.notEqual(replacement.pid, previous.pid)
      assert.equal(replacement.mode, 'restore')
      assert.equal(await row(), '')
      assert.equal(await startupSuppressed(cfg, active.target, active.thread), true)
    }
    const deferred = await exec(entry, ['off'], { cwd: project, env: { ...env, CODEX_THREAD_ID: active.thread } })
    assert.match(deferred.stdout, /VArgus is off;.*pending restoration/)
    assert.equal(await row(), '')
    const afterDraft = await input.snapshot()
    assert.equal(afterDraft.lines[afterDraft.y], draftScreen.lines[draftScreen.y], 'draft with placeholder words must be preserved')
    assert.equal(afterDraft.x, draftScreen.x)
    if (initialPrompt) {
      await mkdir(startupDirectory(cfg), { recursive: true })
      // Repeat off after enabling suppression state, then reload during a draft.
      await exec(entry, ['off'], { cwd: project, env: { ...env, CODEX_THREAD_ID: active.thread } })
      const offState = JSON.parse(await readFile(join(temporary, `vargus-control-${process.getuid?.() ?? 'user'}`, activeFile), 'utf8'))
      const reloaded = await exec(entry, ['reload'], { cwd: project, env: { ...env, CODEX_THREAD_ID: active.thread } })
      assert.match(reloaded.stdout, /helper reloaded.*VArgus is off/s)
      const restore = JSON.parse(await readFile(join(temporary, `vargus-control-${process.getuid?.() ?? 'user'}`, activeFile), 'utf8'))
      assert.notEqual(restore.pid, offState.pid)
      assert.equal(restore.mode, 'restore')
      assert.equal(await row(), '')
      assert.equal(await startupSuppressed(cfg, active.target, active.thread), true)
      const kept = await input.snapshot()
      assert.equal(kept.lines[kept.y], draftScreen.lines[draftScreen.y])
      assert.equal(kept.x, draftScreen.x)
    }
    await tmux('send-keys', '-t', pane, 'End', 'C-u')
    await submit(command('off')); await wait(() => tmux('show-options', '-t', 'test'), new RegExp('^' + before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'))
    assert.equal(await tmux('show-options', '-t', 'test'), before)
    await wait(footer, footerMatches)
    assert.equal(await readFile(join(cfg, 'config.toml'), 'utf8'), savedConfig)
    assert.equal(posts, afterTurn)
    if (initialPrompt) {
      const result = await exec(entry, ['reload'], { cwd: project, env: { ...env, CODEX_THREAD_ID: active.thread } })
      assert.match(result.stdout, /VArgus is off/)
      assert.equal(await row(), '')
      assert.equal(await startupSuppressed(cfg, active.target, active.thread), true)
    }
    // Replay must restore existing totals without another model request.
    await submit(command('on', '--socket ' + quote(socket) + ' --pane ' + pane))
    await wait(row, new RegExp('token:' + expectedTokens.replace('.', '\\.')))
    assert.equal(posts, afterTurn)
    // Kill only this test's helper. Footer recovery must outlive its PID record.
    const live = JSON.parse(await readFile(join(temporary, `vargus-control-${process.getuid?.() ?? 'user'}`, activeFile), 'utf8'))
    process.kill(live.pid, 'SIGKILL')
    await delay(300)
    if (selection === null) {
      await rename(live.transcript, live.transcript + '.held')
      const result = await exec(entry, ['off'], { cwd: project, env: { ...env, CODEX_THREAD_ID: live.thread } })
      assert.match(result.stdout, /pending restoration/)
      assert.equal(await row(), '')
      assert.equal(await tmux('show-options', '-t', 'test'), before)
      assert.deepEqual(JSON.parse(await readFile(join(footerDir, (await readdir(footerDir))[0]!), 'utf8')).selection, selection)
      assert.match((await exec(entry, ['status'], { cwd: project, env: { ...env, CODEX_THREAD_ID: live.thread } })).stdout, /pending/)
      await rename(live.transcript + '.held', live.transcript)
    }

    await submit(command('off'))
    await wait(footer, footerMatches)
    await wait(row, /^$/)
    await submit(command('on', '--socket ' + quote(socket) + ' --pane ' + pane))
    await wait(row, new RegExp('token:' + expectedTokens.replace('.', '\\.')))
    if (selection === null || selection.length) {
      const stateDirectory = join(temporary, `vargus-control-${process.getuid?.() ?? 'user'}`)
      const readRuntime = () => readFile(join(stateDirectory, activeFile), 'utf8').then(JSON.parse)
      const original = await readRuntime()
      await submit('/new')
      await wait(footer, footerMatches)
      if (selection?.length) {
        // A full native ID identifies the new root as outside this helper's family.
        await wait(row, /^$/)
        await wait(() => tmux('show-options', '-A', '-v', '-t', 'test', 'status'), /^on$/)
        // Height changes before the original-format aliases finish being removed.
        await wait(() => tmux('show-options', '-t', 'test'), new RegExp('^' + before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'))
        assert.equal(await tmux('show-options', '-t', 'test'), before)
        await tmux('send-keys', '-l', '-t', pane, 'new conversation draft')
        await wait(screen, /new conversation draft/)
        await delay(1400)
        assert.equal(await row(), '')
        assert.equal(await tmux('show-options', '-A', '-v', '-t', 'test', 'status'), 'on')
        assert.equal((await readRuntime()).paused, undefined)
        await tmux('send-keys', '-t', pane, 'C-e', 'C-u')
      }
      await submit(command('on', '--socket ' + quote(socket) + ' --pane ' + pane
        + (selection === null ? ' --theme ember --config ' + quote(optionsFile) : '')))
      await wait(row, /\S/)
      assert.equal(await tmux('show-options', '-A', '-v', '-t', 'test', 'status'), '2')
      const replacement = await readRuntime()
      assert.notEqual(replacement.thread, original.thread)
      assert.equal(replacement.target.pid, original.target.pid)
      assert.equal((await readdir(footerDir)).length, 2)
      await submit(command('off'))
      await wait(footer, footerMatches)
      assert.equal((await readRuntime()).pending, 1)
      await submit('/resume ' + original.thread)
      await submit('!printf "ROOT_VISIT=%s\\n" "$CODEX_THREAD_ID"')
      await wait(screen, new RegExp('ROOT_VISIT=' + original.thread))
      if (selection === null) {
        // Keep the restore helper alive to observe options before and after a
        // scope-only rebind. The draft must survive without any injected keys.
        await tmux('send-keys', '-l', '-t', pane, 'preserved restore draft')
        await wait(screen, /preserved restore draft/)
        const input = new PaneInput(original.target), draft = await input.snapshot()
        const controlEnv = { ...env, CODEX_THREAD_ID: original.thread }
        await exec(entry, ['off'], { cwd: project, env: controlEnv })
        const rebound = await readRuntime(), after = await input.snapshot()
        assert.equal(rebound.thread, original.thread)
        assert.notEqual(rebound.pid, replacement.pid)
        assert.deepEqual(rebound.reload.options, replacement.reload.options)
        assert.equal(after.lines[after.y], draft.lines[draft.y])
        assert.equal(after.x, draft.x)
        // Force normal restore completion between on's last worker lookup and
        // request delivery. Capture real ps output before clearing the draft.
        const raceBin = join(dir, 'on-race-bin'), witness = join(dir, 'on-race.json')
        await mkdir(raceBin)
        await writeFile(join(raceBin, 'ps'), `#!/usr/bin/env python3
import sys,subprocess,pathlib,time,json,os
args=sys.argv[1:]
result=subprocess.run(['/usr/bin/ps']+args,capture_output=True,text=True)
if '-p' in args and args[args.index('-p')+1]==${JSON.stringify(String(rebound.pid))}:
    file=pathlib.Path(${JSON.stringify(witness)})
    calls=json.loads(file.read_text())['calls']+1 if file.exists() else 1
    data={'calls':calls}
    if calls==2:
        assert result.returncode==0 and '__row' in result.stdout
        subprocess.run(['tmux','-S',${JSON.stringify(socket)},'send-keys','-t',${JSON.stringify(pane)},'C-e','C-u'],check=True)
        until=time.monotonic()+6
        while (os.path.exists(${JSON.stringify(join(stateDirectory, activeFile))}) or os.path.exists('/proc/${rebound.pid}/exe')) and time.monotonic()<until: time.sleep(0.01)
        data['completed']=not os.path.exists(${JSON.stringify(join(stateDirectory, activeFile))}) and not os.path.exists('/proc/${rebound.pid}/exe')
        assert data['completed'], 'restore helper did not finish'
    file.write_text(json.dumps(data))
sys.stdout.write(result.stdout)
sys.stderr.write(result.stderr)
sys.exit(result.returncode)
`, { mode: 0o700 })
        await exec(entry, ['on'], { cwd: project, env: { ...controlEnv, PATH: raceBin + ':' + process.env.PATH } })
        const resumed = await readRuntime()
        assert.equal(JSON.parse(await readFile(witness, 'utf8')).completed, true)
        assert.notEqual(resumed.pid, rebound.pid)
        assert.equal(resumed.thread, original.thread)
        assert.deepEqual(resumed.target, original.target)
        assert.deepEqual(resumed.reload.options, replacement.reload.options)
        assert.equal((await readdir(stateDirectory)).includes(rebound.token + '.request'), false)
        console.log('RESTORE_ON_COMPLETION', JSON.stringify({ before: rebound.pid, after: resumed.pid,
          options: resumed.reload.options, witness: JSON.parse(await readFile(witness, 'utf8')) }))
        await wait(row, new RegExp('token:' + expectedTokens.replace('.', '\\.')))
        assert.doesNotMatch(await row(), /session:/)
        await submit(command('off'))
      }
      await wait(async () => String((await readdir(footerDir)).length), /^0$/)
      await wait(async () => String((await readdir(stateDirectory)).filter(name => name.endsWith('.json')).length), /^0$/)
      assert.equal(await row(), '')
      assert.equal(await readFile(join(cfg, 'config.toml'), 'utf8'), savedConfig)
      assert.equal(posts, afterTurn)
      console.log('ROOT_RESTORED', JSON.stringify({ original: original.thread, replacement: replacement.thread,
        explicitOff: selection === null, pending: (await readdir(footerDir)).length, providerPosts: posts }))
      await submit(command('on', '--socket ' + quote(socket) + ' --pane ' + pane))
      await wait(row, new RegExp('token:' + expectedTokens.replace('.', '\\.')))
    }
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
    for (const pid of (await readdir('/proc')).filter(p => /^\d+$/.test(p))) {
      try {
        const fs = await import('node:fs/promises')
        const exe = await fs.readlink('/proc/' + pid + '/exe')
        const args = (await fs.readFile('/proc/' + pid + '/cmdline', 'utf8')).split('\0')
        if (exe.startsWith(cfg + '/packages/') && exe.endsWith(' (deleted)') && args.slice(1,4).join(' ') === 'app-server daemon pid-update-loop') process.kill(Number(pid),'SIGTERM')
      } catch {}
    }
  }
})
