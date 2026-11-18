import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { stringWidth } from '../../src/render/width.ts'

// Width (DESIGN, "Rules carried over from VantageHUD"): columns, not length.

describe('stringWidth', () => {
  test('ASCII 1 each; colour codes and other escapes 0', () => {
    assert.equal(stringWidth('ctx:20%'), 7)
    assert.equal(stringWidth('\x1b[38;2;1;2;3mab\x1b[0m\x1b[1mc\x1b[22m'), 3)
    assert.equal(stringWidth('\x1b]8;;http://x\x07a\x1b]8;;\x1b\\'), 1)
  })

  test('East Asian wide characters 2 each', () => {
    assert.equal(stringWidth('中文'), 4)
    assert.equal(stringWidth('한글 かな'), 9)
    assert.equal(stringWidth('ＡＢ'), 4)
  })

  test('emoji 2, narrow symbols 1, a flag 2', () => {
    assert.equal(stringWidth('🔧73 🤖2 ⚡1 🔀1'), 16)
    assert.equal(stringWidth('✅⭐'), 4)
    assert.equal(stringWidth('⏱✓→'), 3)
    assert.equal(stringWidth('🇯🇵'), 2)
    // U+1F300-1F3FA, the block before the skin-tone modifiers: 🌀 🍕 🏺
    assert.equal(stringWidth('🌀🍕🏺'), 6)
  })

  test('combining marks, zero-width characters, VS16 and skin tones 0', () => {
    assert.equal(stringWidth('é'), 1)
    assert.equal(stringWidth('a​b﻿'), 2)
    assert.equal(stringWidth('⚡️'), 2)
    assert.equal(stringWidth('👍🏽'), 2)
  })
})
