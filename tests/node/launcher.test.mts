import { test } from 'node:test'
import assert from 'node:assert/strict'
import { main } from '../../src/cli.ts'
import { claudeLaunch } from '../../src/hosts/claude/launch-node.ts'

test('removed Codex launcher directs users to standalone controls', async () => {
  await assert.rejects(main(['codex', '--tmux']), /Start Codex normally in tmux and run !vargus on/)
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
