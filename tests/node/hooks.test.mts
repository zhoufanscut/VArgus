import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hookSession, footerThread } from '../../src/hosts/codex/hooks'
import { DEFAULTS } from '../../src/options'

test('SessionStart derives identity from the transcript independently of creation metadata', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vargus-hook-input-'))
  try {
    await mkdir(join(home, 'sessions'))
    const file = join(home, 'sessions', 'rollout-date-current.jsonl')
    const meta = { type: 'session_meta', payload: { id: 'current', source: 'cli', originator: 'codex-tui' } }
    await writeFile(file, JSON.stringify(meta) + '\n')
    const event = { hook_event_name: 'SessionStart', source: 'startup', session_id: 'shared-session',
      transcript_path: file, cwd: '/current/workspace' }
    assert.equal(DEFAULTS.codexAutoStart, false)
    assert.deepEqual(await hookSession({ ...event, hook_event_name: 'UserPromptSubmit', source: undefined, prompt: 'unused' }, home, 'UserPromptSubmit'), { thread: 'current', cwd: '/current/workspace', transcript: await realpath(file) })
    for (const source of ['startup', 'resume', 'clear', 'fork']) {
      assert.deepEqual(await hookSession({ ...event, source }, home), { thread: 'current', cwd: '/current/workspace', transcript: await realpath(file) })
    }
    for (const extra of [{ source: 'compact' }, { hook_event_name: 'SubagentStart' }, { transcript_path: null }]) {
      assert.equal(await hookSession({ ...event, ...extra }, home), undefined)
    }
    for (const source of ['exec', 'vscode', { subagent: { thread_spawn: { parent_thread_id: 'parent' } } }]) {
      await writeFile(file, JSON.stringify({ ...meta, payload: { ...meta.payload, source, originator: 'another-frontend' } }) + '\n')
      assert.deepEqual(await hookSession(event, home), { thread: 'current', cwd: '/current/workspace', transcript: await realpath(file) })
    }
  } finally { await rm(home, { recursive: true, force: true }) }
})


