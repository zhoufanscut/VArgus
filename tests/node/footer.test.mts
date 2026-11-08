import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codexComposer, restoreFooter } from '../../src/hosts/codex/footer'

const screen = (line: string, x = 2) => ({ lines: [line], x, y: 0, visible: true, command: 'codex' })
test('footer selection keeps saved-empty distinct from defaults and custom order', () => {
  assert.equal(restoreFooter(null), '/statusline model-with-reasoning current-dir thread-name')
  assert.equal(restoreFooter([]), '/statusline --clear')
  assert.equal(restoreFooter(['session-id', 'model']), '/statusline session-id model')
  assert.throws(() => restoreFooter(['model\n/quit']), /unsupported item/)
})
test('composer guard requires the dim placeholder, live cursor, and complete command', () => {
  assert.ok(codexComposer(screen('\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m'), ''))
  assert.equal(codexComposer(screen('› Ask Codex to do anything'), ''), false)
  assert.equal(codexComposer(screen('› a draft', 2), ''), false)
  assert.equal(codexComposer(screen('› /statusline --clear', 21), '/statusline --clear'), true)
  assert.equal(codexComposer(screen('› /statusline --clear', 2), '/statusline --clear'), false)
  assert.equal(codexComposer(screen('› /statusline --xxxxx', 21), '/statusline --clear'), false)
  assert.equal(codexComposer(screen('› /statusline --clear extra', 27), '/statusline --clear'), false)
  assert.equal(codexComposer({ ...screen('› /statusline --clear', 21), visible: false }, '/statusline --clear'), false)
})
