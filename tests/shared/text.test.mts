import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { cleanText, shortenHome } from '../../src/render/text.ts'

describe('text', () => {
  test('control characters, ESC included, become ?', () => {
    assert.equal(cleanText('a\x1b[31mb\nc\x7fd\x9be'), 'a?[31mb?c?d?e')
    assert.equal(cleanText('ok ✓ 中'), 'ok ✓ 中')
  })

  test('home prefix becomes ~, only on a whole path segment', () => {
    assert.equal(shortenHome('/home/u/proj', '/home/u'), '~/proj')
    assert.equal(shortenHome('/home/u', '/home/u/'), '~')
    assert.equal(shortenHome('/home/user2/x', '/home/u'), '/home/user2/x')
    assert.equal(shortenHome('/x', '/'), '/x')
    assert.equal(shortenHome('/x', undefined), '/x')
  })

  test('Windows: a \\ home prefix becomes ~, the rest keeps its separators', () => {
    assert.equal(shortenHome('C:\\Users\\u\\proj', 'C:\\Users\\u'), '~\\proj')
    assert.equal(shortenHome('C:/Users/u/proj', 'C:/Users/u'), '~/proj')
    assert.equal(shortenHome('C:\\Users\\u', 'C:\\Users\\u\\'), '~')
    assert.equal(shortenHome('C:\\Users\\u2\\x', 'C:\\Users\\u'), 'C:\\Users\\u2\\x')
    // outside a drive path a \ is part of a name, as before
    assert.equal(shortenHome('/home/u\\x', '/home/u'), '/home/u\\x')
    assert.equal(shortenHome('/home/u\\', '/home/u\\'), '~')
    assert.equal(shortenHome('/home/u/x', '/home/u\\'), '/home/u/x')
  })
})
