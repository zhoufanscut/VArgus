import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import type { FragmentInput, Values } from '../../src/core/types.ts'
import { initialSession } from '../../src/core/session.ts'
import { displaySession, shortModelName } from '../../src/render/session.ts'
import { initialVcs } from '../../src/core/vcs.ts'
import { en } from '../../src/i18n/en.ts'
import { DEFAULTS, type Options } from '../../src/options.ts'
import { calls } from '../../src/render/fragments/calls.ts'
import { context } from '../../src/render/fragments/context.ts'
import { folder } from '../../src/render/fragments/folder.ts'
import { effortColor, model } from '../../src/render/fragments/model.ts'
import { session } from '../../src/render/fragments/session.ts'
import { formatDuration } from '../../src/render/format.ts'
import { formatTokenCount, tokens } from '../../src/render/fragments/tokens.ts'
import { makeTheme } from '../../src/theme/index.ts'

// The session area's fragments (DESIGN, "Fragments"), each rule as VantageHUD
// 0.6.0 had it (src/hud/elements/*.js, src/lib/formatting.js).

const t = makeTheme('aurora', false)
const plain = makeTheme('aurora', true)
const { gradLow, gradMid, gradHigh } = t.rgb

function input(
  session: Partial<Values['session']> = {},
  o: Partial<Options> = {},
  more: { now?: number; isWsl?: boolean; color?: boolean } = {},
): FragmentInput {
  const v: Values = {
    core: { cwd: '/x', home: undefined, columns: undefined, isWsl: more.isWsl ?? false },
    session: { ...initialSession(), ...session },
    limits: [],
    vcs: initialVcs(),
  }
  return { v, display: displaySession(v.session, shortModelName, 0), o: { ...DEFAULTS, ...o }, l: en, t: more.color ? t : plain, now: more.now ?? 0 }
}

const counts = (c: Partial<Values['session']['counts']>) => ({ ...initialSession().counts, ...c })

describe('model', () => {
  test('short name: the family after claude, legacy ids, an ARN\'s service, a gateway\'s first word', () => {
    assert.equal(shortModelName('claude-opus-5-5[1m]'), 'opus')
    assert.equal(shortModelName('Claude Opus 5.5'), 'opus')
    assert.equal(shortModelName('claude-fable-5'), 'fable')
    assert.equal(shortModelName('claude-3-5-sonnet-20241022'), 'sonnet')
    assert.equal(shortModelName('arn:aws:bedrock:us-east-1:1:application-inference-profile/x'), 'bedrock')
    assert.equal(shortModelName('gpt-4o'), 'gpt')
    assert.equal(shortModelName('deepseek-chat'), 'deepseek')
    assert.equal(shortModelName('  '), null)
  })

  test('off and none are the same level, with minimal below low', () => {
    assert.deepEqual(effortColor(t, 'off', 'none'), gradLow)
    assert.deepEqual(effortColor(t, 'minimal', 'none'), gradLow)
    assert.deepEqual(effortColor(t, 'minimal', 'low'), gradHigh)
  })

  test('opus:high, label then effort colour; effort off or absent: the name alone, calm', () => {
    const m = 'claude-opus-5-5[1m]'
    assert.equal(model(input({ model: m, effort: 'high' })), 'opus:high')
    assert.equal(model(input({ model: m, effort: 'high', defaultEffort: 'medium' }, {}, { color: true })), t.paint('label', 'opus:') + t.paint(gradLow, 'high'))
    assert.equal(model(input({ model: m, effort: 'high' }, { effort: false }, { color: true })), t.paint(gradLow, 'opus'))
    assert.equal(model(input({ model: m })), 'opus')
    assert.equal(model(input({})), null)
  })
})

