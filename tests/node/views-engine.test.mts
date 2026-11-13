import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { PaneInput } from '../../src/outputs/tmux/input.ts'

const exec = promisify(execFile)
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"

const crowdedSelection = ['current-dir', 'model-with-reasoning', 'five-hour-limit', 'weekly-limit', 'context-used', 'approval-mode', 'permissions', 'run-state', 'git-branch', 'branch-changes']
for (const fixture of [
  { initialPrompt: '', selection: ['session-id'], crowded: false },
  { initialPrompt: '', selection: crowdedSelection, crowded: true },
  { initialPrompt: '', selection: ['thread-id', ...crowdedSelection], crowded: true },
  { initialPrompt: '', selection: ['thread-name'], crowded: false },
]) test(`official Codex follows sibling views and restores them on visit${fixture.crowded ? ' (crowded fullscreen footer, cold config' + (fixture.selection[0] === 'thread-id' ? ', full ID' : '') + ')' : fixture.selection[0] === 'thread-name' ? ' (quoted title)' : ''}`, { timeout: 90000 }, async () => {
  const { initialPrompt, selection, crowded } = fixture
  const quotedTitle = !crowded && selection[0] === 'thread-name'
  const columns = crowded ? 177 : 157
  const dir = await mkdtemp(join(tmpdir(), 'vargus-standalone-test-'))
  const cfg = join(dir, 'codex'), project = join(dir, 'project'), temporary = join(dir, 'tmp')
  for (const folder of [cfg, project, temporary]) await mkdir(folder)
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: cfg, TMPDIR: temporary, VARGUS_LOCAL_TEST_KEY: 'local-test-only',
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', TMUX: '', TMUX_PANE: '' }
  const configReads = join(dir, 'config-reads.log')
  const gitStatusReads = join(dir, 'git-status-reads.log')
  if (crowded) {
    const shim = join(dir, 'bin'); await mkdir(shim)
    const codex = (await exec('which', ['codex'])).stdout.trim()
    const git = (await exec('which', ['git'])).stdout.trim()
    await writeFile(join(shim, 'codex'), `#!/usr/bin/env python3
import sys,time,os
if sys.argv[1:3] == ['app-server','--stdio']:
    with open(${JSON.stringify(configReads)}, 'a') as f: f.write(str(time.monotonic())+'\\n')
    time.sleep(1)
os.execv(${JSON.stringify(codex)}, ['codex']+sys.argv[1:])
`, { mode: 0o700 })
    await writeFile(join(shim, 'git'), `#!/usr/bin/env python3
import sys,time,os
with open(${JSON.stringify(gitStatusReads)}, 'a') as f: f.write(' '.join(sys.argv[1:])+'\\n')
if sys.argv[1:4] == ['-c','core.fsmonitor=false','status']:
    time.sleep(0.7)
os.execv(${JSON.stringify(git)}, ['git']+sys.argv[1:])
`, { mode: 0o700 })
    Object.assign(env, { PATH: shim + ':' + process.env.PATH })
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: project })
    await writeFile(join(project, 'lines.txt'), 'old\n'.repeat(327))
    const commit = () => exec('git', ['-c', 'user.name=Local fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qam', 'fixture'], { cwd: project })
    await exec('git', ['add', '.'], { cwd: project }); await commit()
    await exec('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: project })
    await exec('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], { cwd: project })
    await exec('git', ['checkout', '-qb', 'feat/codex-support'], { cwd: project })
    await writeFile(join(project, 'lines.txt'), 'new\n'.repeat(3958)); await commit()
  }
  const reads = async () => (await readFile(configReads, 'utf8')).trim().split('\n').filter(Boolean).length
  let posts = 0, spawned = false
  const provider = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.end('{}'); return }
    let text = ''; for await (const part of req) text += String(part)
    const request = JSON.parse(text)
    const title = request.text?.format !== undefined
    const id = `response_${++posts}`
    const call = !title && !spawned
    if (call) spawned = true
    const calls = ['first', 'second'].map(name => ({
      type: 'function_call', name: 'spawn_agent', namespace: 'collaboration', id: `fc_${name}`, call_id: `call_${name}`,
      arguments: JSON.stringify({ message: `${name.toUpperCase()}_CHILD local response.`, agent_type: 'default', task_name: crowded ? 'follow_test_' + name : name, fork_turns: 'none' }),
    }))
    const first = text.includes('FIRST_CHILD'), second = text.includes('SECOND_CHILD')
    // Child requests contain their own task marker; the parent's tool history contains both.
    const child = first && !second ? 'first' : second && !first ? 'second' : undefined
    console.log('MOCK_USAGE', JSON.stringify({ title, child, first, second }))
    const events = call ? [
      { type: 'response.created', response: { id } },
      ...calls.flatMap((item, index) => [
        { type: 'response.output_item.added', output_index: index, item: { ...item, arguments: '' } },
        { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: index, delta: item.arguments },
        { type: 'response.function_call_arguments.done', item_id: item.id, output_index: index, arguments: item.arguments },
        { type: 'response.output_item.done', output_index: index, item },
      ]),
      { type: 'response.completed', response: { id, usage: { input_tokens: 1000, output_tokens: 10, total_tokens: 1010 } } },
    ] : [
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `msg_${id}`,
        content: [{ type: 'output_text', text: title ? JSON.stringify({ title: quotedTitle ? 'Review `/root/first` details' : 'Local control test' }) : 'LOCAL CONTROL RESPONSE' }] } },
      { type: 'response.completed', response: { id, usage: { input_tokens: child === 'first' ? 8000 : child === 'second' ? 16000 : 42424, input_tokens_details: { cached_tokens: child ? 0 : 40000 },
        output_tokens: 777, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: child === 'first' ? 8777 : child === 'second' ? 16777 : 43201 } } },
    ]
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close',
      'x-codex-primary-used-percent': '27.5', 'x-codex-primary-window-minutes': '300',
      'x-codex-secondary-used-percent': '11', 'x-codex-secondary-window-minutes': '10080' })
    res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''))
  })
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
  const port = (provider.address() as { port: number }).port
  await writeFile(join(cfg, 'config.toml'), `model = "gpt-6.1-sol"
model_provider = "local_mock"
model_reasoning_effort = "${crowded ? 'xhigh' : 'low'}"
model_context_window = 200000
check_for_update_on_startup = false
[tui]
${selection === null ? '' : 'status_line = ' + JSON.stringify(selection)}
screen_reader_detection_done = true
fullscreen_transcript = ${crowded}
status_line_use_colors = true
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
  let client: ReturnType<typeof spawn> | undefined
  const screen = () => tmux('capture-pane', '-p', '-t', pane)
  const row = async () => {
    try { return (await tmux('show-options', '-p', '-v', '-t', pane, '@vargus_line')).replace(/#\[[^\]]*\]/g, '') } catch { return '' }
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
      await wait(async () => {
        const value = await activity()
        return /^\s*Worked for /m.test(value) && !/^• (?:Running|Working) /m.test(value) ? 'idle' : 'busy'
      }, /^idle$/)
      assert.doesNotMatch(await activity(), /^• (?:Running|Working) /m)
    }
  }
  const command = (action: string, extra = '') => '!' + (crowded ? 'PATH=' + quote(env.PATH!) + ' ' : '') + 'COLUMNS=80 ' + quote(resolve('bin/vargus')) + ' ' + action + (extra ? ' ' + extra : '')
  try {
    // This daemon starts outside tmux: !command must not rely on inherited pane variables.
    await exec('codex', ['app-server', 'daemon', 'start'], { env })
    await tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'test', '-x', String(columns), '-y', '53', 'sleep 120')
    pane = await tmux('display-message', '-p', '#{pane_id}')
    await tmux('set-window-option', 'remain-on-exit', 'on')
    before = await tmux('show-options', '-t', 'test')
    client = spawn('script', ['-q', '-f', '-c', 'stty cols ' + columns + ' rows 53; exec tmux -S ' + quote(socket) + ' attach-session -t test', join(dir,'physical.log')], { env: { ...env, TERM:'xterm-256color' }, stdio:['pipe','ignore','ignore'] })
    await delay(300)

    const launch = ['env', `CODEX_HOME=${cfg}`, `TMPDIR=${temporary}`, 'VARGUS_LOCAL_TEST_KEY=local-test-only',
      'NO_PROXY=127.0.0.1,localhost', 'no_proxy=127.0.0.1,localhost', `PATH=${env.PATH}`, 'codex', ...(crowded ? [] : ['--no-alt-screen']), '-C', project].map(quote).join(' ')
    await tmux('respawn-pane', '-k', '-t', pane, launch + (initialPrompt ? ' ' + quote(initialPrompt) : ''))
    await wait(screen, /Ask Codex/)
    await delay(1000)
    const savedConfig = await readFile(join(cfg, 'config.toml'), 'utf8')
    const controlRoot = join(temporary, `vargus-control-${process.getuid?.() ?? 'user'}`)
    const records = async () => {
      const values: any[] = []
      for (const name of await readdir(controlRoot)) if (name.endsWith('.json')) {
        try { values.push(JSON.parse(await readFile(join(controlRoot, name), 'utf8'))) } catch (e) { if ((e as any).code !== 'ENOENT') throw e }
      }
      return values
    }
    const pending = async (thread: string) => {
      for (const name of await readdir(join(controlRoot, 'footers'))) {
        try {
          if (JSON.parse(await readFile(join(controlRoot, 'footers', name), 'utf8')).thread === thread) return 'pending'
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
      return 'restored'
    }
    const activation = '--socket ' + quote(socket)
    await submit(command('on', activation))
    await wait(row, /session:/)
    assert.equal(posts, 0)
    let active = (await records())[0]
    assert.equal(active.version, 7)
    if (!crowded) {
      const fake = join(dir, 'fake'), trace = join(dir, 'ps-trace.jsonl')
      await mkdir(fake)
      await writeFile(join(fake, 'ps'), `#!/usr/bin/env python3
import sys,time,os,pathlib,json
if '-p' in sys.argv:
    p=pathlib.Path(${JSON.stringify(controlRoot)})
    # Hold the request-loop liveness read until cleanup finishes. Startup
    # liveness reads have no request lock and must continue immediately.
    gated=bool(list(p.glob('*.request.lock')))
    until=time.monotonic()+5
    while gated and list(p.glob('*.json')) and time.monotonic()<until:
        time.sleep(0.02)
    with open(${JSON.stringify(trace)},'a') as f:
        f.write(json.dumps({'replies':[x.name for x in p.glob('*.reply')],'records':[x.name for x in p.glob('*.json')]})+'\\n')
os.execv('/usr/bin/ps',['ps']+sys.argv[1:])
  `, { mode: 0o700 })
      await exec(resolve('bin/vargus'), ['off'], { cwd: project, env: { ...env, CODEX_THREAD_ID: active.thread, PATH: fake + ':' + process.env.PATH } })
      const observations = (await readFile(trace, 'utf8')).trim().split('\n').map(l => JSON.parse(l))
      assert.ok(observations.some(o => o.replies.length > 0 && o.records.length === 0), 'reply must be present after helper exit in the forced acknowledgement race')
      await submit(command('on', activation))
      active = (await records())[0]
    }
    const readsBeforeVisits = crowded ? await reads() : 0
    await submit('Use two subagents for this local fixture.')
    await wait(screen, /LOCAL CONTROL RESPONSE/)
    await wait(row, /token:4\.2k/)
    assert.match(await wait(row, /🤖2/), /sol:/)
    assert.doesNotMatch(await row(), /gpt-6\.1-sol/)
    await delay(1000)
    const metas: any[] = []
    for (const name of await readdir(join(cfg, 'sessions'), { recursive: true })) if (name.endsWith('.jsonl')) {
      const first = (await readFile(join(cfg, 'sessions', name), 'utf8')).split('\n')[0]!
      metas.push(JSON.parse(first).payload)
    }
    const children = metas.filter(m => m.source?.subagent?.thread_spawn?.parent_thread_id === active.thread)
    assert.equal(children.length, 2)
    const expected = new Map(children.map(m => {
      const path = m.source.subagent.thread_spawn.agent_path
      return [path, { id: m.id, tokens: path.endsWith('first') ? '8.8k' : '16.8k' }]
    }))
    const afterTurns = posts
    assert.ok(afterTurns > 0, 'positive control: real turns reached the same mock provider')
    if (quotedTitle) {
      for (let cycle = 0; cycle < 2; cycle++) {
        await submit(command('off'))
        await wait(async () => String((await records()).length), /^0$/)
        assert.deepEqual(await readdir(join(controlRoot, 'footers')), [])
        assert.match(await screen(), /Review `\/root\/first` details · Main \[default\]/)
        assert.equal(await row(), '')
        if (!cycle) {
          await submit(command('on', activation))
          await wait(row, /token:4\.2k/)
          assert.equal((await records())[0].selected, active.thread)
          assert.equal((await readdir(join(controlRoot, 'footers'))).length, 1, 'the title must not create a child backup')
        }
      }
      assert.equal(await readFile(join(cfg, 'config.toml'), 'utf8'), savedConfig)
      assert.equal(posts, afterTurns)
      return
    }
    const childFooter = async () => {
      const text = await screen(), at = text.lastIndexOf('Viewing sub-agent')
      return at < 0 ? '' : text.slice(at)
    }
    const physicalOffset = (await readFile(join(dir, 'physical.log'), 'utf8')).length
    const visited = new Set<string>()
    let lastPath = ''
    for (let i = 0; i < 2; i++) {
      await tmux('send-keys', '-t', pane, 'M-Left')
      if (crowded && i === 0) {
        await delay(1100)
        const gitCalls = (await readFile(gitStatusReads, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
        const delayedGitStatuses = gitCalls.filter(line => line.startsWith('-c core.fsmonitor=false status ')).length
        console.log('FIRST_CROWDED_SWITCH', JSON.stringify({ screen: await screen(), record: await records(), configReads: await reads(), delayedGitStatuses }))
        assert.ok(delayedGitStatuses > 0, 'the VArgus Git status delay must actually fire')
      }
      const childScreen = await wait(async () => {
        const value = await childFooter()
        return lastPath && value.includes('`' + lastPath + '`') ? '' : value
      }, /`(\/root\/(?:follow_test_)?(?:first|second))`/)
      const path = childScreen.match(/`(\/root\/(?:follow_test_)?(?:first|second))`/)![1]!
      lastPath = path
      const value = expected.get(path)!
      await wait(row, new RegExp('token:' + value.tokens.replace('.', '\\.')))
      assert.doesNotMatch(await row(), /🤖\d+/, 'a child view must not inherit the parent spawn count')
      await delay(300)
      assert.doesNotMatch((await screen()).slice((await screen()).lastIndexOf('Viewing sub-agent')), new RegExp(value.id))
      if (crowded) assert.doesNotMatch(await childFooter(), /GPT-6\.1-Sol|Context \d+% used/, 'configured native footer must be hidden on the first visit')
      assert.equal((await records())[0].selected, value.id)
      if (!crowded) {
        await tmux('send-keys', '-l', '-t', pane, 'a child draft')
        await delay(1400)
        const held = (await records())[0]
        assert.equal(held.selected, undefined, 'typing cannot prove that the current view is the parent')
        assert.equal(held.paused.thread, value.id)
        assert.doesNotMatch(await row(), /\[paused:/)
        assert.match(await row(), new RegExp('token:' + value.tokens.replace('.', '\\.')))
        assert.doesNotMatch(await row(), /🤖\d+/)
        await tmux('resize-window', '-t', 'test', '-x', '24', '-y', '53')
        await delay(1200)
        assert.equal((await records())[0].selected, undefined)
        assert.equal((await records())[0].paused.thread, value.id)
        await tmux('resize-window', '-t', 'test', '-x', String(columns), '-y', '53')
        await delay(1200)
        assert.match(await row(), new RegExp('token:' + value.tokens.replace('.', '\\.')))
        assert.equal(posts, afterTurns)
        console.log('PAUSED_CHILD', JSON.stringify({ child: value.id, path, tokens: value.tokens, held: held.paused,
          selected: held.selected, providerPosts: posts }))
        await tmux('send-keys', '-t', pane, 'C-e'); await delay(100)
        await tmux('send-keys', '-t', pane, 'C-u')
        await wait(async () => (await records())[0]?.selected ?? '', new RegExp('^' + value.id + '$'))
        await wait(row, new RegExp('token:' + value.tokens.replace('.', '\\.')))
        assert.equal((await records())[0].paused, undefined)
        assert.doesNotMatch(await row(), /\[paused:/)
      }
      visited.add(path)
    }
    assert.equal(visited.size, 2)
    if (!crowded) {
      const previous = (await records())[0]
      const footerDir = join(controlRoot, 'footers')
      const saved = new Map(await Promise.all((await readdir(footerDir)).map(async name => [name, await readFile(join(footerDir, name), 'utf8')] as const)))
      const result = await exec(resolve('bin/vargus'), ['reload'], { cwd: project, env: { ...env, CODEX_THREAD_ID: active.thread } })
      assert.match(result.stdout, /helper reloaded/)
      const replacement = (await records())[0]
      assert.notEqual(replacement.pid, previous.pid)
      assert.deepEqual(replacement.target, previous.target)
      assert.equal(replacement.thread, active.thread)
      assert.equal(replacement.selected, expected.get(lastPath)!.id)
      await wait(row, new RegExp('token:' + expected.get(lastPath)!.tokens.replace('.', '\\.')))
      assert.doesNotMatch(await row(), /🤖\d+/)
      for (const [name, content] of saved) assert.equal(await readFile(join(footerDir, name), 'utf8'), content)
      assert.equal(posts, afterTurns)
      active = replacement
    }
    const physical = (await readFile(join(dir, 'physical.log'), 'utf8')).slice(physicalOffset)
      .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\([0-9A-B])/g, '')
    assert.match(physical, /session:0m/)
    if (crowded) {
      assert.ok(readsBeforeVisits > 0, 'positive control: config/read helper was observed during activation')
      assert.equal(await reads(), readsBeforeVisits, 'first visits must use the preloaded workspace selection')
      for (let i = 0; i < 3; i++) {
        await tmux('send-keys', '-t', pane, 'M-Right'); await delay(500)
        if ((await screen()).includes('Main [default]')) break
      }
      await wait(row, /token:4\.2k/)
      await submit(command('off'))
      await wait(row, /^$/)
      await submit('/exit')
      await wait(() => tmux('display-message', '-p', '-t', pane, '#{pane_dead}'), /^1$/)
      await wait(async () => String((await records()).length), /^0$/)
      // The worker removes its runtime record before finishing backup cleanup.
      await wait(async () => String((await readdir(join(controlRoot, 'footers'))).length), /^0$/)
      assert.deepEqual(await readdir(join(controlRoot, 'footers')), [])
      assert.equal(await readFile(join(cfg, 'config.toml'), 'utf8'), savedConfig)
      assert.equal(posts, afterTurns)
      console.log(JSON.stringify({ crowdedFirstVisits: [...visited], configReadsBeforeVisits: readsBeforeVisits, configReadsAfterVisits: await reads(), providerCalls: posts }))
      return
    }
    // Losing a saved log blanks readings without killing the pane controller.
    const missing = children.find(m => m.source.subagent.thread_spawn.agent_path === lastPath)!
    const relative = (await readdir(join(cfg, 'sessions'), { recursive: true })).find(n => n.endsWith('-' + missing.id + '.jsonl'))!
    const transcript = join(cfg, 'sessions', relative), held = join(dir, 'held.jsonl')
    await rename(transcript, held)
    await wait(row, /^$/)
    await wait(async () => (await records())[0]?.error ?? '', /ENOENT/)
    await delay(400)
    assert.match((await records())[0].error, /ENOENT/)
    await rename(held, transcript)
    await wait(row, new RegExp('token:' + expected.get(lastPath)!.tokens.replace('.', '\\.')))
    // A narrow pane that clips the contextual identity must blank rather than guess.
    await tmux('resize-window', '-t', 'test', '-x', '24', '-y', '40')
    await wait(row, /^$/)
    await wait(async () => (await records())[0]?.selected ?? '', /^$/)
    await tmux('resize-window', '-t', 'test', '-x', String(columns), '-y', '53')
    await wait(row, /token:/)
    // Return to the parent; its native override and its own metrics survive both children.
    for (let i = 0; i < 3; i++) {
      await tmux('send-keys', '-t', pane, 'M-Right')
      await delay(500)
      if ((await screen()).includes('Main [default]')) break
    }
    await wait(row, /token:4\.2k/)
    const parentFooter = (await screen()).slice((await screen()).lastIndexOf('Ask Codex'))
    assert.doesNotMatch(parentFooter, new RegExp(active.thread))
    // Leave a real draft in the parent. Off removes the row and defers restoration.
    await tmux('send-keys', '-l', '-t', pane, 'A preserved draft')
    await delay(200)
    const draft = await new PaneInput(active.target).snapshot()
    const control = (action: string) => exec(resolve('bin/vargus'), [action], { cwd: project, env: { ...env, CODEX_THREAD_ID: active.thread } })
    assert.match((await control('off')).stdout, /VArgus is off;.*pending restoration/)
    await wait(row, /^$/)
    const afterDraft = await new PaneInput(active.target).snapshot()
    assert.equal(afterDraft.lines[afterDraft.y], draft.lines[draft.y])
    assert.equal(afterDraft.x, draft.x)
    assert.equal((await records())[0].mode, 'restore')
    // Re-enable while restoration is pending; original per-view backups survive.
    await tmux('send-keys', '-t', pane, 'End', 'C-u')
    await control('on')
    await wait(row, /token:4\.2k/)
    assert.equal((await records())[0].pid, active.pid)
    assert.deepEqual(JSON.parse(await readFile(join(controlRoot, 'footers', (await readdir(join(controlRoot, 'footers')))[0]!), 'utf8')).selection, selection)
    await control('off')
    await wait(row, /^$/)
    await wait(screen, new RegExp(active.thread))
    await wait(() => pending(active.thread), /^restored$/)
    // Visiting each child restores only its own saved selection. The helper then exits.
    lastPath = ''
    for (let i = 0; i < 2; i++) {
      await tmux('send-keys', '-t', pane, 'M-Left')
      const childScreen = await wait(async () => {
        const value = await childFooter()
        return lastPath && value.includes('`' + lastPath + '`') ? '' : value
      }, /`(\/root\/(?:follow_test_)?(?:first|second))`/)
      const path = childScreen.match(/`(\/root\/(?:follow_test_)?(?:first|second))`/)![1]!
      lastPath = path
      await wait(screen, new RegExp(expected.get(path)!.id))
      await wait(() => pending(expected.get(path)!.id), /^restored$/)
      assert.equal(await row(), '')
    }
    await wait(async () => String((await records()).length), /^0$/)
    assert.deepEqual(await readdir(join(controlRoot, 'footers')), [])
    assert.equal(posts, afterTurns)
    assert.equal(await readFile(join(cfg, 'config.toml'), 'utf8'), savedConfig)
    assert.equal(await tmux('show-options', '-t', 'test'), before)
    console.log(JSON.stringify({ providerPostsBeforeControls: 0, providerPostsAfterTurns: afterTurns, finalProviderPosts: posts, visitedPaths: [...visited], helperExited: true }))
  } finally {
    await tmux('kill-server').catch(() => {})
    client?.kill('SIGTERM')
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
