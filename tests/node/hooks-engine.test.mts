import WebSocket from 'ws'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

const exec = promisify(execFile)
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"

async function daemonRpc(method: string, params: unknown, env: NodeJS.ProcessEnv, cwd: string): Promise<any> {
  const socket = new WebSocket('ws+unix://' + join(env.CODEX_HOME!, 'app-server-control', 'app-server-control.sock') + ':/')
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(method + ' timed out')), 10000)
      const fail = (error: Error) => { clearTimeout(timer); reject(error) }
      socket.once('error', fail); socket.once('close', () => fail(new Error('Daemon connection closed')))
      const send = (id: number, method: string, params: unknown) => socket.send(JSON.stringify({ id, method, params }))
      socket.on('message', data => {
        const reply = JSON.parse(data.toString())
        if (reply.error) return fail(new Error(reply.error.message))
        if (reply.id === 1) {
          socket.send(JSON.stringify({ method: 'initialized' }))
          send(2, method, params)
        }
        if (reply.id === 2) { clearTimeout(timer); resolve(reply.result) }
      })
      socket.once('open', () => send(1, 'initialize', { clientInfo: { name: 'vargus-hook-migration', version: '0.1.0' } }))
    })
  } finally { socket.close() }
}

for (const { identity, migration } of [
  { identity: true, migration: false },
  { identity: false, migration: false },
  { identity: true, migration: true },
]) test(`official Codex SessionStart ${migration ? 'refreshes cached hooks before removing the retired options file' : identity ? 'broadcast activates in shared-daemon mode and respects manual off' : 'skips without an explicit full-ID footer'}`, { timeout: 90000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-hooks-test-'))
  const cfg = join(dir, 'codex'), project = join(dir, 'project'), temporary = join(dir, 'tmp')
  for (const folder of [cfg, project, temporary]) await mkdir(folder)
  const env = { ...process.env, CODEX_HOME: cfg, TMPDIR: temporary, VARGUS_LOCAL_TEST_KEY: 'local-test-only',
    TMUX_TMPDIR: dir, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', TMUX: '', TMUX_PANE: '', CODEX_THREAD_ID: 'stale-parent-thread' }
  let posts = 0
  const requests: any[] = []
  const provider = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.end('{}'); return }
    let text = ''; for await (const part of req) text += String(part)
    const request = JSON.parse(text); requests.push(request)
    const title = request.text?.format !== undefined
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
status_line = ${JSON.stringify(identity ? ['model-with-reasoning', 'current-dir', 'session-id'] : ['model-with-reasoning', 'current-dir'])}
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
  const tmuxDirectory = join(dir, `tmux-${process.getuid?.() ?? 'user'}`)
  await mkdir(tmuxDirectory, { mode: 0o700 })
  const socket = join(tmuxDirectory, 'default')
  const tmux = async (...args: string[]) => (await exec('tmux', ['-S', socket, ...args], { env })).stdout.replace(/\n$/, '')
  let pane = ''
  const screen = () => tmux('capture-pane', '-p', '-t', pane)
  const row = async () => {
    try { return await tmux('show-options', '-p', '-v', '-t', pane, '@vargus_line') } catch { return '' }
  }
  let newThreadChoice = false
  const wait = async (read: () => Promise<string>, match: RegExp) => {
    let got = '', until = Date.now() + 12000
    do {
      if (newThreadChoice && (await screen()).includes('Where should the new conversation run?')) {
        newThreadChoice = false
        await tmux('send-keys', '-t', pane, 'Enter')
      }
      got = await read()
      if (match.test(got)) { newThreadChoice = false; return got }
      await delay(100)
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
      const until = Date.now() + 3000
      while (/^• (?:Running|Working) /m.test(await activity()) && Date.now() < until) await delay(50)
      assert.doesNotMatch(await activity(), /^• (?:Running|Working) /m)
    }
  }
  const command = (action: string, extra = '') => '!COLUMNS=80 ' + quote(resolve('bin/vargus')) + ' ' + action + (extra ? ' ' + extra : '')
  let seededId: string | undefined, seededPath: string | undefined
  try {
    if (identity) {
      // Model one existing persisted turn, then the session-suffixed history
      // layout observed in the real user session. Only this scratch DB is edited.
      const client = spawn('codex', ['app-server', '--stdio'], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] })
      const lines = createInterface({ input: client.stdout }), notifications: any[] = []
      const pending = new Map<number, (reply: any) => void>(); let next = 0, errors = ''
      client.stderr.on('data', data => { errors += data })
      lines.on('line', line => { const reply = JSON.parse(line); const done = pending.get(reply.id); if (done) { pending.delete(reply.id); done(reply) } else notifications.push(reply) })
      const rpc = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
        const id = ++next, timer = setTimeout(() => reject(new Error(method + ' seed timed out: ' + errors)), 10000)
        pending.set(id, reply => { clearTimeout(timer); reply.error ? reject(new Error(reply.error.message)) : resolve(reply.result) })
        client.stdin.write(JSON.stringify({ id, method, params }) + '\n')
      })
      try {
        await rpc('initialize', { clientInfo: { name: 'vargus-alias-seed', version: '0.1.0' } })
        const started = await rpc('thread/start', { cwd: project, approvalPolicy: 'never', sandbox: 'danger-full-access' })
        seededId = started.thread.id
        const { turn } = await rpc('turn/start', { threadId: seededId, input: [{ type: 'text', text: 'Seed the saved history fixture.' }] })
        await wait(async () => JSON.stringify(notifications.filter(x => x.method === 'turn/completed')), new RegExp(turn.id))
        const read = await rpc('thread/read', { threadId: seededId, includeTurns: false })
        seededPath = read.thread.path
      } finally {
        const closed = once(client, 'exit'); client.stdin.end(); await closed; lines.close()
      }
      const original = seededPath!
      seededPath = original.replace(/\.jsonl$/, '_11111111-1111-1111-1111-111111111111.jsonl')
      await copyFile(original, seededPath)
      await exec('python3', ['-c', `import sqlite3,sys,pathlib
home=pathlib.Path(sys.argv[1]);assert home.name=='codex' and home.parent.name.startswith('vargus-hooks-test-')
files=list(home.glob('state_*.sqlite'));assert len(files)==1
c=sqlite3.connect(files[0]);r=c.execute('UPDATE threads SET rollout_path=? WHERE id=?',(sys.argv[3],sys.argv[2]));assert r.rowcount==1;c.commit();c.close()
`, cfg, seededId!, seededPath])
    }
    const beforeInitialPrompt = posts
    // This daemon starts outside tmux: !command must not rely on inherited pane variables.
    await exec('codex', ['app-server', 'daemon', 'start'], { env })
    await tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'test', '-x', '157', '-y', '40', 'sleep 120')
    pane = await tmux('display-message', '-p', '#{pane_id}')
    await tmux('set-window-option', 'remain-on-exit', 'on')
    const retiredOptions = join(cfg, 'vargus-options.json')
    if (migration) await writeFile(retiredOptions, JSON.stringify({ codexAutoStart: true }))
    const hookCommand = quote(resolve('bin/vargus')) + ' hook session-start --socket ' + quote(socket)
    const trace = join(dir, 'hook-result.json'), promptTrace = join(dir, 'prompt-result.json'), wrapper = join(dir, 'hook-wrapper.mjs')
    await writeFile(wrapper, `import {spawnSync} from 'node:child_process';import {writeFileSync} from 'node:fs';let raw='';for await(const p of process.stdin)raw+=p;const result=spawnSync(process.argv[2],process.argv.slice(3),{input:raw,encoding:'utf8'});writeFileSync(JSON.parse(raw).hook_event_name==='SessionStart'?${JSON.stringify(trace)}:${JSON.stringify(promptTrace)},JSON.stringify({code:result.status,stdout:result.stdout,stderr:result.stderr,input:JSON.parse(raw)}));process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exitCode=result.status??1;`)
    const callback = (command: string) => ({ type: 'command', command: quote(process.execPath) + ' ' + quote(wrapper) + ' ' + command, async: true, timeout: 30 })
    const hookDefinition = (command: string) => JSON.stringify({ hooks: {
      SessionStart: [{ matcher: '^(startup|resume|clear|fork)$', hooks: [callback(command)] }],
      UserPromptSubmit: [{ hooks: [callback(command.replace('hook session-start', 'hook prompt'))] }],
    } })
    await writeFile(join(cfg, 'hooks.json'), hookDefinition(hookCommand + (migration ? ' --config ' + quote(retiredOptions) : '')))
    const launch = ['env', `CODEX_HOME=${cfg}`, `TMPDIR=${temporary}`, 'VARGUS_LOCAL_TEST_KEY=local-test-only',
      'NO_PROXY=127.0.0.1,localhost', 'no_proxy=127.0.0.1,localhost', 'codex', '--no-alt-screen', '-C', project].map(quote).join(' ')
    await tmux('respawn-pane', '-k', '-t', pane, launch + (seededId ? ' resume ' + quote(seededId) : ''))
    await wait(screen, /Trust all and continue/)
    await tmux('send-keys', '-t', pane, 'Down', 'Enter')
    await wait(screen, /Ask Codex/)
    await delay(700)
    const footer = async () => {
      const text = await screen()
      return text.slice(text.lastIndexOf('Ask Codex to do anything') + 'Ask Codex to do anything'.length)
    }
    const footerMatches = identity ? /sol.*project.*[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i : /sol.*project/i
    await wait(footer, footerMatches)
    const savedConfig = await readFile(join(cfg, 'config.toml'), 'utf8')
    assert.equal(await row(), '')
    assert.equal(posts, beforeInitialPrompt)
    await submit('Run the hook activation fixture.')
    await wait(screen, /LOCAL CONTROL RESPONSE/)
    await wait(async () => { try { return await readFile(trace, 'utf8') } catch { return '' } }, /"code":0/)
    const hookResult = JSON.parse(await readFile(trace, 'utf8'))
    assert.equal(hookResult.stdout, ''); assert.equal(hookResult.stderr, '')
    if (!identity) {
      assert.match(await readFile(join(cfg, 'config.toml'), 'utf8'), /trusted_hash/)
      assert.equal(await row(), '')
      await wait(footer, footerMatches)
      console.log('NO_ID_HOOK_SKIPPED', JSON.stringify(hookResult))
      await submit('/exit')
      await wait(() => tmux('display-message', '-p', '-t', pane, '#{pane_dead}'), /^1$/)
      return
    }
    assert.match(await readFile(join(cfg, 'config.toml'), 'utf8'), /trusted_hash/)
    await wait(row, /sol:low/)
    await wait(footer, /for shortcuts/)
    let hookedPosts = posts
    assert.ok(hookedPosts > 0, 'ordinary prompt reaches the localhost provider')
    const runtimeDir = join(temporary, `vargus-control-${process.getuid?.() ?? 'user'}`)
    await wait(async () => JSON.stringify((await readdir(runtimeDir)).filter(name => name.endsWith('.json'))), /\.json/)
    const runtime = (await readdir(runtimeDir)).filter(name => name.endsWith('.json'))
    assert.equal(runtime.length, 1)
    const state = JSON.parse(await readFile(join(temporary, `vargus-control-${process.getuid?.() ?? 'user'}`, runtime[0]!), 'utf8'))
    assert.notEqual(state.thread, env.CODEX_THREAD_ID, 'hook must replace inherited thread identity')
    assert.equal(state.transcript, seededPath, 'the helper must use the current suffixed history')
    assert.equal(state.thread, seededId)
    console.log('SUFFIXED_TRANSCRIPT_ACTIVE', JSON.stringify({ thread: state.thread, path: state.transcript }))
    const runtimePath = join(runtimeDir, runtime[0]!)
    await submit('/statusline model-with-reasoning current-dir session-id')
    await wait(footer, footerMatches)
    const staleEvent = { ...hookResult.input, transcript_path: seededPath!.replace('_11111111-1111-1111-1111-111111111111', '') }
    const stale = exec(process.execPath, [resolve('dist/cli.mjs'), 'hook', 'prompt', '--socket', socket], {
      cwd: project, env: { ...env, VARGUS_CLI_MAIN: '1' },
    })
    stale.child.stdin!.end(JSON.stringify({ ...staleEvent, hook_event_name: 'UserPromptSubmit' }))
    assert.equal((await stale).stdout, '')
    await wait(footer, footerMatches)
    assert.equal(JSON.parse(await readFile(runtimePath, 'utf8')).transcript, seededPath)
    const controlOn = () => exec(resolve('bin/vargus'), ['on', '--socket', socket, '--pane', pane], {
      cwd: project, env: { ...env, CODEX_THREAD_ID: state.thread },
    })
    await controlOn()
    assert.equal(JSON.parse(await readFile(runtimePath, 'utf8')).pid, state.pid, 'same ID and path reuse the helper')
    const oldRecord = JSON.parse(await readFile(runtimePath, 'utf8')); delete oldRecord.transcript
    await writeFile(runtimePath, JSON.stringify(oldRecord))
    await controlOn()
    const replaced = JSON.parse(await readFile(runtimePath, 'utf8'))
    assert.notEqual(replaced.pid, state.pid, 'old workers without a known path must be replaced')
    assert.equal(replaced.transcript, seededPath)
    assert.equal(posts, hookedPosts, 'path/control migration makes no model request')
    await wait(footer, /for shortcuts/)
    assert.doesNotMatch(await screen(), /VArgus is on/, 'hook stdout must not become UI context')
    assert.ok(requests.some(r => JSON.stringify(r.input).includes('Run the hook activation fixture.')))
    // Keep the first TUI attached so this is a loaded-thread resume. Its
    // native ID is hidden, leaving only the resumed pane as a visible match.
    const initialPane = pane, initialStartTrace = await readFile(trace, 'utf8')
    if (migration) {
      await writeFile(join(cfg, 'hooks.json'), hookDefinition(hookCommand))
      const beforeRefresh = await readFile(join(cfg, 'config.toml'), 'utf8')
      await daemonRpc('config/batchWrite', { edits: [], reloadUserConfig: true }, env, project)
      assert.equal(await readFile(join(cfg, 'config.toml'), 'utf8'), beforeRefresh, 'empty refresh must not edit saved settings')
      const cached = await daemonRpc('hooks/list', { threadId: state.thread }, env, project)
      const hooks = cached.data[0].hooks
      assert.equal(hooks.length, 2)
      assert.ok(hooks.every((h: any) => !h.command.includes('--config') && h.trustStatus === 'modified'))
      await rm(retiredOptions)
      assert.equal((await readdir(cfg)).includes('vargus-options.json'), false)
      const beforeTrust = await readFile(promptTrace, 'utf8')
      await submit('Changed hooks awaiting trust review.')
      await wait(async () => JSON.stringify(requests), /Changed hooks awaiting trust review/)
      await wait(screen, /LOCAL CONTROL RESPONSE/)
      await delay(300)
      assert.equal(await readFile(promptTrace, 'utf8'), beforeTrust, 'modified hooks must skip instead of invoking the deleted config')
      console.log('CACHED_HOOKS_REFRESHED', JSON.stringify(cached))
    }
    pane = await tmux('new-window', '-d', '-P', '-F', '#{pane_id}', '-t', 'test', launch + ' resume ' + quote(state.thread))
    await tmux('set-window-option', '-t', pane, 'remain-on-exit', 'on')
    if (migration) {
      await wait(screen, /Trust all and continue/)
      await tmux('send-keys', '-t', pane, 'Down', 'Enter')
    }
    await wait(footer, footerMatches)
    await submit('Warm resumed conversation startup.')
    await wait(async () => { try { return await readFile(promptTrace, 'utf8') } catch { return '' } }, /Warm resumed conversation startup/)
    assert.equal(JSON.parse(await readFile(promptTrace, 'utf8')).code, 0)
    await wait(row, /sol:low/)
    await wait(footer, /for shortcuts/)
    assert.equal(await readFile(trace, 'utf8'), initialStartTrace, 'loaded resume must exercise prompt fallback without another SessionStart')
    console.log('WARM_RESUME_STARTED', JSON.stringify({ thread: state.thread, pane, source: 'UserPromptSubmit' }))
    await submit(command('off', '--socket ' + quote(socket) + ' --pane ' + quote(pane)))
    await wait(row, /^$/); await wait(footer, footerMatches)
    await submit('/exit')
    await wait(() => tmux('display-message', '-p', '-t', pane, '#{pane_dead}'), /^1$/)
    if (migration) {
      pane = initialPane
      await submit(command('off', '--socket ' + quote(socket) + ' --pane ' + quote(pane)))
      await wait(row, /^$/); await wait(footer, footerMatches)
      await submit('Original loaded frontend after hook migration.')
      await wait(async () => readFile(promptTrace, 'utf8'), /Original loaded frontend after hook migration/)
      const refreshed = JSON.parse(await readFile(promptTrace, 'utf8'))
      assert.equal(refreshed.code, 0, refreshed.stderr)
      assert.equal(refreshed.stdout, ''); assert.equal(refreshed.stderr, '')
      assert.equal(await row(), '', 'refreshed hooks preserve manual off')
      console.log('CACHED_HOOKS_MIGRATED', JSON.stringify({ thread: state.thread, removed: retiredOptions, result: refreshed }))
      await submit('/exit')
      await wait(() => tmux('display-message', '-p', '-t', pane, '#{pane_dead}'), /^1$/)
      return
    }
    pane = initialPane
    await exec('git', ['init', '-q', '-b', state.thread], { cwd: project })
    await exec('git', ['-c', 'user.name=Local fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: project })
    await writeFile(join(cfg, 'config.toml'), savedConfig.replace(/^status_line = .*$/m,
      'status_line = ["git-branch", "model-with-reasoning", "session-id"]'))
    pane = await tmux('new-window', '-d', '-P', '-F', '#{pane_id}', '-t', 'test', launch)
    await tmux('set-window-option', '-t', pane, 'remain-on-exit', 'on')
    await tmux('resize-window', '-t', pane, '-x', '85', '-y', '40')
    await wait(screen, /Ask Codex/)
    await submit('Native UUID branch collision fixture.')
    await wait(async () => { try { return await readFile(trace, 'utf8') } catch { return '' } }, new RegExp('"session_id":"(?!' + state.thread + ')[^"]+"'))
    const collisionResult = JSON.parse(await readFile(trace, 'utf8'))
    const actual = JSON.parse((await readFile(collisionResult.input.transcript_path, 'utf8')).split('\n')[0]!).payload.id
    assert.notEqual(actual, state.thread)
    const beforeCollision = await footer()
    assert.ok(beforeCollision.includes(state.thread), 'positive control: UUID branch is fully visible')
    assert.ok(beforeCollision.includes('…'), 'positive control: actual tail is clipped')
    assert.ok(!beforeCollision.includes(actual), 'actual complete session ID is not displayed')
    const postsBeforeReplay = posts
    const collisionReplay = exec(process.execPath, [resolve('dist/cli.mjs'), 'hook', 'session-start', '--socket', socket], {
      cwd: project, env: { ...env, VARGUS_CLI_MAIN: '1' },
    })
    collisionReplay.child.stdin!.end(JSON.stringify(hookResult.input))
    assert.equal((await collisionReplay).stdout, '')
    assert.equal(await row(), '', 'a clipped tail must not make the UUID branch select another thread')
    const collisionStates = await Promise.all((await readdir(runtimeDir)).filter(n => n.endsWith('.json')).map(async n => JSON.parse(await readFile(join(runtimeDir, n), 'utf8'))))
    assert.equal(collisionStates.some(r => r.target.pane === pane), false, 'the collision must not create a hidden binding either')
    assert.equal(await footer(), beforeCollision, 'collision rejection must leave the native footer unchanged')
    assert.equal(posts, postsBeforeReplay)
    console.log('UUID_BRANCH_COLLISION_REJECTED', JSON.stringify({ branch: state.thread, actual, pane, posts }))
    await submit('/exit')
    await wait(() => tmux('display-message', '-p', '-t', pane, '#{pane_dead}'), /^1$/)
    await writeFile(join(cfg, 'config.toml'), savedConfig)
    pane = initialPane; hookedPosts = posts
    await submit(command('off', '--socket ' + quote(socket)))
    await wait(row, /^$/); await wait(footer, footerMatches)
    assert.equal(posts, hookedPosts)
    const replay = exec(process.execPath, [resolve('dist/cli.mjs'), 'hook', 'session-start', '--socket', socket], {
      cwd: project, env: { ...env, VARGUS_CLI_MAIN: '1' },
    })
    replay.child.stdin!.end(JSON.stringify(hookResult.input))
    assert.equal((await replay).stdout, '')
    assert.equal(await row(), '', 'a delayed duplicate event cannot undo manual off')
    await submit('Run a second ordinary turn with VArgus off.')
    await wait(async () => JSON.stringify(requests), /Run a second ordinary turn with VArgus off/)
    assert.equal(await row(), '')
    assert.ok(posts > hookedPosts, 'later prompt was processed while automatic startup remained off')
    assert.ok(requests.every(r => !JSON.stringify(r.input).includes('VArgus is on')), 'hook stdout must not become model context on a later turn')
    assert.equal(await readFile(join(cfg, 'config.toml'), 'utf8'), savedConfig)
    console.log('HOOK_LIVE', JSON.stringify({ thread: state.thread, inherited: env.CODEX_THREAD_ID,
      hookedPosts, laterPosts: posts, manualOffPreserved: true }))
    await submit('/new')
    const pendingFooter = await wait(async () => {
      const value = await footer()
      return value.includes(state.thread) ? '' : value
    }, footerMatches)
    const pendingThread = pendingFooter.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/)![0]
    assert.notEqual(pendingThread, state.thread, 'new-thread off must not reuse the old thread callback')
    const beforePendingOff = posts
    await submit(command('off'))
    await wait(screen, /VArgus is off for this Codex thread/)
    assert.equal(posts, beforePendingOff)
    await submit('Process a first turn after unbound manual off.')
    await wait(async () => { try { return await readFile(trace, 'utf8') } catch { return '' } },
      new RegExp('"session_id":"' + pendingThread + '"'))
    const pendingResult = JSON.parse(await readFile(trace, 'utf8'))
    assert.equal(pendingResult.code, 0)
    assert.equal(pendingResult.input.session_id, pendingThread)
    await wait(async () => JSON.stringify(requests), /Process a first turn after unbound manual off/)
    assert.equal(await row(), '', 'a first SessionStart callback must preserve off before attachment')
    await wait(footer, footerMatches)
    console.log('PENDING_OFF_PRESERVED', JSON.stringify({ thread: pendingThread, posts }))
    const firstPane = pane
    pane = await tmux('new-window', '-d', '-P', '-F', '#{pane_id}', '-t', 'test', launch)
    await tmux('set-window-option', '-t', pane, 'remain-on-exit', 'on')
    await wait(screen, /Ask Codex/)
    await wait(footer, footerMatches)
    await submit('Activate only the second pane.')
    await wait(row, /sol:low/)
    assert.equal(await tmux('show-options', '-p', '-v', '-t', firstPane, '@vargus_line').catch(() => ''), '')
    await wait(footer, /for shortcuts/)
    await submit('/new')
    const newFooter = await wait(footer, footerMatches)
    const newThread = newFooter.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/)![0]
    await submit('Activate the new thread in the second pane.')
    await wait(async () => {
      const records = await readdir(runtimeDir)
      const rows = await Promise.all(records.filter(n => n.endsWith('.json')).map(n => readFile(join(runtimeDir, n), 'utf8')))
      return rows.join('\n')
    }, new RegExp('"thread":"' + newThread + '"'))
    await wait(row, /sol:low/)
    await wait(footer, /for shortcuts/)
    console.log('BROADCAST_REBIND', JSON.stringify({ firstPane, secondPane: pane, newThread }))
    await submit('/exit')
    await wait(() => tmux('display-message', '-p', '-t', pane, '#{pane_dead}'), /^1$/)

  } finally {
    await tmux('kill-server').catch(() => {})
    await exec('codex', ['app-server', 'daemon', 'stop'], { env }).catch(() => {})
    provider.closeAllConnections(); await new Promise<void>(done => provider.close(() => done()))
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
