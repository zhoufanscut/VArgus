import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codexServerArgs } from '../../src/cli'
import { claudeLaunch } from '../../src/hosts/claude/launch-node'

test('Codex startup config overrides reach the backend; model arguments remain TUI-owned', () => {
  assert.deepEqual(codexServerArgs(['-c', 'model="gpt-6.1-sol"', '--enable', 'hooks', '--disable=memories', '-cfoo=true', '-m', 'gpt-6-luna']).args,
    ['-c', 'model="gpt-6.1-sol"', '--enable', 'hooks', '--disable=memories', '-c', 'foo=true'])
  assert.throws(() => codexServerArgs(['--profile', 'custom']), /--profile/)
  assert.throws(() => codexServerArgs(['-pcustom']), /--profile/)
  assert.throws(() => codexServerArgs(['--remote', 'ws://example']), /--remote/)
  assert.equal(codexServerArgs(['-C/tmp']).cwd, '/tmp')
})

test('Claude launcher enables only its launch-local publisher and hides its native command for that launch', () => {
  const launch = claudeLaunch('/repo', ['--model', 'sonnet'], '0123456789abcdef0123456789abcdef', { theme: 'ember' })
  assert.deepEqual(launch.args.slice(0, 3), ['--plugin-dir', '/repo', '--settings'])
  const settings = JSON.parse(launch.args[3]!)
  assert.equal(settings.pluginConfigs['vargus@inline'].options.tmuxOutput, true)
  assert.equal(settings.pluginConfigs['vargus@inline'].options.theme, 'ember')
  assert.equal(settings.statusLine.command, 'true')
  assert.deepEqual(launch.args.slice(4), ['--model', 'sonnet'])
})
