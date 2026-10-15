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
})
