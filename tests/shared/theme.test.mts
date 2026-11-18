import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_THEME, makeTheme, resolvePalette } from '../../src/theme/index.ts'
import { PALETTES } from '../../src/theme/palettes.ts'

// Themes (DESIGN, "Colours", "Rules carried over from VantageHUD", Themes).

describe('theme', () => {
  test('five bundled palettes of the same 10 tokens; graphite is the default', () => {
    assert.deepEqual(Object.keys(PALETTES), ['aurora', 'ember', 'nebula', 'graphite', 'daylight'])
    const tokens = ['text', 'label', 'faint', 'sep', 'gradLow', 'gradMid', 'gradHigh', 'add', 'del', 'track']
    for (const p of Object.values(PALETTES)) {
      assert.deepEqual(Object.keys(p), tokens)
      for (const hex of Object.values(p)) assert.match(hex, /^#[0-9a-f]{6}$/)
    }
    assert.equal(DEFAULT_THEME, 'graphite')
    assert.deepEqual(resolvePalette('ember').rgb.gradHigh, [0xfb, 0x49, 0x34])
  })

  test('every palette\'s 10 tokens are VantageHUD 0.6.0\'s (src/hud/themes.js)', () => {
    // token order: text label faint sep gradLow gradMid gradHigh add del track
    const vantageHud: Record<string, string> = {
      aurora: '#c8d3e8 #8fd0d8 #6e7896 #48506a #72d3c3 #e6c38d #e0909e #8fd0b8 #e0909e #8dc2d6',
      ember: '#ebdbb2 #a89984 #928374 #665c54 #969619 #f1bf3c #fb4934 #969619 #fb4934 #fe8019',
      nebula: '#cdd6f4 #cba6f7 #6c7086 #45475a #94e2d5 #f9e2af #f38ba8 #a6e3a1 #f38ba8 #89b4fa',
      graphite: '#e6e6e6 #9e9e9e #7d7d7d #3f3f3f #b0b0b0 #b8964f #cd6a6a #8fa88f #b08f8f #8f9db0',
      daylight: '#24292f #0550ae #6e7781 #d0d7de #0a7c5a #966d00 #cf222e #116329 #cf222e #8250df',
    }
    const ours = Object.fromEntries(Object.entries(PALETTES).map(([name, p]) => [name, Object.values(p).join(' ')]))
    assert.deepEqual(ours, vantageHud)
  })

  test('an unknown name, constructor and toString included, falls back to graphite; names ignore case', () => {
    for (const name of ['nope', 'constructor', 'toString', '__proto__', '']) {
      assert.equal(resolvePalette(name).name, 'graphite')
    }
    assert.equal(resolvePalette(' Ember ').name, 'ember')
    assert.deepEqual(makeTheme('constructor', false).rgb.text, [0xe6, 0xe6, 0xe6])
  })

  test('paint is a 24-bit SGR code and a reset; bold ends bold alone', () => {
    const t = makeTheme('aurora', false)
    assert.equal(t.paint('label', 'ctx:'), '\x1b[38;2;143;208;216mctx:\x1b[0m')
    assert.equal(t.paint([1, 2, 3], 'x'), '\x1b[38;2;1;2;3mx\x1b[0m')
    assert.equal(t.bold('x'), '\x1b[1mx\x1b[22m')
  })

  test('NO_COLOR: every call returns its text with no escape at all', () => {
    const t = makeTheme('aurora', true)
    assert.equal(t.paint('label', 'ctx:'), 'ctx:')
    assert.equal(t.paint([1, 2, 3], 'x'), 'x')
    assert.equal(t.bold('x'), 'x')
  })

  test('gradient: three flat tiers at 70 and 85 by default, percent clamped', () => {
    const t = makeTheme('aurora', false)
    const { gradLow, gradMid, gradHigh } = t.rgb
    assert.deepEqual([-5, 0, 69.9].map(p => t.gradient(p)), [gradLow, gradLow, gradLow])
    assert.deepEqual([70, 84.9].map(p => t.gradient(p)), [gradMid, gradMid])
    assert.deepEqual([85, 100, 250].map(p => t.gradient(p)), [gradHigh, gradHigh, gradHigh])
    assert.deepEqual(t.gradient(50, [40, 60]), gradMid)
    // the tier index is clamped: three bounds passed all give the alert tier
    assert.deepEqual(t.gradient(90, [10, 20, 30] as unknown as [number, number]), gradHigh)
  })
})