for (const command of ['session-start', 'prompt']) test(`disabled ${command} exits without reading an unavailable transcript`, async () => {
  const child = spawn(process.execPath, [resolve('dist/cli.mjs'), 'hook', command], {
    env: { ...process.env, VARGUS_CLI_MAIN: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let output = '', errors = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { errors += data })
  child.stdin.end(JSON.stringify({ hook_event_name: command === 'prompt' ? 'UserPromptSubmit' : 'SessionStart', source: 'startup',
    transcript_path: '/unavailable/transcript.jsonl', cwd: '/unavailable' }))
  const [code] = await once(child, 'close')
  assert.equal(code, 0, errors); assert.equal(output, ''); assert.equal(errors, '')
})

const first = '01a1bdc7-7e98-7dd3-bfbf-0dd7710dcd91'
const second = '01a1bdc7-869e-78d0-a59c-bac2ec7bd0ae'
const fixtureScreen = (footer: string) => ({ lines: ['chat ' + second, '› \x1b[2mAsk Codex to do anything\x1b[0m', '', '  ' + footer],
  x: 2, y: 1, visible: true, command: 'codex' })

test('startup identity requires the complete ID below a live empty composer', () => {
  assert.equal(footerThread(fixtureScreen(first + ' · Sol')), first)
  assert.equal(footerThread(fixtureScreen('Sol · ' + first)), first)
  assert.equal(footerThread(fixtureScreen('folder · ' + first + ' · Main [default]')), first)
  assert.equal(footerThread(fixtureScreen(first + ' · ' + second)), undefined)
  assert.equal(footerThread(fixtureScreen('branch-' + first)), undefined)
  const collision = fixtureScreen(first + ' · Sol · ' + second.slice(0, 28) + '…')
  assert.equal(footerThread(collision), undefined, 'a clipped tail cannot turn the UUID branch into identity')
  assert.equal(footerThread(fixtureScreen(first + ' · Sol · clipped…'), true), first, 'known first-item layout keeps a complete prefix')
  assert.equal(footerThread(fixtureScreen('Sol · ' + first + ' · clipped…'), true), undefined)
  for (const footer of [first.slice(0, 29) + '…', 'Main [default]', '', second.slice(0, 32)]) {
    assert.equal(footerThread(fixtureScreen(footer)), undefined)
  }
  const screen = fixtureScreen(first)
  assert.equal(footerThread({ ...screen, lines: [...screen.lines, '  ← for agents · ? for shortcuts'] }), first)
  assert.equal(footerThread({ ...screen, visible: false }), undefined)
  assert.equal(footerThread({ ...screen, x: 7, lines: ['chat', '› draft', '', '  ' + first] }), undefined)
  assert.equal(footerThread({ ...screen, lines: [first, screen.lines[1]!, '', '  Sol'] }), undefined)
})

test('broadcast matches one exact pane, rejects duplicates and preserves manual off', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-hook-broadcast-'))
  const path = process.env.PATH
  const { startupTarget, startupControl, startupDirectory } = await import('../../src/cli/startup')
  try {
    const screens = join(dir, 'screens.json')
    const set = async (ids: string[]) => writeFile(screens, JSON.stringify(ids.map(id => fixtureScreen(id).lines)))
    await writeFile(join(dir, 'tmux'), `#!${process.execPath}
import{readFileSync}from'node:fs';const args=process.argv.slice(2);if(args.includes('list-panes'))console.log('/scratch/socket\\t%0\\t810000\\tcodex\\n/scratch/socket\\t%1\\t820000\\tcodex');else{const i=args.includes('%1')?1:0;console.log(JSON.parse(readFileSync(${JSON.stringify(screens)},'utf8'))[i].join('\\n')+'\\n2\\t1\\t157\\t1\\tcodex');}
`, { mode: 0o755 })
    await writeFile(join(dir, 'ps'), "#!/bin/sh\nprintf '%s\\n' '810000 1 bash' '810001 810000 codex' '820000 1 bash' '820001 820000 codex'\n", { mode: 0o755 })
    process.env.PATH = dir + ':' + path
    const target = { socket: '/scratch/socket', pane: '%0', pid: 810001 }
    await set([first, second])
    assert.deepEqual(await startupTarget(first), target, JSON.stringify(await new (await import('../../src/outputs/tmux/input')).PaneInput(target).snapshot()))
    assert.equal(await startupTarget(first, undefined, '%1'), undefined)
    assert.equal(await startupTarget('01a10000-0000-0000-0000-000000000000'), undefined, 'stale or detached thread has no matching pane')
    await set([first, first])
    assert.equal(await startupTarget(first), undefined)
    assert.equal(await startupTarget(first, undefined, '%0'), undefined, 'explicit pane does not bypass ambiguity')
    await set([first.slice(0, 29) + '…', second])
    assert.equal(await startupTarget(first), undefined)
    await set([first, second])
    const manualHome = join(dir, 'manual'); await mkdir(manualHome)
    let performed = false
    await startupControl(manualHome, target, first, 'on', false, async () => { performed = true; return 0 })
    assert.equal(performed, true)
    assert.deepEqual(await readdir(manualHome), [], 'manual control needs no new home writes before opting in')
    await mkdir(startupDirectory(dir), { recursive: true })
    let activated = 0
    const on = () => startupControl(dir, target, first, 'on', true, async () => ++activated)
    await startupControl(dir, target, first, 'off', false, async () => 0)
    await on(); assert.equal(activated, 0, 'delayed hook cannot undo off')
    await startupControl(dir, target, first, 'on', false, async () => 0)
    await on(); assert.equal(activated, 1, 'explicit on clears suppression')
    await writeFile(join(dir, 'ps'), "#!/bin/sh\nprintf '%s\\n' '810000 1 bash' '810002 810000 codex' '820000 1 bash' '820001 820000 codex'\n", { mode: 0o755 })
    assert.equal((await startupTarget(first))?.pid, 810002, 'positive control: same footer, replacement TUI PID')
    await on(); assert.equal(activated, 1, 'a matching ID cannot bypass the original TUI PID')
    await set([second, first])
    await on(); assert.equal(activated, 1, 'identity is rechecked inside the control lock')
  } finally {
    if (path === undefined) delete process.env.PATH
    else process.env.PATH = path
    await rm(dir, { recursive: true, force: true })
  }
})


test('ordinary off before first attachment suppresses a delayed automatic start', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-hook-pending-off-'))
  const previous = { PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME,
    TMPDIR: process.env.TMPDIR, CODEX_THREAD_ID: process.env.CODEX_THREAD_ID }
  const home = join(dir, 'codex')
  const { standalone } = await import('../../src/cli/codex')
  const { startupTarget, startupDirectory, startupControl } = await import('../../src/cli/startup')
  try {
    await mkdir(startupDirectory(home), { recursive: true })
    await writeFile(join(dir, 'tmux'), `#!${process.execPath}
const a=process.argv;if(a.includes('list-panes'))console.log('/scratch/socket\\t%0\\t810000\\tcodex');else console.log(${JSON.stringify(fixtureScreen(first).lines.join('\n'))}+'\\n2\\t1\\t157\\t1\\tcodex');
`, { mode: 0o755 })
    await writeFile(join(dir, 'ps'), "#!/bin/sh\nprintf '%s\\n' '810000 1 bash' '810001 810000 codex'\n", { mode: 0o755 })
    Object.assign(process.env, { PATH: dir + ':' + previous.PATH, CODEX_HOME: home, TMPDIR: dir, CODEX_THREAD_ID: first })
    const target = { socket: '/scratch/socket', pane: '%0', pid: 810001 }
    assert.deepEqual(await startupTarget(first), target)
    await standalone(['off'])
    let activations = 0
    await startupControl(home, target, first, 'on', true, async () => ++activations)
    assert.equal(activations, 0)
    assert.ok((await readdir(startupDirectory(home))).some(name => name.endsWith('.off')))
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(dir, { recursive: true, force: true })
  }
})


