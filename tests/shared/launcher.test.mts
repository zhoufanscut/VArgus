import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { main } from '../../src/cli.ts'
import { DEFAULTS, resolveOptions } from '../../src/options.ts'

const exec = promisify(execFile)
const cli = resolve('src/cli.ts')

async function runCli(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return exec(process.execPath, [cli, ...args], {
    env: { ...process.env, ...extraEnv, VARGUS_CLI_MAIN: '1' },
    timeout: 10000,
    killSignal: 'SIGKILL',
  })
}

test('removed Codex launcher directs users to standalone controls', async () => {
  await assert.rejects(main(['codex', '--tmux']), /Start Codex normally in tmux and run !vargus on/)
})

test('removed Claude launcher directs users to the inline plugin and ignores its old option', async () => {
  await assert.rejects(main(['claude', '--tmux']), /Start Claude normally.*vargus install claude.*vargus remove claude/)
  await assert.rejects(main(['install', 'claude', '--extra']), /vargus install claude/)
  await assert.rejects(main(['remove', 'claude', '--extra']), /vargus remove claude/)
  assert.deepEqual(resolveOptions({ tmuxOutput: true }), DEFAULTS)
})

test('antigravity and omo verbs direct users to install and remove commands', async () => {
  await assert.rejects(main(['antigravity']), /Usage: vargus install antigravity or vargus remove antigravity\..*\/statusline/)
  await assert.rejects(main(['install', 'antigravity', '--extra']), /vargus install antigravity/)
  await assert.rejects(main(['remove', 'antigravity', '--extra']), /vargus remove antigravity/)
  await assert.rejects(main(['omo']), /Usage: vargus install omo or vargus remove omo\./)
})

test('top-level help merges install and remove while subcommand help lists per-host options', async () => {
  for (const args of [[], ['--help']]) {
    const { stdout } = await runCli(args)
    assert.match(stdout, /^Usage:$/m)
    assert.match(stdout, /^  vargus install\|remove antigravity\|claude\|codex\|omo \[OPTIONS\]$/m)
    assert.match(stdout, /^  vargus themes \[NAME\]$/m)
    assert.match(stdout, /^Configuration:$/m)
    assert.match(stdout, /vargus\.sample\.jsonc/)
    assert.match(stdout, /^Runtime controls by host:$/m)
    assert.match(stdout, /!vargus on\|off\|status\|reload/)
    assert.match(stdout, /docs\/setup-<host>\.md/)
    assert.match(stdout, /Run `vargus install --help`, `vargus remove --help`, or `vargus themes --help` for options\./)
    assert.doesNotMatch(stdout, /vargus statusline/)
    assert.doesNotMatch(stdout, /vargus hook/)
    assert.doesNotMatch(stdout, /vargus tmux-reset/)
    assert.doesNotMatch(stdout, /Antigravity CLI only/)
    assert.doesNotMatch(stdout, /Codex CLI only/)
    assert.doesNotMatch(stdout, /Codex tmux details/)
    assert.doesNotMatch(stdout, /--config FILE/)
    assert.doesNotMatch(stdout, /^  vargus (?:install|remove) antigravity$/m)
  }

  for (const action of ['on', 'reload']) {
    const { stdout } = await runCli([action, '--help'])
    assert.match(stdout, /^Usage \(Codex CLI only\):$/m)
    assert.match(stdout, /--theme and\n--config FILE \(JSON or JSONC\) override vargus\.jsonc for this helper\./)
    assert.match(stdout, /OmO Native:.*\/vargus/)
    assert.match(stdout, /Claude Code:.*\/reload-plugins/)
    assert.match(stdout, /Antigravity CLI:.*\/statusline/)
  }

  const installHelp = (await runCli(['install', '--help'])).stdout
  assert.match(installHelp, /^  vargus install antigravity$/m)
  assert.match(installHelp, /^  vargus install claude$/m)
  assert.match(installHelp, /^  vargus install codex \[--home CODEX_HOME\]$/m)
  assert.match(installHelp, /^  vargus install omo \[--dir EXTENSIONS_DIRECTORY\] \[--config FILE\]$/m)
  assert.match(installHelp, /Run `vargus install <host> --help` for host-specific details and options\./)
  assert.doesNotMatch(installHelp, /Sets `statusLine\.command`/)

  const removeHelp = (await runCli(['remove', '--help'])).stdout
  assert.match(removeHelp, /^  vargus remove antigravity$/m)
  assert.match(removeHelp, /^  vargus remove claude$/m)
  assert.match(removeHelp, /^  vargus remove codex \[--home CODEX_HOME\]$/m)
  assert.match(removeHelp, /^  vargus remove omo \[--dir EXTENSIONS_DIRECTORY\]$/m)
  assert.match(removeHelp, /Run `vargus remove <host> --help` for host-specific details and options\./)
  assert.doesNotMatch(removeHelp, /vargus remove omo.*--config/)
  assert.doesNotMatch(removeHelp, /Clears the VArgus/)

  const perHostExpectations: Array<[string, string, RegExp]> = [
    ['install', 'antigravity', /Sets `statusLine\.command` in ~\/\.gemini\/antigravity-cli\/settings\.json\./],
    ['install', 'claude', /Sets up the VArgus plugin and inline status line at user scope\./],
    ['install', 'codex', /--home CODEX_HOME[\s\S]*Adds the VArgus startup hooks to hooks\.json in CODEX_HOME/],
    ['install', 'omo', /--dir EXTENSIONS_DIRECTORY[\s\S]*--config FILE[\s\S]*Adds the VArgus extension loader/],
    ['remove', 'antigravity', /Clears the VArgus `statusLine` from ~\/\.gemini\/antigravity-cli\/settings\.json\./],
    ['remove', 'claude', /Uninstalls the user-scope plugin/],
    ['remove', 'codex', /--home CODEX_HOME[\s\S]*Removes the VArgus startup hooks and autostart state from CODEX_HOME/],
    ['remove', 'omo', /--dir EXTENSIONS_DIRECTORY[\s\S]*Removes the VArgus extension loader/],
  ]
  for (const [action, host, pattern] of perHostExpectations) {
    const { stdout } = await runCli([action, host, '--help'])
    assert.match(stdout, new RegExp(`^  vargus ${action} ${host}`, 'm'))
    assert.match(stdout, pattern)
  }
  const removeOmoHelp = (await runCli(['remove', 'omo', '--help'])).stdout
  assert.doesNotMatch(removeOmoHelp, /--config/)

  await assert.rejects(runCli(['install', 'unknown', '--help']))
  await assert.rejects(runCli(['remove', 'toString', '--help']))
})

