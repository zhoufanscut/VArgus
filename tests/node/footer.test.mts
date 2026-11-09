import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codexComposer, restoreFooter, footerIdentity, FooterSettings } from '../../src/hosts/codex/footer.ts'

const screen = (line: string, x = 2) => ({ lines: [line], x, y: 0, visible: true, command: 'codex' })
test('footer selection keeps saved-empty distinct from defaults and custom order', () => {
  assert.equal(restoreFooter(null), '/statusline model-with-reasoning current-dir thread-name')
  assert.equal(restoreFooter([]), '/statusline --clear')
  assert.equal(restoreFooter(['thread-id', 'model']), '/statusline thread-id model')
  assert.equal(restoreFooter(['session-id', 'model']), '/statusline session-id model')
  assert.throws(() => restoreFooter(['model\n/quit']), /unsupported item/)
})

test('Thread ID and its legacy alias retain first-item and whole-footer recognition', () => {
  for (const name of ['thread-id', 'session-id']) {
    assert.equal(footerIdentity([name, 'model']), 'first')
    assert.equal(footerIdentity(['model', name]), 'whole')
  }
  for (const selection of [undefined, null, [], ['model', 'current-dir']]) {
    assert.equal(footerIdentity(selection), 'none')
  }
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

test('child local commands require the complete dim read-only placeholder', () => {
  const child = 'Viewing sub-agent — direct input is disabled'
  assert.ok(codexComposer(screen('› \x1b[2m' + child + '\x1b[0m'), ''))
  assert.equal(codexComposer(screen('› ' + child), ''), false)
  assert.equal(codexComposer(screen('› \x1b[2mViewing sub-agent — direct input is d\x1b[0m'), ''), false)
})

test('footer settings preload once per workspace and retain unset, empty and ordered selections until reset', async () => {
  const calls: string[] = []
  let selection = ['session-id', 'model']
  const settings = new FooterSettings(async cwd => {
    calls.push(cwd)
    return cwd === '/unset' ? null : cwd === '/empty' ? [] : [...selection]
  })
  await settings.preload(['/unset', '/empty', '/ordered', '/ordered'])
  assert.deepEqual(calls, ['/unset', '/empty', '/ordered'])
  assert.equal(settings.get('/unset'), null)
  assert.deepEqual(settings.get('/empty'), [])
  assert.deepEqual(settings.get('/ordered'), ['session-id', 'model'])
  selection = ['current-dir']
  await settings.preload(['/ordered'])
  assert.deepEqual(settings.get('/ordered'), ['session-id', 'model'])
  assert.equal(calls.length, 3)
  settings.reset()
  await settings.preload(['/ordered'])
  assert.deepEqual(settings.get('/ordered'), ['current-dir'])
  assert.equal(calls.length, 4)
})

test('a preload failure leaves other workspaces ready and can be retried', async () => {
  let attempts = 0
  const settings = new FooterSettings(async cwd => {
    if (cwd === '/retry' && ++attempts === 1) throw new Error('config read failed')
    return ['model']
  })
  await settings.preload(['/retry', '/ready'])
  assert.throws(() => settings.get('/retry'), /config read failed/)
  assert.deepEqual(settings.get('/ready'), ['model'])
  await settings.preload(['/retry', '/ready'])
  assert.equal(attempts, 2)
  assert.deepEqual(settings.get('/retry'), ['model'])
})