test('prompt fallback skips config reads when the native ID is hidden or off is remembered', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-hook-fast-'))
  const home = join(dir, 'home'), marker = join(dir, 'config-read'), display = join(dir, 'display.json')
  const { startupDirectory, startupControl } = await import('../../src/cli/startup')
  try {
    await mkdir(join(home, 'sessions'), { recursive: true })
    await mkdir(startupDirectory(home), { recursive: true })
    const transcript = join(home, 'sessions', `rollout-${first}.jsonl`)
    await writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: { id: first, cwd: dir, source: 'cli' } }) + '\n')
    const options = join(dir, 'options.json'); await writeFile(options, JSON.stringify({ codexAutoStart: true }))
    await writeFile(join(dir, 'tmux'), `#!${process.execPath}
const fs=require('node:fs');if(process.argv.includes('list-panes'))console.log('/scratch/socket\\t%0\\t810000\\tcodex');else console.log(JSON.parse(fs.readFileSync(${JSON.stringify(display)},'utf8')).join('\\n')+'\\n2\\t1\\t157\\t1\\tcodex');
`, { mode: 0o755 })
    await writeFile(join(dir, 'ps'), "#!/bin/sh\nprintf '%s\\n' '810000 1 bash' '810001 810000 codex'\n", { mode: 0o755 })
    await writeFile(join(dir, 'codex'), `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(marker)},'read\\n');process.exit(91);
`, { mode: 0o755 })
    const invoke = async () => {
      const child = spawn(process.execPath, [resolve('dist/cli.mjs'), 'hook', 'prompt', '--config', options], {
        env: { ...process.env, PATH: dir + ':' + process.env.PATH, CODEX_HOME: home, VARGUS_CLI_MAIN: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let out = '', err = ''; child.stdout.on('data', d => { out += d }); child.stderr.on('data', d => { err += d })
      child.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', transcript_path: transcript, cwd: dir }))
      const [code] = await once(child, 'close'); return { code, out, err }
    }
    const set = (id: string) => writeFile(display, JSON.stringify(fixtureScreen(id).lines))
    await set('for shortcuts')
    assert.deepEqual(await invoke(), { code: 0, out: '', err: '' })
    assert.equal((await readdir(dir)).includes('config-read'), false)
    const target = { socket: '/scratch/socket', pane: '%0', pid: 810001 }
    await set(first)
    await startupControl(home, target, first, 'off', false, async () => 0)
    assert.deepEqual(await invoke(), { code: 0, out: '', err: '' })
    assert.equal((await readdir(dir)).includes('config-read'), false)
    await startupControl(home, target, first, 'on', false, async () => 0)
    const attempted = await invoke()
    assert.notEqual(attempted.code, 0)
    assert.equal(attempted.out, '')
    assert.match(await readFile(marker, 'utf8'), /read/, 'positive control: eligible unsuppressed input reaches config/read')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
