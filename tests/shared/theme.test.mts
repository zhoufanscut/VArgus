import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import type { Rgb, TokenName } from '../../src/core/types.ts'
import {
  AUTO_THEME, CUSTOM_THEME, FALLBACK_THEME, lookupPaletteName, makeTheme,
  parseCustomTheme, resolvePalette, resolveThemeOption, sameCustomTheme,
} from '../../src/theme/index.ts'
import { PALETTES, PALETTE_POLARITY, TOKEN_NAMES } from '../../src/theme/palettes.ts'

// Themes (DESIGN, "Colours", "Rules carried over from VantageHUD", Themes).

function hexToRgb(hex: string): Rgb {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]
}

function srgbToLin(c: number): number {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

function relLum([r, g, b]: Rgb): number {
  return 0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b)
}

function contrast(fg: Rgb, bg: Rgb): number {
  const l1 = relLum(fg)
  const l2 = relLum(bg)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

function rgbToOklab([r8, g8, b8]: Rgb): readonly [number, number, number] {
  const r = srgbToLin(r8)
  const g = srgbToLin(g8)
  const b = srgbToLin(b8)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ]
}

function lightness(rgb: Rgb): number {
  return rgbToOklab(rgb)[0]
}

function chroma(rgb: Rgb): number {
  const [, a, b] = rgbToOklab(rgb)
  return Math.hypot(a, b)
}

function hue(rgb: Rgb): number {
  const [, a, b] = rgbToOklab(rgb)
  return (Math.atan2(b, a) * 180 / Math.PI + 360) % 360
}

function hueDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

function oklabDist(x: Rgb, y: Rgb): number {
  const [l1, a1, b1] = rgbToOklab(x)
  const [l2, a2, b2] = rgbToOklab(y)
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2)
}

