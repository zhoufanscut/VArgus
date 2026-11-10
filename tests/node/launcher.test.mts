import { test } from 'node:test'
import assert from 'node:assert/strict'
import { main } from '../../src/cli.ts'
import { DEFAULTS, resolveOptions } from '../../src/options.ts'

test('removed Codex launcher directs users to standalone controls', async () => {
  await assert.rejects(main(['codex', '--tmux']), /Start Codex normally in tmux and run !vargus on/)
})

test('removed Claude launcher directs users to the inline plugin and ignores its old option', async () => {
  await assert.rejects(main(['claude', '--tmux']), /Start Claude normally and use the VArgus inline plugin/)
  assert.deepEqual(resolveOptions({ tmuxOutput: true }), DEFAULTS)
})
