import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import type { Rgb, TokenName } from '../../src/core/types.ts'
import { DEFAULT_THEME, makeTheme, resolvePalette } from '../../src/theme/index.ts'
import { PALETTES, PALETTE_POLARITY } from '../../src/theme/palettes.ts'

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
  test('five bundled palettes of the same 9 tokens with explicit polarity; graphite is the default', () => {
    assert.deepEqual(Object.keys(PALETTES), ['aurora', 'ember', 'nebula', 'graphite', 'daylight'])
    assert.deepEqual(PALETTE_POLARITY, {
      aurora: 'dark',
      ember: 'dark',
      nebula: 'dark',
      graphite: 'dark',
      daylight: 'light',
    })
    const tokens = ['text', 'label', 'detail', 'sep', 'calm', 'alert', 'add', 'del', 'track']
    for (const p of Object.values(PALETTES)) {
      assert.deepEqual(Object.keys(p), tokens)
      for (const hex of Object.values(p)) assert.match(hex, /^#[0-9a-f]{6}$/)
    }
    assert.equal(DEFAULT_THEME, 'graphite')
    assert.equal(resolvePalette('ember').polarity, 'dark')
    assert.equal(resolvePalette('daylight').polarity, 'light')
    assert.deepEqual(resolvePalette('ember').rgb.alert, [0xfe, 0x77, 0x68])
  })

  test('every palette\'s 9 tokens match the unified OKLCH palette definitions', () => {
    // token order: text label detail sep calm alert add del track
    const expected: Record<string, string> = {
      aurora: '#dfeaef #69b8d0 #7898a7 #434f57 #add6e0 #f6808d #82b291 #c59094 #78aac9',
      ember: '#eee7db #d3a067 #a58d78 #544b44 #e1caa6 #fe7768 #93ad78 #c78c83 #72a9c2',
      nebula: '#e6e7f2 #b2a2e4 #8c90ae #4a4c59 #cacaeb #f87f99 #86b689 #c99099 #85a6d7',
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

  test('an unknown name, constructor and toString included, falls back to graphite; names ignore case', () => {
    for (const name of ['nope', 'constructor', 'toString', '__proto__', '']) {
      const resolved = resolvePalette(name)
      assert.equal(resolved.name, 'graphite')
      assert.equal(resolved.polarity, 'dark')
    }
    assert.equal(resolvePalette(' Ember ').name, 'ember')
    assert.deepEqual(makeTheme('constructor', false).rgb.text, [0xed, 0xed, 0xed])
  })

  test('paint is a 24-bit SGR code and a reset; bold ends bold alone', () => {
    const t = makeTheme('aurora', false)
    assert.equal(t.paint('label', 'ctx:'), '\x1b[38;2;105;184;208mctx:\x1b[0m')
    assert.equal(t.paint([1, 2, 3], 'x'), '\x1b[38;2;1;2;3mx\x1b[0m')
    assert.equal(t.bold('x'), '\x1b[1mx\x1b[22m')
  })

  test('NO_COLOR: every call returns its text with no escape at all', () => {
    const t = makeTheme('aurora', true)
    assert.equal(t.paint('label', 'ctx:'), 'ctx:')
    assert.equal(t.paint([1, 2, 3], 'x'), 'x')
    assert.equal(t.bold('x'), 'x')
  })
})
