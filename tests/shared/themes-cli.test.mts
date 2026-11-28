import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { formatThemesPreview, themes } from '../../src/cli/themes.ts'
import { detectWsl } from '../../src/node/wsl.ts'
import { stringWidth } from '../../src/render/width.ts'
import { makeTheme } from '../../src/theme/index.ts'
import { PALETTES, PALETTE_POLARITY, TOKEN_NAMES } from '../../src/theme/palettes.ts'
import { fixtureCheckout } from '../checkout.mts'

const execFileAsync = promisify(execFile)

function runThemes(
  args: string[],
  opts: { noColor?: boolean; isWsl?: boolean; columns?: number; checkoutOptions?: Record<string, unknown> } = {},
) {
  let out = ''
  const code = themes(args, {
    write: chunk => { out += chunk },
    noColor: opts.noColor ?? false,
    isWsl: opts.isWsl ?? false,
    columns: opts.columns,
    checkoutOptions: opts.checkoutOptions ?? {},
  })
  return { code, out }
}

function stripSgr(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

function assertRowBackgroundAndForeground(line: string, expectedBg: string) {
  let fg: string | undefined
  let bg: string | undefined
  let bold = false
  let i = 0
  while (i < line.length) {
    if (line[i] === '\x1b') {
      const match = /^\x1b\[([0-9;]*)m/.exec(line.slice(i))
      assert.ok(match, `unexpected escape sequence in line: ${JSON.stringify(line.slice(i, i + 16))}`)
      const codes = match[1] === '' ? [0] : match[1]!.split(';').map(Number)
      for (let c = 0; c < codes.length; c++) {
        const code = codes[c]
        if (code === 0) { fg = undefined; bg = undefined; bold = false }
        else if (code === 1) bold = true
        else if (code === 22) bold = false
        else if (code === 39) fg = undefined
        else if (code === 49) bg = undefined
        else if (code === 38 && codes[c + 1] === 2) {
          fg = `${codes[c + 2]};${codes[c + 3]};${codes[c + 4]}`
          c += 4
        } else if (code === 48 && codes[c + 1] === 2) {
          bg = `${codes[c + 2]};${codes[c + 3]};${codes[c + 4]}`
          c += 4
        } else {
          assert.fail(`unexpected SGR code ${code} in ${match[0]}`)
        }
      }
      i += match[0].length
      continue
    }
    const cp = line.codePointAt(i)!
    const ch = String.fromCodePoint(cp)
    assert.equal(bg, expectedBg, `character ${JSON.stringify(ch)} at index ${i} missing bg ${expectedBg}`)
    if (ch !== ' ') {
      assert.ok(fg !== undefined, `non-space character ${JSON.stringify(ch)} at index ${i} missing explicit fg`)
    }
    i += ch.length
  }
  assert.equal(bg, undefined, 'background leaked past end of line')
  assert.equal(fg, undefined, 'foreground leaked past end of line')
  assert.equal(bold, false, 'bold leaked past end of line')
}

const EXPECTED_HEADERS: Record<string, string> = {
  'agy-tokyonight': 'agy-tokyonight (auto: Antigravity)',
  'codex-ink': 'codex-ink (auto: Codex)',
  'claude-terracotta': 'claude-terracotta (auto: Claude)',
  'omo-violet': 'omo-violet (auto: OmO)',
  graphite: 'graphite',
  daylight: 'daylight',
}

describe('vargus themes', () => {
  test('prints separate Dark and Light sections with forced reference backgrounds, swatches, calm and alert rows', () => {
    const { code, out } = runThemes([])
    assert.equal(code, 0)

    const sections = out.trimEnd().split('\n\n\n')
    assert.equal(sections.length, 2)

    const expectedSections = [
      { title: 'Dark themes', hex: '#181818', bgSgr: '24;24;24', names: ['agy-tokyonight', 'codex-ink', 'claude-terracotta', 'omo-violet', 'graphite'] },
      { title: 'Light themes', hex: '#ffffff', bgSgr: '255;255;255', names: ['daylight'] },
    ] as const

    for (let s = 0; s < expectedSections.length; s++) {
      const spec = expectedSections[s]!
      const [sectionHeader, ...blocks] = sections[s]!.split('\n\n')
      assert.equal(sectionHeader, `\x1b[1m${spec.title} (${spec.hex})\x1b[22m`)
      assert.doesNotMatch(sectionHeader!, /\x1b\[48;2;/)
      assert.equal(blocks.length, spec.names.length)

      for (let i = 0; i < spec.names.length; i++) {
        const name = spec.names[i]!
        const lines = blocks[i]!.split('\n')
        assert.equal(lines.length, 4)
        assert.equal(lines[0], EXPECTED_HEADERS[name])
        assert.doesNotMatch(lines[0]!, /\x1b\[/)

        const previewLines = lines.slice(1)
        const widths = previewLines.map(stringWidth)
        assert.equal(widths[0], widths[2])
        assert.equal(widths[1], widths[2])
        for (const line of previewLines) {
          assertRowBackgroundAndForeground(line, spec.bgSgr)
        }

        const t = makeTheme(name, false)
        const withoutBg = previewLines.map(line => line.replaceAll(`\x1b[48;2;${spec.bgSgr}m`, ''))
        assert.ok(withoutBg[0]!.startsWith(`  ${t.paint('detail', 'tokens')}  `))
        for (const tok of ['text', 'calm', 'label', 'detail', 'sep', 'alert', 'add', 'del', 'track'] as const) {
          assert.ok(withoutBg[0]!.includes(t.paint(tok, tok)), `${name} swatches missing ${tok}`)
        }

        const calm = withoutBg[1]!
        assert.ok(calm.startsWith(`  ${t.paint('detail', 'calm')}    `))
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

        const alert = withoutBg[2]!
        assert.ok(alert.startsWith(`  ${t.paint('detail', 'alert')}   `))
        assert.ok(alert.includes(t.paint('label', 'opus:') + t.paint('alert', 'low')))
        assert.ok(alert.includes(t.paint('alert', '[API 429]') + ' ' + t.paint('label', '7d:') + t.paint('alert', '88%') + t.paint('detail', '(5d6h)')))
        assert.ok(alert.includes(t.paint('label', 'ctx:') + t.paint('alert', '85%')))
        assert.ok(alert.includes(t.paint('label', 'token:') + t.paint('alert', '4.20M') + t.paint('detail', '(99.4%, 48t/s)')))
        assert.ok(alert.includes(t.paint('label', 'session:') + t.paint('alert', '12h30m')))
        assert.ok(alert.includes(t.paint('label', 'branch:') + t.paint('text', 'feat') + t.paint('alert', '(rebase 2/3)')))
        assert.ok(alert.includes(`${t.paint('del', '✗1')} ${t.paint('del', '!3')} ${t.paint('del', '⇣2')}`))
        assert.ok(alert.endsWith(t.paint('sep', ' | ') + t.paint('label', '⌛stale') + '  \x1b[0m'))
      }
    }
    assert.deepEqual(
      expectedSections.flatMap(s => s.names),
      Object.keys(PALETTES),
    )
    assert.ok(expectedSections[0].names.every(n => PALETTE_POLARITY[n] === 'dark'))
    assert.ok(expectedSections[1].names.every(n => PALETTE_POLARITY[n] === 'light'))
  })

  test('groups mixed-polarity lists into Dark then Light sections while preserving relative order', () => {
    const out = formatThemesPreview(['daylight', 'omo-violet', 'agy-tokyonight'], { noColor: false })
    const sections = out.trimEnd().split('\n\n\n')
    assert.equal(sections.length, 2)
    const darkBlocks = sections[0]!.split('\n\n')
    const lightBlocks = sections[1]!.split('\n\n')
    assert.equal(darkBlocks[0], '\x1b[1mDark themes (#181818)\x1b[22m')
    assert.equal(darkBlocks[1]!.split('\n')[0], 'omo-violet (auto: OmO)')
    assert.equal(darkBlocks[2]!.split('\n')[0], 'agy-tokyonight (auto: Antigravity)')
    assert.equal(lightBlocks[0], '\x1b[1mLight themes (#ffffff)\x1b[22m')
    assert.equal(lightBlocks[1]!.split('\n')[0], 'daylight')
  })

  test('selects a single theme into its matching polarity section case- and whitespace-insensitively', () => {
    const dark = runThemes([' Codex-Ink '])
    assert.equal(dark.code, 0)
    const darkSections = dark.out.trimEnd().split('\n\n\n')
    assert.equal(darkSections.length, 1)
    const darkBlocks = darkSections[0]!.split('\n\n')
    assert.equal(darkBlocks.length, 2)
    assert.equal(darkBlocks[0], '\x1b[1mDark themes (#181818)\x1b[22m')
    assert.equal(darkBlocks[1]!.split('\n')[0], 'codex-ink (auto: Codex)')
    assertRowBackgroundAndForeground(darkBlocks[1]!.split('\n')[1]!, '24;24;24')

    const light = runThemes(['daylight'])
    assert.equal(light.code, 0)
    const lightSections = light.out.trimEnd().split('\n\n\n')
    assert.equal(lightSections.length, 1)
    const lightBlocks = lightSections[0]!.split('\n\n')
    assert.equal(lightBlocks.length, 2)
    assert.equal(lightBlocks[0], '\x1b[1mLight themes (#ffffff)\x1b[22m')
    assert.equal(lightBlocks[1]!.split('\n')[0], 'daylight')
    assertRowBackgroundAndForeground(lightBlocks[1]!.split('\n')[1]!, '255;255;255')

    for (const args of [['agy-tokyonight'], ['agy tokyonight'], [' Agy  TokyoNight '], ['agy', 'tokyonight']]) {
      const tokyo = runThemes(args)
      assert.equal(tokyo.code, 0)
      const tokyoBlocks = tokyo.out.trimEnd().split('\n\n')
      assert.equal(tokyoBlocks[0], '\x1b[1mDark themes (#181818)\x1b[22m')
      assert.equal(tokyoBlocks[1]!.split('\n')[0], 'agy-tokyonight (auto: Antigravity)')
      assertRowBackgroundAndForeground(tokyoBlocks[1]!.split('\n')[1]!, '24;24;24')
    }
    const directAlias = formatThemesPreview(['agy tokyonight'], { noColor: true })
    assert.equal(directAlias.split('\n')[2], 'agy-tokyonight (auto: Antigravity)')

    for (const args of [['auto'], [' Auto ']]) {
      const auto = runThemes(args)
      assert.equal(auto.code, 0)
      const autoSections = auto.out.trimEnd().split('\n\n\n')
      assert.equal(autoSections.length, 1)
      const autoBlocks = autoSections[0]!.split('\n\n')
      assert.equal(autoBlocks.length, 5)
      assert.deepEqual(
        autoBlocks.slice(1).map(b => b.split('\n')[0]),
        ['agy-tokyonight (auto: Antigravity)', 'codex-ink (auto: Codex)', 'claude-terracotta (auto: Claude)', 'omo-violet (auto: OmO)'],
      )
    }
    const directAuto = formatThemesPreview(['auto'], { noColor: true })
    assert.match(directAuto, /^Dark themes\n\nagy-tokyonight \(auto: Antigravity\)/)
    assert.doesNotMatch(directAuto, /graphite|daylight/)
  })

  test('aligns rows to maxWidth + 2 on wide/piped output and avoids wrap padding on narrower terminals', () => {
    const wide = formatThemesPreview(['graphite'], { columns: 220 })
    const wideLines = wide.trimEnd().split('\n').slice(3)
    const wideWidths = wideLines.map(stringWidth)
    assert.equal(wideWidths[0], wideWidths[2])
    assert.equal(wideWidths[1], wideWidths[2])
    assert.equal(wideWidths[2], 192)

    const narrow = formatThemesPreview(['graphite'], { columns: 100 })
    const narrowLines = narrow.trimEnd().split('\n').slice(3)
    assert.equal(stringWidth(narrowLines[0]!), 66)
    assert.equal(stringWidth(narrowLines[1]!), 189)
    assert.equal(stringWidth(narrowLines[2]!), 192)
    assert.ok(stripSgr(narrowLines[1]!).includes('+2 !3 ?4 ⇡1 ⇣2'))
    assert.ok(stripSgr(narrowLines[2]!).includes('⌛stale'))
  })

  test('rejects unknown names including Object prototype properties', () => {
    for (const bad of ['nope', 'constructor', 'toString', '__proto__', '', 'day light', 'aurora', 'ember', 'nebula', 'tokyo-night', 'agy--tokyonight']) {
      assert.throws(() => runThemes([bad]), /Unknown theme.*auto, agy-tokyonight, codex-ink, claude-terracotta, omo-violet, graphite, daylight, custom/)
    }
  })

  test('previews partial and full customTheme in its resolved polarity section and errors cleanly when absent', async () => {
    assert.throws(
      () => runThemes(['custom']),
      /No valid customTheme configured in vargus\.jsonc/,
    )

    const partial = runThemes([' Custom '], {
      checkoutOptions: { theme: 'daylight', customTheme: { label: '#112233' } },
    })
    assert.equal(partial.code, 0)
    assert.ok(partial.out.startsWith('\x1b[1mLight themes (#ffffff)\x1b[22m\n\ncustom (vargus.jsonc, base: daylight)\n'))
    assert.ok(partial.out.includes('\x1b[48;2;255;255;255m'))
    assert.ok(partial.out.includes(makeTheme('daylight', false, undefined, { label: '#112233' }).paint('label', 'label').replace(/\x1b\[0m$/, '')))

    const allNine = Object.fromEntries(TOKEN_NAMES.map((tok, i) => [tok, `#20304${i}`]))
    const full = runThemes([], {
      noColor: true,
      checkoutOptions: { theme: 'daylight', customTheme: { polarity: 'dark', ...allNine } },
    })
    assert.equal(full.code, 0)
    const sections = full.out.trimEnd().split('\n\n\n')
    assert.match(sections[0]!, /custom \(vargus\.jsonc\)/)
    assert.doesNotMatch(sections[1]!, /custom \(vargus\.jsonc\)/)

    const dir = await mkdtemp(join(tmpdir(), 'vargus-themes-custom-'))
    try {
      const checkout = await fixtureCheckout(dir)
      const env = { ...process.env, VARGUS_CLI_MAIN: '1', NO_COLOR: '', WSL_DISTRO_NAME: '', WSL_INTEROP: '', WSLENV: '' }
      await writeFile(join(checkout, 'vargus.jsonc'), '// custom\n{"theme":"auto","customTheme":{"polarity":"light","text":"#123456"}}')
      const customCli = await execFileAsync(process.execPath, [join(checkout, 'src/cli.ts'), 'themes', 'custom'], { env })
      assert.ok(customCli.stdout.startsWith('\x1b[1mLight themes (#ffffff)\x1b[22m\n\ncustom (vargus.jsonc, base: graphite)\n'))

      // Broken vargus.jsonc must not block bundled themes, while `themes custom` reports the parse error.
      await writeFile(join(checkout, 'vargus.jsonc'), '{broken')
      const bundledCli = await execFileAsync(process.execPath, [join(checkout, 'src/cli.ts'), 'themes', 'graphite'], { env })
      assert.ok(bundledCli.stdout.startsWith('\x1b[1mDark themes (#181818)\x1b[22m\n\ngraphite\n'))
      await assert.rejects(
        execFileAsync(process.execPath, [join(checkout, 'src/cli.ts'), 'themes', 'custom'], { env }),
        (err: Error & { code?: number; stderr?: string }) => err.code === 1 && /Expected a VArgus JSON options object/.test(err.stderr ?? ''),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('supports --help and rejects unknown flags or extra arguments', () => {
    const { code, out } = runThemes(['--help'])
    assert.equal(code, 0)
    assert.match(out, /vargus themes \[NAME\]/)
    assert.match(out, /#181818.*#ffffff/)
    assert.match(out, /Default: auto \(uses agy-tokyonight, codex-ink, claude-terracotta, omo-violet by host\)\./)
    assert.match(out, /Dark themes: agy-tokyonight, codex-ink, claude-terracotta, omo-violet, graphite\./)
    assert.match(out, /Light themes: daylight\./)
    assert.throws(() => runThemes(['--unknown']), /Usage:/)
    assert.throws(() => runThemes(['graphite', 'codex-ink']), /Usage:/)
    assert.throws(() => runThemes(['agy-tokyonight', '']), /Usage:/)
    assert.throws(() => runThemes(['auto', 'graphite']), /Usage:/)
    assert.throws(() => runThemes(['auto', '']), /Usage:/)
  })

  test('respects noColor and isWsl flags without leaking escapes or trailing spaces', () => {
    const plainAll = runThemes([], { noColor: true })
    assert.equal(plainAll.code, 0)
    assert.doesNotMatch(plainAll.out, /\x1b\[/)
    const sections = plainAll.out.trimEnd().split('\n\n\n')
    assert.equal(sections.length, 2)
    assert.equal(sections[0]!.split('\n\n')[0], 'Dark themes')
    assert.equal(sections[1]!.split('\n\n')[0], 'Light themes')
    for (const line of plainAll.out.split('\n')) {
      assert.equal(line, line.trimEnd())
    }

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

  test('runs via CLI entrypoint with dark/light backgrounds, NO_COLOR and non-zero exit on invalid theme', async () => {
    const envBase = { ...process.env, VARGUS_CLI_MAIN: '1', WSL_DISTRO_NAME: '', WSL_INTEROP: '', WSLENV: '' }
    const dark = await execFileAsync(process.execPath, ['src/cli.ts', 'themes', 'graphite'], {
      env: { ...envBase, NO_COLOR: '' },
    })
    assert.ok(dark.stdout.startsWith('\x1b[1mDark themes (#181818)\x1b[22m\n\ngraphite\n'))
    assert.ok(dark.stdout.includes('\x1b[48;2;24;24;24m'))
    assert.ok(dark.stdout.includes(makeTheme('graphite', false).paint('text', 'text').replace(/\x1b\[0m$/, '')))

    const auto = await execFileAsync(process.execPath, ['src/cli.ts', 'themes', 'auto'], {
      env: { ...envBase, NO_COLOR: '' },
    })
    assert.ok(auto.stdout.startsWith('\x1b[1mDark themes (#181818)\x1b[22m\n\nagy-tokyonight (auto: Antigravity)\n'))
    assert.ok(auto.stdout.includes('omo-violet (auto: OmO)\n'))

    const tokyo = await execFileAsync(process.execPath, ['src/cli.ts', 'themes', 'agy tokyonight'], {
      env: { ...envBase, NO_COLOR: '' },
    })
    assert.ok(tokyo.stdout.startsWith('\x1b[1mDark themes (#181818)\x1b[22m\n\nagy-tokyonight (auto: Antigravity)\n'))
    assert.ok(tokyo.stdout.includes('\x1b[48;2;24;24;24m'))

    const light = await execFileAsync(process.execPath, ['src/cli.ts', 'themes', 'daylight'], {
      env: { ...envBase, NO_COLOR: '' },
    })
    assert.ok(light.stdout.startsWith('\x1b[1mLight themes (#ffffff)\x1b[22m\n\ndaylight\n'))
    assert.ok(light.stdout.includes('\x1b[48;2;255;255;255m'))

    const plain = await execFileAsync(process.execPath, ['src/cli.ts', 'themes', 'graphite'], {
      env: { ...envBase, NO_COLOR: '1' },
    })
    assert.doesNotMatch(plain.stdout, /\x1b\[/)
    assert.ok(plain.stdout.startsWith('Dark themes\n\ngraphite\n'))

    const withWslenv = await execFileAsync(process.execPath, ['src/cli.ts', 'themes', 'graphite'], {
      env: { ...envBase, NO_COLOR: '1', WSLENV: 'WT_SESSION:WT_PROFILE_ID:' },
    })
    if (!detectWsl({ WSL_DISTRO_NAME: '', WSL_INTEROP: '' })) {
      assert.ok(withWslenv.stdout.includes('🔧73 🤖2 ⚡1'))
      assert.ok(withWslenv.stdout.includes('⌛stale'))
      assert.doesNotMatch(withWslenv.stdout, /T:73|!:stale/)
    }

    const withDistro = await execFileAsync(process.execPath, ['src/cli.ts', 'themes', 'graphite'], {
      env: { ...envBase, NO_COLOR: '1', WSL_DISTRO_NAME: 'Ubuntu' },
    })
    if (process.platform === 'linux') {
      assert.ok(withDistro.stdout.includes('T:73 A:2 S:1'))
      assert.ok(withDistro.stdout.includes('!:stale'))
      assert.doesNotMatch(withDistro.stdout, /[🔧🤖⚡⌛]/)
    } else if (process.platform === 'win32') {
      assert.ok(withDistro.stdout.includes('🔧73 🤖2 ⚡1'))
      assert.ok(withDistro.stdout.includes('⌛stale'))
    }

    await assert.rejects(
      execFileAsync(process.execPath, ['src/cli.ts', 'themes', 'nope'], { env: { ...envBase, NO_COLOR: '' } }),
      (err: Error & { code?: number; stderr?: string }) => err.code === 1 && /Unknown theme: nope/.test(err.stderr ?? ''),
    )
  })
})
