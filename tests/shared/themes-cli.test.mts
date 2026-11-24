import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { themes } from '../../src/cli/themes.ts'
import { makeTheme } from '../../src/theme/index.ts'
import { PALETTES } from '../../src/theme/palettes.ts'

const execFileAsync = promisify(execFile)

function runThemes(args: string[], opts: { noColor?: boolean; isWsl?: boolean } = {}) {
  let out = ''
  const code = themes(args, {
    write: chunk => { out += chunk },
    noColor: opts.noColor ?? false,
    isWsl: opts.isWsl ?? false,
  })
  return { code, out }
}

describe('vargus themes', () => {
  test('prints all 5 bundled palettes in order with swatches, calm and alert rows', () => {
    const { code, out } = runThemes([])
    assert.equal(code, 0)

    const blocks = out.trimEnd().split('\n\n')
    const names = Object.keys(PALETTES)
    assert.equal(blocks.length, names.length)

    for (let i = 0; i < names.length; i++) {
      const name = names[i]!
      const block = blocks[i]!
      const lines = block.split('\n')
      assert.equal(lines.length, 4)
      assert.equal(lines[0], name === 'graphite' ? 'graphite (default)' : name)

      const t = makeTheme(name, false)
      for (const tok of ['text', 'calm', 'label', 'detail', 'sep', 'alert', 'add', 'del', 'track'] as const) {
        assert.ok(lines[1]!.includes(t.paint(tok, tok)), `${name} swatches missing ${tok}`)
      }

      const calm = lines[2]!
      assert.ok(calm.includes(t.bold(t.paint('text', '~/proj/VArgus'))))
      assert.ok(calm.includes(t.paint('label', 'opus:') + t.paint('calm', 'high') + t.paint('detail', '(fast)')))
      assert.ok(calm.includes(t.paint('label', '5h:') + t.paint('calm', '4%') + t.paint('detail', '(4h37m)')))
      assert.ok(calm.includes(t.paint('label', '7d:') + t.paint('calm', '39%') + t.paint('detail', '(5d6h)')))
      assert.ok(calm.includes(t.paint('label', 'ctx:') + t.paint('calm', '20%')))
      assert.ok(calm.includes(t.paint('label', 'token:') + t.paint('calm', '69.5k') + t.paint('detail', '(99.4%, 48t/s)')))
      assert.ok(calm.includes(t.paint('label', 'session:') + t.paint('calm', '24m')))
      assert.ok(calm.includes(`${t.paint('label', '🔧73')} ${t.paint('label', '🤖2')} ${t.paint('label', '⚡1')}`))
      assert.ok(calm.includes(t.paint('label', 'repo:') + t.paint('text', 'VArgus')))
      assert.ok(calm.includes(t.paint('label', 'branch:') + t.paint('text', 'main') + t.paint('detail', '(wt:x)')))
      assert.ok(calm.includes(`${t.paint('add', '+2')} ${t.paint('del', '!3')} ${t.paint('track', '?4')} ${t.paint('add', '⇡1')} ${t.paint('del', '⇣2')}`))

      const alert = lines[3]!
      assert.ok(alert.includes(t.paint('label', 'opus:') + t.paint('alert', 'low')))
      assert.ok(alert.includes(t.paint('alert', '[API 429]') + ' ' + t.paint('label', '7d:') + t.paint('alert', '88%') + t.paint('detail', '(5d6h)')))
      assert.ok(alert.includes(t.paint('label', 'ctx:') + t.paint('alert', '85%')))
      assert.ok(alert.includes(t.paint('label', 'token:') + t.paint('alert', '1.20M') + t.paint('detail', '(99.4%, 48t/s)')))
      assert.ok(alert.includes(t.paint('label', 'session:') + t.paint('alert', '12h30m')))
      assert.ok(alert.includes(t.paint('label', 'branch:') + t.paint('text', 'feat') + t.paint('alert', '(rebase 2/3)')))
      assert.ok(alert.includes(`${t.paint('del', '✗1')} ${t.paint('del', '!3')} ${t.paint('del', '⇣2')}`))
      assert.ok(alert.endsWith(t.paint('sep', ' | ') + t.paint('label', '⌛stale')))
    }
  })

  test('selects a single theme case- and whitespace-insensitively without (default) on non-default', () => {
    const { code, out } = runThemes([' Ember '])
    assert.equal(code, 0)
    const blocks = out.trimEnd().split('\n\n')
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0]!.split('\n')[0], 'ember')
  })

  test('rejects unknown names including Object prototype properties', () => {
    for (const bad of ['nope', 'constructor', 'toString', '__proto__', '']) {
      assert.throws(() => runThemes([bad]), /Unknown theme.*aurora, ember, nebula, graphite, daylight/)
    }
  })

  test('supports --help and rejects unknown flags or extra arguments', () => {
    const { code, out } = runThemes(['--help'])
    assert.equal(code, 0)
    assert.match(out, /vargus themes \[NAME\]/)
    assert.match(out, /aurora, ember, nebula, graphite, daylight/)
    assert.throws(() => runThemes(['--unknown']), /Usage:/)
    assert.throws(() => runThemes(['graphite', 'ember']), /Usage:/)
  })

  test('respects noColor and isWsl flags', () => {
    const plain = runThemes(['graphite'], { noColor: true })
    assert.equal(plain.code, 0)
    assert.doesNotMatch(plain.out, /\x1b\[/)
    assert.ok(plain.out.includes('~/proj/VArgus | opus:high(fast) | 5h:4%(4h37m) 7d:39%(5d6h) | ctx:20%'))
    assert.ok(plain.out.includes('branch:feat(rebase 2/3) | ✗1 !3 ⇣2 | ⌛stale'))

    const wsl = runThemes(['graphite'], { noColor: true, isWsl: true })
    assert.ok(wsl.out.includes('T:73 A:2 S:1'))
    assert.ok(wsl.out.includes('!:stale'))
    assert.doesNotMatch(wsl.out, /[🔧🤖⚡⌛]/)
  })

  test('runs via CLI entrypoint with NO_COLOR and non-zero exit on invalid theme', async () => {
    const envBase = { ...process.env, VARGUS_CLI_MAIN: '1', WSL_DISTRO_NAME: '', WSLENV: '' }
    const colored = await execFileAsync(process.execPath, ['src/cli.ts', 'themes', 'graphite'], {
      env: { ...envBase, NO_COLOR: '' },
    })
    assert.ok(colored.stdout.includes(makeTheme('graphite', false).paint('text', 'text')))
    assert.ok(colored.stdout.startsWith('graphite (default)\n'))

    const plain = await execFileAsync(process.execPath, ['src/cli.ts', 'themes', 'graphite'], {
      env: { ...envBase, NO_COLOR: '1' },
    })
    assert.doesNotMatch(plain.stdout, /\x1b\[/)

    await assert.rejects(
      execFileAsync(process.execPath, ['src/cli.ts', 'themes', 'nope'], { env: { ...envBase, NO_COLOR: '' } }),
      (err: Error & { code?: number; stderr?: string }) => err.code === 1 && /Unknown theme: nope/.test(err.stderr ?? ''),
    )
  })
})
