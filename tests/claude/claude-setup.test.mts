import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const entry = resolve('src/cli.ts')
const checkout = resolve('.')
const id = 'vargus@vargus'

// The shim records argv and saves the keys the Claude plugin command writes.
const claude = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.CLAUDE_CALLS, JSON.stringify(args) + '\\n')
const file = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json')
const settings = JSON.parse(fs.readFileSync(file))
if (args[1] === 'marketplace') {
  console.log(JSON.stringify(Object.entries(settings.extraKnownMarketplaces ?? {}).map(([name, market]) => ({ name, ...market.source }))))
} else {
  require('node:assert/strict').equal(process.env.NPM_CONFIG_OMIT, 'dev')
  if (settings.model === 'fail-install') {
    console.error('Claude refused the plugin')
    process.exit(1)
  }
  if (settings.enabledPlugins?.['vargus@vargus'] === true) process.exit(0)
  settings.extraKnownMarketplaces ??= { vargus: { source: { source: 'directory', path: args[4] } } }
  settings.enabledPlugins = { ...settings.enabledPlugins, 'vargus@vargus': true }
  fs.writeFileSync(file, JSON.stringify(settings) + '\\n')
}
`

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'vargus-claude-setup-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const config = join(home, 'profile $with "spaces"')
  const settings = join(config, 'settings.json')
  const calls = join(home, 'calls.jsonl')
  const bin = join(home, 'bin')
  await mkdir(bin)
  await mkdir(config)
  await writeFile(join(bin, 'claude'), claude, { mode: 0o700 })
  await writeFile(calls, '')
  const env = {
    PATH: [bin, dirname(process.execPath)].join(delimiter),
    HOME: home, CLAUDE_CONFIG_DIR: config, CLAUDE_CALLS: calls, VARGUS_CLI_MAIN: '1',
  }
  return { config, settings, calls,
    install: () => exec(process.execPath, [entry, 'install', 'claude'], { cwd: home, env, timeout: 10000, killSignal: 'SIGKILL' }),
    load: async () => JSON.parse(await readFile(settings, 'utf8')),
  }
}

test('Claude installer preserves plugin settings and keeps an idle line visible on repeat install', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  await writeFile(f.settings, JSON.stringify({ model: 'fixture-model', enabledPlugins: { 'other@market': true } }))
  await f.install()
  const first = await f.load()
  assert.deepEqual(first.enabledPlugins, { 'other@market': true, [id]: true })
  assert.deepEqual(first.extraKnownMarketplaces.vargus.source, { source: 'directory', path: checkout })
  assert.equal(first.model, 'fixture-model')
  assert.equal(first.statusLine.refreshInterval, 1)

  const line = join(f.config, 'plugins', 'data', 'vargus-vargus', 'test-session', 'line')
  await mkdir(dirname(line), { recursive: true })
  await writeFile(line, 'VArgus reader canary\n')
  const read = (command: string) =>
    exec('sh', ['-c', command], { env: { PATH: process.env.PATH, CLAUDE_CODE_SESSION_ID: 'test-session' }, timeout: 3000 })
  assert.equal((await read(first.statusLine.command)).stdout, 'VArgus reader canary\n')

  first.statusLine.padding = 3
  first.pluginConfigs = { [id]: { options: { blankStopped: true } } }
  await writeFile(f.settings, JSON.stringify(first))
  await f.install()
  const { statusLine } = await f.load()
  assert.equal(statusLine.padding, 3)
  assert.equal((await read(statusLine.command)).stdout, 'VArgus reader canary\n')
  const stale = new Date(Date.now() - 180000)
  await utimes(line, stale, stale)
  assert.equal((await read(statusLine.command)).stdout, 'VArgus reader canary\n')
  const saved = await readFile(f.settings, 'utf8')
  await f.install()
  assert.equal(await readFile(f.settings, 'utf8'), saved)
  assert.deepEqual((await readFile(f.calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line)), [
    ['plugin', 'marketplace', 'list', '--json'],
    ['plugin', 'install', 'vargus', '--marketplace', checkout, '--scope', 'user', '--json'],
    ['plugin', 'marketplace', 'list', '--json'],
    ['plugin', 'install', id, '--scope', 'user', '--json'],
    ['plugin', 'marketplace', 'list', '--json'],
    ['plugin', 'install', id, '--scope', 'user', '--json'],
  ])
})

test('Claude installer protects a custom reader and skips configuration if plugin installation fails', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  const commands = [
    'cat "$HOME/vargus-vargus/$CLAUDE_CODE_SESSION_ID/line" 2>/dev/null | sed s/x/y/',
    'cat "$HOME/.claude/plugins/data/other-plugin/$CLAUDE_CODE_SESSION_ID/line" 2>/dev/null',
  ]
  for (const command of commands) {
    const custom = JSON.stringify({ statusLine: { type: 'command', command } })
    await writeFile(f.settings, custom)
    await assert.rejects(f.install(), /A different statusLine is configured/)
    assert.equal(await readFile(f.calls, 'utf8'), '')
    assert.equal(await readFile(f.settings, 'utf8'), custom)
  }

  const before = '{"model":"fail-install"}'
  await writeFile(f.settings, before)
  await assert.rejects(f.install(), /Claude refused the plugin/)
  assert.equal(await readFile(f.settings, 'utf8'), before)
  assert.match(await readFile(f.calls, 'utf8'), /"install","vargus"/)
})

test('reinstall upgrades the old VArgus age-check readers in place', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  const path = '$HOME/.claude/plugins/data/vargus-vargus/$CLAUDE_CODE_SESSION_ID/line'
  const fresh = '[ -n "$(find "$f" -mmin -2 2>/dev/null)" ]'
  const oldCommands = [
    `f="${path}"; ${fresh} && cat "$f"`,
    `f="${path}"; { [ ! -s "$f.blank" ] || ${fresh}; } && cat "$f" 2>/dev/null`,
    `f="${path}"; { [ -f "$f.blank" ] && [ ! -s "$f.blank" ] || ${fresh}; } && cat "$f" 2>/dev/null`,
  ]
  const line = join(f.config, 'plugins/data/vargus-vargus/S1/line')
  await mkdir(dirname(line), { recursive: true })
  await writeFile(line, 'idle row')
  await writeFile(line + '.blank', '1')
  const stale = new Date(Date.now() - 180000)
  await utimes(line, stale, stale)

  for (const command of oldCommands) {
    await writeFile(f.settings, JSON.stringify({
      statusLine: { type: 'command', command, padding: 3 },
      pluginConfigs: { [id]: { options: { blankStopped: true } } },
    }))
    await f.install()
    const { statusLine } = await f.load()
    assert.equal(statusLine.padding, 3)
    const read = await exec('sh', ['-c', statusLine.command], {
      env: { PATH: process.env.PATH, CLAUDE_CODE_SESSION_ID: 'S1' },
    })
    assert.equal(read.stdout, 'idle row')
    await writeFile(line + '.live', '1\nidle row | ⌛stale\n')
    const expired = await exec('sh', ['-c', statusLine.command], {
      env: { PATH: process.env.PATH, CLAUDE_CODE_SESSION_ID: 'S1' },
    })
    assert.equal(expired.stdout, 'idle row | ⌛stale')
    await rm(line + '.live')
  }
})
