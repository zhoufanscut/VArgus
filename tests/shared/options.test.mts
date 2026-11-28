import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULTS, editOption, mergeOptionLayers, parseOptions, resolveOptions, sameOptions } from '../../src/options.ts'
import { OptionsPoller, readCheckoutOptionsSafe } from '../../src/node/options.ts'
import { resolveCodexOptions, workerOptions } from '../../src/hosts/codex/options.ts'
import { PALETTES } from '../../src/theme/palettes.ts'

test('the sample lists shared defaults in order and each switch can be enabled on its own', async () => {
  const example = await readFile('vargus.sample.jsonc', 'utf8')
  assert.deepEqual(parseOptions(example), { theme: 'auto' })
  assert.equal(DEFAULTS.includeSubagents, true)
  assert.equal(resolveOptions({}).includeSubagents, true)
  assert.equal(resolveOptions({ includeSubagents: false }).includeSubagents, false)
  assert.equal(resolveOptions({ includeSubagents: 'no' }).includeSubagents, true)
  const uncommented = example.replace(/^(\s*)\/\/ (?=\s*["}])/gm, '$1')
  const sample = parseOptions(uncommented)
  const expectedCustom = { polarity: 'dark', ...PALETTES['agy-tokyonight'] }
  assert.deepEqual(resolveOptions(sample).customTheme, expectedCustom)
  assert.deepEqual(resolveCodexOptions(sample), {
    ...resolveCodexOptions({}),
    customTheme: expectedCustom,
  })
  const sharedKeys = Object.keys(sample).filter(key => Object.hasOwn(DEFAULTS, key))
  assert.deepEqual(Object.keys(DEFAULTS), sharedKeys)
  for (const line of example.split('\n').filter(line => /^\s*\/\/ "(?!polarity"|text"|calm"|label"|detail"|sep"|alert"|add"|del"|track"|customTheme")/.test(line))) {
    const key = line.match(/"(\w+)"/)![1]!
    assert.ok(Object.hasOwn(parseOptions(example.replace(line, line.replace('// ', ''))), key))
  }
  const customOnly = example.replace(
    /^\s*\/\/ "customTheme": \{[\s\S]*?^\s*\/\/ \},/m,
    block => block.replace(/^(\s*)\/\/ /gm, '$1'),
  )
  assert.deepEqual(resolveOptions(parseOptions(customOnly)).customTheme, expectedCustom)
})

test('JSONC accepts comments as whitespace and preserves strings, CRLF, and ordinary JSON', () => {
  const quoted = String.raw`{"url":"https://host/*a*/","quote":"\"//"}`
  assert.deepEqual(parseOptions('\uFEFF/* header */\r\n' + quoted + '// end'), JSON.parse(quoted))
  for (const invalid of ['[]', 'null', 'true', '{} /*/', '{} /* unterminated', '{"x":1/* hi */2}']) {
    assert.throws(() => parseOptions(invalid))
  }
})

test('editing an option preserves unrelated bytes and updates the effective top-level value', () => {
  const original = '{\r\n  /* theme */ "other":{"theme":"old"},\r\n  "theme":"first",\r\n  "\\u0074heme": /* chosen */ "last" // keep\r\n}\r\n'
  const changed = editOption(original, 'theme', 'codex-ink')
  assert.equal(changed, original.replace('"last"', '"codex-ink"'))
  assert.equal(editOption(changed, 'theme', 'codex-ink'), changed)
  const extra = editOption(changed, 'model', false)
  assert.deepEqual(parseOptions(extra), { ...parseOptions(changed), model: false })
  assert.equal(extra.replace('  "model": false,\r\n', ''), changed)
  const empty = '{ // header\n}\n'
  assert.deepEqual(parseOptions(editOption(empty, 'folder', true)), { folder: true })
  assert.throws(() => editOption('{broken', 'theme', 'codex-ink'))

  const withCustom = '{\n  "customTheme": {\n    "text": "#112233"\n  },\n  "theme": "auto"\n}\n'
  const editedCustom = editOption(withCustom, 'theme', 'daylight')
  assert.deepEqual(parseOptions(editedCustom), { customTheme: { text: '#112233' }, theme: 'daylight' })
  assert.ok(editedCustom.includes('"text": "#112233"'))
})

test('mergeOptionLayers, resolveOptions, sameOptions and workerOptions handle customTheme precedence', () => {
  assert.deepEqual(
    mergeOptionLayers({ customTheme: { text: '#112233' }, model: false }, { theme: 'daylight' }),
    { model: false, theme: 'daylight' },
  )
  assert.deepEqual(
    mergeOptionLayers({ customTheme: { text: '#112233' } }, { theme: 'daylight', customTheme: { sep: '#445566' } }),
    { theme: 'daylight', customTheme: { sep: '#445566' } },
  )
  assert.deepEqual(
    mergeOptionLayers({ customTheme: { text: '#112233' } }, { theme: 123 }),
    { customTheme: { text: '#112233' }, theme: 123 },
  )

  assert.equal(Object.hasOwn(resolveOptions({ customTheme: {} }), 'customTheme'), false)
  assert.deepEqual(resolveOptions({ customTheme: { text: '#AABBCC', bad: '#111111' } }).customTheme, { text: '#aabbcc' })
  assert.equal(
    sameOptions(
      { ...DEFAULTS, customTheme: { text: '#112233' } },
      { ...DEFAULTS, customTheme: { text: '#112233' } },
    ),
    true,
  )
  assert.equal(
    sameOptions(
      { ...DEFAULTS, customTheme: { text: '#112233' } },
      { ...DEFAULTS, customTheme: { text: '#445566' } },
    ),
    false,
  )

  const checkout = { customTheme: { text: '#112233' }, model: false }
  const themed = workerOptions(checkout, { theme: 'daylight' })
  assert.equal(themed.options.theme, 'daylight')
  assert.equal(themed.options.customTheme, undefined)
  assert.equal(themed.options.model, false)
  assert.deepEqual(themed.overrideKeys, ['theme'])

  const polled = workerOptions({ customTheme: { sep: '#998877' }, model: true }, {}, themed)
  assert.equal(polled.options.theme, 'daylight')
  assert.equal(polled.options.customTheme, undefined)
  assert.equal(polled.options.model, true)

  const cleared = workerOptions(checkout, { customTheme: null })
  assert.equal(cleared.options.customTheme, undefined)
  assert.deepEqual(cleared.overrideKeys, ['customTheme'])
  const clearedJson = JSON.parse(JSON.stringify(cleared))
  assert.equal(workerOptions(checkout, {}, clearedJson).options.customTheme, undefined)
  const rethemed = workerOptions(checkout, { theme: 'graphite' }, clearedJson)
  assert.equal(rethemed.options.theme, 'graphite')
  assert.deepEqual(rethemed.overrideKeys, ['theme'])
})

test('Codex reload follows edited or removed checkout defaults and retains explicit choices', () => {
  const first = workerOptions({ model: false, session: false }, { theme: 'codex-ink', folder: true })
  assert.equal(first.options.model, false)
  assert.equal(first.options.session, false)
  const reload = workerOptions({ model: true, folder: false }, { theme: 'daylight' }, first)
  assert.deepEqual(reload.options, { ...resolveCodexOptions({}), theme: 'daylight' })
  assert.deepEqual(new Set(reload.overrideKeys), new Set(['theme', 'folder']))
  assert.equal(workerOptions({ theme: 'codex-ink' }, {}, { options: DEFAULTS }).options.theme, 'auto')
})

test('sameOptions compares keys and values with Object.is', () => {
  assert.equal(sameOptions(DEFAULTS, { ...DEFAULTS }), true)
  assert.equal(sameOptions(DEFAULTS, { ...DEFAULTS, model: false }), false)
  assert.equal(sameOptions({ a: 1 }, { a: 1, b: undefined }), false)
  assert.equal(sameOptions({ a: undefined }, { b: undefined } as Record<string, unknown>), false)
})

test('OptionsPoller tracks creation, equal-length edits, invalid JSONC, deletion, and symlinks', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-options-poller-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const file = join(dir, 'vargus.jsonc')
  const poller = new OptionsPoller(file)
  assert.deepEqual(poller.readInitial(), {})
  assert.deepEqual(poller.poll(), { changed: false })

  await writeFile(file, '{"theme":"daylight"}')
  assert.deepEqual(poller.poll(), { changed: true, ok: true, options: { theme: 'daylight' } })
  assert.deepEqual(poller.poll(), { changed: false })

  // Same byte length ("daylight" vs "graphite") still triggers a change.
  await writeFile(file, '{"theme":"graphite"}')
  assert.deepEqual(poller.poll(), { changed: true, ok: true, options: { theme: 'graphite' } })

  // Broken JSONC reports ok: false once until the file changes again.
  await writeFile(file, '{broken')
  const broken = poller.poll()
  assert.equal(broken.changed, true)
  assert.equal(broken.ok, false)
  assert.match(broken.error.message, /Expected a VArgus JSON options object/)
  assert.deepEqual(poller.poll(), { changed: false })

  await writeFile(file, '{"folder":false}')
  assert.deepEqual(poller.poll(), { changed: true, ok: true, options: { folder: false } })

  await rm(file)
  assert.deepEqual(poller.poll(), { changed: true, ok: true, options: {} })
  assert.deepEqual(poller.poll(), { changed: false })

  if (process.platform !== 'win32') {
    const target = join(dir, 'target.jsonc')
    const link = join(dir, 'link.jsonc')
    await writeFile(target, '{"model":false}')
    await symlink(target, link)
    const linkPoller = new OptionsPoller(link)
    assert.deepEqual(linkPoller.readInitial(), { model: false })
    await writeFile(target, '{"model":true}')
    assert.deepEqual(linkPoller.poll(), { changed: true, ok: true, options: { model: true } })
  }

  const missingSafe = new OptionsPoller(join(dir, 'missing.jsonc'))
  assert.deepEqual(missingSafe.readInitialSafe(), { ok: true, options: {} })

  const brokenFile = join(dir, 'broken-start.jsonc')
  await writeFile(brokenFile, '{broken')
  const brokenPoller = new OptionsPoller(brokenFile)
  const initialBroken = brokenPoller.readInitialSafe()
  assert.equal(initialBroken.ok, false)
  assert.match(initialBroken.error.message, /Expected a VArgus JSON options object/)
  assert.deepEqual(brokenPoller.poll(), { changed: false })
  await writeFile(brokenFile, '{"model":false}')
  assert.deepEqual(brokenPoller.poll(), { changed: true, ok: true, options: { model: false } })
  await writeFile(brokenFile, '{broken')
  assert.equal(brokenPoller.poll().changed, true)
  await rm(brokenFile)
  assert.deepEqual(brokenPoller.poll(), { changed: true, ok: true, options: {} })
  assert.equal(typeof readCheckoutOptionsSafe().ok, 'boolean')
})