test('CLI dispatches install and remove for antigravity against the default home settings path', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vargus-cli-agy-'))
  const settings = join(home, '.gemini', 'antigravity-cli', 'settings.json')
  try {
    const installed = await runCli(['install', 'antigravity'], { HOME: home, USERPROFILE: home })
    assert.match(installed.stdout, /VArgus status line installed/)
    assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')), {
      statusLine: { type: 'command', command: 'vargus statusline', enabled: true },
    })

    const removed = await runCli(['remove', 'antigravity'], { HOME: home, USERPROFILE: home })
    assert.match(removed.stdout, /VArgus status line removed/)
    assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')), {})
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Codex tmux controls fail outside Codex with host guidance and keep thread-bound off/status clean', async () => {
  const outsideEnv = { CODEX_THREAD_ID: '' }
  await assert.rejects(
    runCli(['reload'], outsideEnv),
    /vargus reload is for Codex CLI's tmux\/psmux helper only.*vargus\.jsonc apply automatically.*\/reload.*\/reload-plugins.*Antigravity/,
  )
  for (const action of ['status', 'off'] as const) {
    await assert.rejects(
      runCli([action], outsideEnv),
      new RegExp(`vargus ${action} is for Codex CLI's tmux/psmux helper only.*/vargus ${action}.*/statusline.*/config`),
    )
  }
  await assert.rejects(
    runCli(['on'], outsideEnv),
    /Inside Codex, run !vargus on.*Codex CLI only/,
  )

  const home = await mkdtemp(join(tmpdir(), 'vargus-cli-codex-off-'))
  try {
    for (const action of ['status', 'off'] as const) {
      const res = await runCli([action], { CODEX_THREAD_ID: '00000000-0000-0000-0000-000000000001', CODEX_HOME: home })
      assert.match(res.stdout, /^VArgus is off for this Codex thread\.$/m)
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
