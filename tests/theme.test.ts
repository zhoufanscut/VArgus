import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_THEME, lerp, makeTheme, resolvePalette } from '../src/theme'
import { PALETTES } from '../src/theme/palettes'

// Themes (DESIGN, "Colours", "Rules carried over from VantageHUD", Themes).

describe('theme', () => {
  test('five bundled palettes of the same 10 tokens; graphite is the default', async () => {
    expect(Object.keys(PALETTES)).toEqual(['aurora', 'ember', 'nebula', 'graphite', 'daylight'])
    const tokens = ['text', 'label', 'faint', 'sep', 'gradLow', 'gradMid', 'gradHigh', 'add', 'del', 'track']
    for (const p of Object.values(PALETTES)) {
      expect(Object.keys(p)).toEqual(tokens)
      for (const hex of Object.values(p)) expect(hex).toMatch(/^#[0-9a-f]{6}$/)
    }
    expect(DEFAULT_THEME).toBe('graphite')
    expect(resolvePalette('ember').rgb.gradHigh).toEqual([0xfb, 0x49, 0x34])
  })

  test('every palette\'s 10 tokens are VantageHUD 0.6.0\'s (src/hud/themes.js)', async () => {
    // token order: text label faint sep gradLow gradMid gradHigh add del track
    const vantageHud: Record<string, string> = {
      aurora: '#c8d3e8 #8fd0d8 #6e7896 #48506a #72d3c3 #e6c38d #e0909e #8fd0b8 #e0909e #8dc2d6',
      ember: '#ebdbb2 #a89984 #928374 #665c54 #969619 #f1bf3c #fb4934 #969619 #fb4934 #fe8019',
      nebula: '#cdd6f4 #cba6f7 #6c7086 #45475a #94e2d5 #f9e2af #f38ba8 #a6e3a1 #f38ba8 #89b4fa',
      graphite: '#e6e6e6 #9e9e9e #7d7d7d #3f3f3f #b0b0b0 #b8964f #cd6a6a #8fa88f #b08f8f #8f9db0',
      daylight: '#24292f #0550ae #6e7781 #d0d7de #0a7c5a #966d00 #cf222e #116329 #cf222e #8250df',
    }
    const ours = Object.fromEntries(Object.entries(PALETTES).map(([name, p]) => [name, Object.values(p).join(' ')]))
    expect(ours).toEqual(vantageHud)
  })

  test('an unknown name, constructor and toString included, falls back to graphite; names ignore case', async () => {
    for (const name of ['nope', 'constructor', 'toString', '__proto__', '']) {
      expect(resolvePalette(name).name).toBe('graphite')
    }
    expect(resolvePalette(' Ember ').name).toBe('ember')
    expect(makeTheme('constructor', false).rgb.text).toEqual([0xe6, 0xe6, 0xe6])
  })

  test('paint is a 24-bit SGR code and a reset; bold ends bold alone', async () => {
    const t = makeTheme('aurora', false)
    expect(t.paint('label', 'ctx:')).toBe('\x1b[38;2;143;208;216mctx:\x1b[0m')
    expect(t.paint([1, 2, 3], 'x')).toBe('\x1b[38;2;1;2;3mx\x1b[0m')
    expect(t.bold('x')).toBe('\x1b[1mx\x1b[22m')
  })

  test('NO_COLOR: every call returns its text with no escape at all', async () => {
    const t = makeTheme('aurora', true)
    expect(t.paint('label', 'ctx:')).toBe('ctx:')
    expect(t.paint([1, 2, 3], 'x')).toBe('x')
    expect(t.bold('x')).toBe('x')
  })

  test('gradient: three flat tiers at 70 and 85 by default, percent clamped', async () => {
    const t = makeTheme('aurora', false)
    const { gradLow, gradMid, gradHigh } = t.rgb
    expect([-5, 0, 69.9].map(p => t.gradient(p))).toEqual([gradLow, gradLow, gradLow])
    expect([70, 84.9].map(p => t.gradient(p))).toEqual([gradMid, gradMid])
    expect([85, 100, 250].map(p => t.gradient(p))).toEqual([gradHigh, gradHigh, gradHigh])
    expect(t.gradient(50, [40, 60])).toEqual(gradMid)
    // the tier index is clamped: three bounds passed all give the alert tier
    expect(t.gradient(90, [10, 20, 30] as unknown as [number, number])).toEqual(gradHigh)
  })

  test('lerp: RGB, t clamped to 0..1, channels rounded', async () => {
    expect(lerp([0, 0, 0], [255, 100, 11], 0.5)).toEqual([128, 50, 6])
    expect(lerp([0, 0, 0], [10, 10, 10], 2)).toEqual([10, 10, 10])
    expect(lerp([0, 0, 0], [10, 10, 10], -1)).toEqual([0, 0, 0])
  })
})