describe('theme', () => {
  test('bundled palettes share 9 tokens with explicit polarity; auto and graphite fallback constants are defined', () => {
    assert.deepEqual(Object.keys(PALETTES), ['agy-tokyonight', 'codex-ink', 'claude-terracotta', 'omo-violet', 'graphite', 'daylight'])
    assert.deepEqual(PALETTE_POLARITY, {
      'agy-tokyonight': 'dark',
      'codex-ink': 'dark',
      'claude-terracotta': 'dark',
      'omo-violet': 'dark',
      graphite: 'dark',
      daylight: 'light',
    })
    const tokens = ['text', 'label', 'detail', 'sep', 'calm', 'alert', 'add', 'del', 'track']
    for (const p of Object.values(PALETTES)) {
      assert.deepEqual(Object.keys(p), tokens)
      for (const hex of Object.values(p)) assert.match(hex, /^#[0-9a-f]{6}$/)
    }
    assert.equal(AUTO_THEME, 'auto')
    assert.equal(FALLBACK_THEME, 'graphite')
    assert.equal(resolvePalette('codex-ink').polarity, 'dark')
    assert.equal(resolvePalette('agy-tokyonight').polarity, 'dark')
    assert.equal(resolvePalette('daylight').polarity, 'light')
    assert.deepEqual(resolvePalette('claude-terracotta').rgb.alert, [0xff, 0x6b, 0x80])
  })

  test('every palette\'s 9 tokens match the unified OKLCH palette definitions', () => {
    // token order: text label detail sep calm alert add del track
    const expected: Record<string, string> = {
      'agy-tokyonight': '#e2e8f6 #8babee #8890b3 #474b5b #c2cbf3 #f7768e #94af7b #c78c94 #67aebd',
      'codex-ink': '#eceff2 #74a8e6 #8e949c #45484b #c9d0d9 #ff7976 #7ea989 #c38d8a #a294c1',
      'claude-terracotta': '#fcf1ea #dd947d #a38b7e #4c3f3a #e6c8b9 #ff6b80 #85ac89 #c08b8c #81a4c7',
      'omo-violet': '#ebeaf3 #ac9be0 #908c9d #48464e #cfcae3 #ff7d80 #79a88d #c18c8b #78a1c1',
      graphite: '#ededed #aeaeae #929292 #4a4a4a #d1d1d1 #f47e7c #8aaa8b #bc908e #86a1c0',
      daylight: '#181d24 #20548a #5b6e81 #c3c8ce #253a4e #bb1423 #3f764c #945451 #676099',
    }
    const ours = Object.fromEntries(Object.entries(PALETTES).map(([name, p]) => [name, Object.values(p).join(' ')]))
    assert.deepEqual(ours, expected)
  })

  test('every palette satisfies the contrast ladder, alarm isolation, and pair-separation rules', () => {
    const adjacentPairs: readonly [TokenName, TokenName][] = [
      ['text', 'calm'],
      ['text', 'label'],
      ['label', 'calm'],
      ['calm', 'detail'],
      ['label', 'detail'],
      ['text', 'detail'],
      ['label', 'alert'],
      ['calm', 'alert'],
      ['alert', 'detail'],
      ['text', 'alert'],
      ['del', 'alert'],
      ['add', 'del'],
      ['add', 'track'],
      ['del', 'track'],
    ]

    for (const [name, p] of Object.entries(PALETTES)) {
      const rgb = Object.fromEntries(
        Object.entries(p).map(([k, hex]) => [k, hexToRgb(hex)]),
      ) as Record<TokenName, Rgb>
      const isLight = PALETTE_POLARITY[name] === 'light'
      const bgTyp: Rgb = isLight ? [0xff, 0xff, 0xff] : [0x18, 0x18, 0x18]
      const bgWst: Rgb = isLight ? [0xf6, 0xf8, 0xfa] : [0x28, 0x28, 0x28]
      const bgWstLum = relLum(bgWst)

      for (const tok of ['text', 'label', 'detail', 'sep', 'calm', 'alert', 'add', 'del', 'track'] as const) {
        const tokLum = relLum(rgb[tok])
        assert.ok(isLight ? tokLum < bgWstLum : tokLum > bgWstLum, `${name}.${tok} polarity wrong for ${isLight ? 'light' : 'dark'} theme`)
      }

      for (const tok of ['text', 'calm', 'label', 'detail', 'add', 'del', 'track'] as const) {
        const cr = contrast(rgb[tok], bgWst)
        assert.ok(cr >= 4.5, `${name}.${tok} worst-case contrast ${cr.toFixed(2)} < 4.5`)
      }
      const alertCr = contrast(rgb.alert, bgWst)
      const delCr = contrast(rgb.del, bgWst)
      assert.ok(alertCr >= 5.0, `${name}.alert worst-case contrast ${alertCr.toFixed(2)} < 5.0`)
      assert.ok(alertCr >= delCr, `${name}.alert contrast ${alertCr.toFixed(2)} < del ${delCr.toFixed(2)}`)
      const sepWst = contrast(rgb.sep, bgWst)
      const sepTyp = contrast(rgb.sep, bgTyp)
      assert.ok(sepWst >= 1.4 && sepTyp <= 2.5, `${name}.sep contrast ${sepWst.toFixed(2)}..${sepTyp.toFixed(2)} out of 1.4..2.5`)

      const ladder = (['text', 'calm', 'label', 'detail', 'sep'] as const).map(tok => contrast(rgb[tok], bgWst))
      for (let i = 0; i < ladder.length - 1; i++) {
        assert.ok(ladder[i]! > ladder[i + 1]!, `${name} contrast ladder failed at index ${i}: ${ladder.join(' > ')}`)
      }

      const rampTokens = ['text', 'calm', 'label', 'detail', 'sep'] as const
      if (name === 'graphite') {
        for (const tok of rampTokens) {
          const c = chroma(rgb[tok])
          assert.ok(c <= 1e-6, `${name}.${tok} ramp chroma ${c.toFixed(4)} > 1e-6`)
        }
      } else {
        for (const tok of ['text', 'sep'] as const) {
          const c = chroma(rgb[tok])
          assert.ok(c <= 0.03, `${name}.${tok} chroma ${c.toFixed(4)} > 0.03`)
        }
        for (const tok of ['calm', 'detail'] as const) {
          const c = chroma(rgb[tok])
          assert.ok(c <= 0.06, `${name}.${tok} chroma ${c.toFixed(4)} > 0.06`)
        }
        const labelC = chroma(rgb.label)
        assert.ok(labelC >= 0.08 && labelC <= 0.11, `${name}.label chroma ${labelC.toFixed(4)} outside 0.08..0.11`)

        const rampHues = rampTokens.map(tok => hue(rgb[tok]))
        for (let i = 0; i < rampHues.length; i++) {
          for (let j = i + 1; j < rampHues.length; j++) {
            const d = hueDist(rampHues[i]!, rampHues[j]!)
            assert.ok(d <= 35, `${name} ramp hue spread ${rampTokens[i]}-${rampTokens[j]} ${d.toFixed(1)}° > 35°`)
          }
        }
      }

      const alertHue = hue(rgb.alert)
      const delHue = hue(rgb.del)
      const addHue = hue(rgb.add)
      const trackHue = hue(rgb.track)
      assert.ok(hueDist(alertHue, 18) <= 20, `${name}.alert hue ${alertHue.toFixed(1)}° outside red family`)
      assert.ok(hueDist(delHue, 18) <= 20, `${name}.del hue ${delHue.toFixed(1)}° outside red family`)
      assert.ok(addHue >= 120 && addHue <= 165, `${name}.add hue ${addHue.toFixed(1)}° outside green family`)
      assert.ok(
        hueDist(trackHue, addHue) >= 75 && hueDist(trackHue, delHue) >= 75,
        `${name}.track hue ${trackHue.toFixed(1)}° too close to add (${addHue.toFixed(1)}°) or del (${delHue.toFixed(1)}°)`,
      )

      const vcsL = [lightness(rgb.add), lightness(rgb.del), lightness(rgb.track)]
      assert.ok(Math.max(...vcsL) - Math.min(...vcsL) <= 0.03, `${name} VCS lightness spread > 0.03`)
      const labelL = lightness(rgb.label)
      const detailL = lightness(rgb.detail)
      const minBandL = Math.min(labelL, detailL)
      const maxBandL = Math.max(labelL, detailL)
      const labelCr = contrast(rgb.label, bgWst)
      const detailCr = contrast(rgb.detail, bgWst)
      for (const tok of ['add', 'del', 'track'] as const) {
        const l = lightness(rgb[tok])
        const cr = contrast(rgb[tok], bgWst)
        assert.ok(l > minBandL && l < maxBandL, `${name}.${tok} lightness ${l.toFixed(3)} not strictly between ${minBandL.toFixed(3)} and ${maxBandL.toFixed(3)}`)
        assert.ok(cr > detailCr && cr < labelCr, `${name}.${tok} contrast ${cr.toFixed(2)} not strictly between detail (${detailCr.toFixed(2)}) and label (${labelCr.toFixed(2)})`)
      }
      const vcsC = [chroma(rgb.add), chroma(rgb.del), chroma(rgb.track)]
      assert.ok(Math.max(...vcsC) - Math.min(...vcsC) <= 0.015, `${name} VCS chroma spread > 0.015`)

      const alertChroma = chroma(rgb.alert)
      const delChroma = chroma(rgb.del)
      assert.ok(alertChroma >= 2 * delChroma, `${name}.alert chroma ${alertChroma.toFixed(4)} < 2x del ${delChroma.toFixed(4)}`)
      assert.ok(alertChroma >= 1.5 * chroma(rgb.label), `${name}.alert chroma ${alertChroma.toFixed(4)} < 1.5x label ${chroma(rgb.label).toFixed(4)}`)
      for (const tok of ['text', 'label', 'detail', 'sep', 'calm', 'add', 'del', 'track'] as const) {
        assert.ok(chroma(rgb[tok]) < alertChroma, `${name}.${tok} chroma >= alert`)
      }

      for (const [a, b] of adjacentPairs) {
        const dist = oklabDist(rgb[a], rgb[b])
        assert.ok(dist >= 0.08, `${name} ${a}-${b} OKLab distance ${dist.toFixed(3)} < 0.08`)
      }
    }
  })

  test('an unknown name, constructor and toString included, falls back to graphite; names ignore case and whitespace', () => {
    for (const name of ['nope', 'constructor', 'toString', '__proto__', '', 'day light', 'aurora', 'ember', 'nebula', 'tokyo-night', 'agy--tokyonight']) {
      assert.equal(lookupPaletteName(name), undefined)
      const resolved = resolvePalette(name)
      assert.equal(resolved.name, 'graphite')
      assert.equal(resolved.polarity, 'dark')
    }
    assert.equal(resolvePalette(' Daylight ').name, 'daylight')
    for (const alias of ['agy-tokyonight', 'agy tokyonight', ' Agy  TokyoNight ', 'AGY\tTOKYONIGHT']) {
      assert.equal(lookupPaletteName(alias), 'agy-tokyonight')
      const resolved = resolvePalette(alias)
      assert.equal(resolved.name, 'agy-tokyonight')
      assert.equal(resolved.polarity, 'dark')
      assert.deepEqual(resolved.rgb.alert, [0xf7, 0x76, 0x8e])
      assert.equal(makeTheme(alias, false).name, 'agy-tokyonight')
    }
    assert.deepEqual(makeTheme('constructor', false).rgb.text, [0xed, 0xed, 0xed])
  })

  test('auto resolves to a valid host palette, keeps auto canonical in resolveThemeOption, and falls back to graphite otherwise', () => {
    assert.equal(lookupPaletteName('auto'), undefined)
    assert.equal(resolveThemeOption('auto'), 'auto')
    assert.equal(resolveThemeOption(' Auto '), 'auto')
    assert.equal(resolveThemeOption('AUTO'), 'auto')
    assert.equal(resolveThemeOption(' Agy  TokyoNight '), 'agy-tokyonight')
    for (const unknown of ['nope', 'constructor', 'ember', '']) {
      assert.equal(resolveThemeOption(unknown), 'graphite')
    }

    for (const host of ['agy-tokyonight', 'codex-ink', 'claude-terracotta', 'omo-violet'] as const) {
      assert.equal(resolvePalette('auto', host).name, host)
      assert.equal(makeTheme(' Auto ', false, host).name, host)
    }
    assert.equal(resolvePalette('auto').name, 'graphite')
    assert.equal(resolvePalette('auto', 'constructor').name, 'graphite')
    assert.equal(resolvePalette('auto', 'nope').name, 'graphite')
    assert.equal(resolvePalette('daylight', 'agy-tokyonight').name, 'daylight')
    assert.equal(resolvePalette('graphite', 'codex-ink').name, 'graphite')
    assert.equal(resolvePalette('nope', 'agy-tokyonight').name, 'graphite')
    assert.equal(resolvePalette('ember', 'codex-ink').name, 'graphite')
  })

  test('paint is a 24-bit SGR code and a reset; bold ends bold alone', () => {
    const t = makeTheme('agy-tokyonight', false)
    assert.equal(t.paint('label', 'ctx:'), '\x1b[38;2;139;171;238mctx:\x1b[0m')
    assert.equal(t.paint([1, 2, 3], 'x'), '\x1b[38;2;1;2;3mx\x1b[0m')
    assert.equal(t.bold('x'), '\x1b[1mx\x1b[22m')
  })

  test('NO_COLOR: every call returns its text with no escape at all', () => {
    const t = makeTheme('agy-tokyonight', true)
    assert.equal(t.paint('label', 'ctx:'), 'ctx:')
    assert.equal(t.paint([1, 2, 3], 'x'), 'x')
    assert.equal(t.bold('x'), 'x')
  })

  test('parseCustomTheme validates tokens and polarity, ignores bad entries, and guards against prototype keys', () => {
    assert.equal(parseCustomTheme(undefined), undefined)
    assert.equal(parseCustomTheme(null), undefined)
    assert.equal(parseCustomTheme([]), undefined)
    assert.equal(parseCustomTheme('red'), undefined)
    assert.equal(parseCustomTheme({}), undefined)
    assert.equal(parseCustomTheme({ polarity: 'dark' }), undefined)
    assert.equal(parseCustomTheme({ text: '#123', label: 'blue', sep: '#GGGGGG' }), undefined)

    const proto = Object.create({ text: '#112233', polarity: 'light' })
    assert.equal(parseCustomTheme(proto), undefined)

    const parsed = parseCustomTheme({
      polarity: ' LIGHT ',
      text: ' #AABBCC ',
      sep: '#12345',
      alert: 42,
      unknown: '#ffffff',
    })
    assert.deepEqual(parsed, { polarity: 'light', text: '#aabbcc' })
    assert.equal(parseCustomTheme({ polarity: 'neon', label: '#112233' })?.polarity, undefined)
    assert.equal(parseCustomTheme({ polarity: 'neon', label: '#112233' })?.label, '#112233')

    assert.equal(sameCustomTheme(undefined, undefined), true)
    assert.equal(sameCustomTheme({ text: '#112233' }, undefined), false)
    assert.equal(sameCustomTheme({ text: '#112233' }, { text: '#112233' }), true)
    assert.equal(sameCustomTheme({ polarity: 'dark', text: '#112233' }, { text: '#112233' }), false)
  })

  test('customTheme supports partial and full overlays, polarity inheritance/override, and NO_COLOR', () => {
    const partial = resolvePalette('auto', 'agy-tokyonight', { sep: '#123456' })
    assert.equal(partial.name, CUSTOM_THEME)
    assert.equal(partial.polarity, 'dark')
    assert.deepEqual(partial.rgb.sep, [0x12, 0x34, 0x56])
    assert.deepEqual(partial.rgb.text, resolvePalette('agy-tokyonight').rgb.text)

    const lightBase = resolvePalette('daylight', undefined, { label: '#112233' })
    assert.equal(lightBase.name, CUSTOM_THEME)
    assert.equal(lightBase.polarity, 'light')
    assert.deepEqual(lightBase.rgb.label, [0x11, 0x22, 0x33])
    assert.deepEqual(lightBase.rgb.text, resolvePalette('daylight').rgb.text)

    const polarityOverride = resolvePalette('daylight', undefined, { polarity: 'dark', text: '#ffffff' })
    assert.equal(polarityOverride.polarity, 'dark')

    const fullInput = Object.fromEntries(TOKEN_NAMES.map((tok, i) => [tok, `#10203${i}`])) as Record<TokenName, string>
    const full = makeTheme('graphite', false, undefined, { polarity: 'light', ...fullInput })
    assert.equal(full.name, CUSTOM_THEME)
    assert.equal(full.paint('text', 'a'), '\x1b[38;2;16;32;48ma\x1b[0m')
    assert.equal(full.paint('track', 'b'), '\x1b[38;2;16;32;56mb\x1b[0m')

    const plain = makeTheme('graphite', true, undefined, { text: '#112233' })
    assert.equal(plain.name, CUSTOM_THEME)
    assert.equal(plain.paint('text', 'a'), 'a')
  })
})
