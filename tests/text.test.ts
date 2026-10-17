import { describe, expect, test } from 'claude-code/testing'

import { cleanText, shortenHome } from '../src/render/text'

describe('text', () => {
  test('control characters, ESC included, become ?', async () => {
    expect(cleanText('a\x1b[31mb\nc\x7fd\x9be')).toBe('a?[31mb?c?d?e')
    expect(cleanText('ok ✓ 中')).toBe('ok ✓ 中')
  })

  test('home prefix becomes ~, only on a whole path segment', async () => {
    expect(shortenHome('/home/u/proj', '/home/u')).toBe('~/proj')
    expect(shortenHome('/home/u', '/home/u/')).toBe('~')
    expect(shortenHome('/home/user2/x', '/home/u')).toBe('/home/user2/x')
    expect(shortenHome('/x', '/')).toBe('/x')
    expect(shortenHome('/x', undefined)).toBe('/x')
  })

  test('Windows: a \\ home prefix becomes ~, the rest keeps its separators', async () => {
    expect(shortenHome('C:\\Users\\u\\proj', 'C:\\Users\\u')).toBe('~\\proj')
    expect(shortenHome('C:/Users/u/proj', 'C:/Users/u')).toBe('~/proj')
    expect(shortenHome('C:\\Users\\u', 'C:\\Users\\u\\')).toBe('~')
    expect(shortenHome('C:\\Users\\u2\\x', 'C:\\Users\\u')).toBe('C:\\Users\\u2\\x')
    // outside a drive path a \ is part of a name, as before
    expect(shortenHome('/home/u\\x', '/home/u')).toBe('/home/u\\x')
    expect(shortenHome('/home/u\\', '/home/u\\')).toBe('~')
    expect(shortenHome('/home/u/x', '/home/u\\')).toBe('/home/u/x')
  })
})
