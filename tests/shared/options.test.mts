import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { DEFAULTS, editOption, parseOptions, resolveOptions } from '../../src/options.ts'
import { resolveCodexOptions, workerOptions } from '../../src/hosts/codex/options.ts'

test('the sample lists shared defaults in order and each switch can be enabled on its own', async () => {
  const example = await readFile('vargus.sample.jsonc', 'utf8')
  assert.deepEqual(parseOptions(example), { theme: 'graphite' })
  assert.equal(DEFAULTS.includeSubagents, false)
  assert.equal(resolveOptions({}).includeSubagents, false)
  assert.equal(resolveOptions({ includeSubagents: true }).includeSubagents, true)
  assert.equal(resolveOptions({ includeSubagents: 'yes' }).includeSubagents, false)
  const uncommented = example.replace(/^(\s*)\/\/ (")/gm, '$1$2')
  const sample = parseOptions(uncommented)
  assert.deepEqual(sample, resolveCodexOptions({}))
  const sharedKeys = Object.keys(sample).filter(key => Object.hasOwn(DEFAULTS, key))
  assert.deepEqual(Object.keys(DEFAULTS), sharedKeys)
  for (const line of example.split('\n').filter(line => /^\s*\/\/ "/.test(line))) {
    const key = line.match(/"(\w+)"/)![1]!
    assert.ok(Object.hasOwn(parseOptions(example.replace(line, line.replace('// ', ''))), key))
  }
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
  const changed = editOption(original, 'theme', 'ember')
  assert.equal(changed, original.replace('"last"', '"ember"'))
  assert.equal(editOption(changed, 'theme', 'ember'), changed)
  const extra = editOption(changed, 'model', false)
  assert.deepEqual(parseOptions(extra), { ...parseOptions(changed), model: false })
  assert.equal(extra.replace('  "model": false,\r\n', ''), changed)
  const empty = '{ // header\n}\n'
  assert.deepEqual(parseOptions(editOption(empty, 'folder', true)), { folder: true })
  assert.throws(() => editOption('{broken', 'theme', 'ember'))
})

test('Codex reload follows edited or removed checkout defaults and retains explicit choices', () => {
  const first = workerOptions({ model: false, session: false }, { theme: 'ember', folder: true })
  assert.equal(first.options.model, false)
  assert.equal(first.options.session, false)
  const reload = workerOptions({ model: true, folder: false }, { theme: 'daylight' }, first)
  assert.deepEqual(reload.options, { ...resolveCodexOptions({}), theme: 'daylight' })
  assert.deepEqual(new Set(reload.overrideKeys), new Set(['theme', 'folder']))
  assert.equal(workerOptions({ theme: 'ember' }, {}, { options: DEFAULTS }).options.theme, 'graphite')
})