// Only the theme adds escapes (DESIGN, "Colours"): a control character in
// outside text reaches the line as `?`. Non-SGR escapes in the inputs, so a
// leak can't pass for a theme code.
describe('outside text is cleaned', () => {
  const sgr = /\x1b\[[0-9;]*m/g
  const leaks = (s: string | null) => (s ?? '').replace(sgr, '').includes('\x1b')

  test('folder: /home/u/a<ESC>b is ~/a?b; coloured, no escape but the theme\'s', () => {
    for (const color of [false, true]) {
      const f = input({}, {}, { color })
      f.v.core.cwd = '/home/u/a\x1bb'
      f.v.core.home = '/home/u'
      const out = folder(f)
      assert.equal(out!.replace(sgr, ''), '~/a?b')
      assert.equal(leaks(out), false)
      if (!color) assert.equal(out!.includes('\x1b'), false)
    }
  })

  test('model and effort: a control character becomes ?; with NO_COLOR no escape at all', () => {
    const id = 'gpt\x1b[2J-4o'
    const effort = 'hi\x1b]0;x\x07gh'
    assert.equal(model(input({ model: id, effort })), 'gpt?[2j:hi?]0;x?gh')
    assert.equal(model(input({ model: id, effort }))!.includes('\x1b'), false)
    assert.equal(leaks(model(input({ model: id, effort }, {}, { color: true }))), false)
    assert.equal(leaks(model(input({ model: id }, {}, { color: true }))), false)
  })
})

describe('context', () => {
  test('70 / 80 / 85: colour at 70 and 85, COMPRESS? from 80, CRITICAL from 85', () => {
    const at = (p: number) => context(input({ contextPercent: p }, {}, { color: true }))
    const want = (rgb: typeof gradLow, text: string) => t.paint('label', 'ctx:') + t.paint(rgb, text)
    assert.equal(at(69), want(gradLow, '69%'))
    assert.equal(at(70), want(gradMid, '70%'))
    assert.equal(at(79), want(gradMid, '79%'))
    assert.equal(at(80), want(gradMid, '80% COMPRESS?'))
    assert.equal(at(84), want(gradMid, '84% COMPRESS?'))
    assert.equal(at(85), want(gradHigh, '85% CRITICAL'))
  })

  test('rounded and clamped; a supplied zero fallback shows 0%', () => {
    assert.equal(context(input({ contextPercent: 19.6 })), 'ctx:20%')
    assert.equal(context(input({ contextPercent: 140 })), 'ctx:100% CRITICAL')
    assert.equal(context(input({})), 'ctx:0%')
  })
})

describe('tokens', () => {
  test('raw under 1k, k to one decimal, M from 999,950', () => {
    assert.deepEqual([0, 999, 1000, 69_500, 999_949, 999_950, 12_345_678].map(formatTokenCount), ['0', '999', '1.0k', '69.5k', '999.9k', '1.00M', '12.35M'])
  })

  test('token:69.5k, label then gradLow; hidden at zero', () => {
    assert.equal(tokens(input({ counts: counts({ tokens: 69_500 }) }, {}, { color: true })), t.paint('label', 'token:') + t.paint(gradLow, '69.5k'))
    assert.equal(tokens(input({})), null)
  })

  test('cache suffix rounds to a whole percent and preserves a reported zero', () => {
    const total = counts({ tokens: 103_200 })
    for (const [percent, shown] of [[0, '0'], [7.2, '7'], [22.75, '23'], [100, '100']] as const) {
      assert.equal(tokens(input({ counts: total, cacheHitPercent: percent })), `token:103.2k(cache:${shown}%)`)
    }
    assert.equal(tokens(input({ counts: total })), 'token:103.2k')
  })
})

describe('session time', () => {
  test('45m, 3h12m, 2d5h; minutes floored', () => {
    assert.deepEqual([0, 45.9, 59, 60, 192, 1439, 1440, 3180].map(formatDuration), ['0m', '45m', '59m', '1h0m', '3h12m', '23h59m', '1d0h', '2d5h'])
  })

  test('since startedAt; tier colour over 8 h (calm < 5.6 h, alert from 6.8 h); hidden until known', () => {
    const at = (min: number) => session(input({ startedAt: 1000 }, {}, { now: 1000 + min * 60_000 + 59_999, color: true }))
    assert.equal(at(24), t.paint('label', 'session:') + t.paint(gradLow, '24m'))
    assert.equal(at(335), t.paint('label', 'session:') + t.paint(gradLow, '5h35m'))
    assert.equal(at(336), t.paint('label', 'session:') + t.paint(gradMid, '5h36m'))
    assert.equal(at(408), t.paint('label', 'session:') + t.paint(gradHigh, '6h48m'))
    assert.equal(session(input({ startedAt: 5000 }, {}, { now: 0 })), 'session:0m')
    assert.equal(session(input({})), null)
  })
})

describe('call counts', () => {
  const c = counts({ tools: 73, agents: 2, skills: 1 })

  test('emoji, zeros left out, all zero hidden; numbers in the label tone', () => {
    assert.equal(calls(input({ counts: c })), '🔧73 🤖2 ⚡1')
    assert.equal(calls(input({ counts: counts({ tools: 5, skills: 2 }) })), '🔧5 ⚡2')
    assert.equal(calls(input({})), null)
    assert.equal(calls(input({ counts: counts({ tools: 1 }) }, {}, { color: true })), '🔧' + t.paint('label', '1'))
  })

  test('text on WSL: T:73 A:2 S:1', () => {
    assert.equal(calls(input({ counts: c }, {}, { isWsl: true })), 'T:73 A:2 S:1')
  })
})
