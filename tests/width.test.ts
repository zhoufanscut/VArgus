import { describe, expect, test } from 'claude-code/testing'

import { stringWidth } from '../src/render/width'

// Width (DESIGN, "Rules carried over from VantageHUD"): columns, not length.

describe('stringWidth', () => {
  test('ASCII 1 each; colour codes and other escapes 0', async () => {
    expect(stringWidth('ctx:20%')).toBe(7)
    expect(stringWidth('\x1b[38;2;1;2;3mab\x1b[0m\x1b[1mc\x1b[22m')).toBe(3)
    expect(stringWidth('\x1b]8;;http://x\x07a\x1b]8;;\x1b\\')).toBe(1)
  })

  test('East Asian wide characters 2 each', async () => {
    expect(stringWidth('中文')).toBe(4)
    expect(stringWidth('한글 かな')).toBe(9)
    expect(stringWidth('ＡＢ')).toBe(4)
  })

  test('emoji 2, narrow symbols 1, a flag 2', async () => {
    expect(stringWidth('🔧73 🤖2 ⚡1 🔀1')).toBe(16)
    expect(stringWidth('✅⭐')).toBe(4)
    expect(stringWidth('⏱✓→')).toBe(3)
    expect(stringWidth('🇯🇵')).toBe(2)
    // U+1F300-1F3FA, the block before the skin-tone modifiers: 🌀 🍕 🏺
    expect(stringWidth('🌀🍕🏺')).toBe(6)
  })

  test('combining marks, zero-width characters, VS16 and skin tones 0', async () => {
    expect(stringWidth('é')).toBe(1)
    expect(stringWidth('a​b﻿')).toBe(2)
    expect(stringWidth('⚡️')).toBe(2)
    expect(stringWidth('👍🏽')).toBe(2)
  })
})
