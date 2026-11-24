import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import type { FragmentInput, Values } from '../../src/core/types.ts'
import { addCounts, initialSession, outputTokensPerSecond } from '../../src/core/session.ts'
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
import { formatTokenCount, formatTokenRate, tokens } from '../../src/render/fragments/tokens.ts'
import { makeTheme } from '../../src/theme/index.ts'

// The session area's fragments (DESIGN, "Fragments"), each rule as VantageHUD
// 0.6.0 had it (src/hud/elements/*.js, src/lib/formatting.js).

const t = makeTheme('aurora', false)
const plain = makeTheme('aurora', true)
const { calm, alert } = t.rgb

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
  return { v, display: displaySession(v.session, shortModelName), o: { ...DEFAULTS, ...o }, l: en, t: more.color ? t : plain, now: more.now ?? 0 }
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
    assert.deepEqual(effortColor(t, 'off', 'none'), calm)
    assert.deepEqual(effortColor(t, 'minimal', 'none'), calm)
    assert.deepEqual(effortColor(t, 'minimal', 'low'), alert)
  })

  test('opus:high, label then effort colour; effort off or absent: the name alone in label', () => {
    const m = 'claude-opus-5-5[1m]'
    assert.equal(model(input({ model: m, effort: 'high' })), 'opus:high')
    assert.equal(model(input({ model: m, effort: 'high', defaultEffort: 'medium' }, {}, { color: true })), t.paint('label', 'opus:') + t.paint(calm, 'high'))
    assert.equal(model(input({ model: m, effort: 'high' }, { effort: false }, { color: true })), t.paint('label', 'opus'))
    assert.equal(model(input({ model: m }, {}, { color: true })), t.paint('label', 'opus'))
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
  test('percentage only: calm below 80%, alert from 80%', () => {
    const at = (p: number) => context(input({ contextPercent: p }, {}, { color: true }))
    const want = (rgb: typeof calm, text: string) => t.paint('label', 'ctx:') + t.paint(rgb, text)
    assert.equal(at(69), want(calm, '69%'))
    assert.equal(at(79.4), want(calm, '79%'))
    assert.equal(at(79.5), want(alert, '80%'))
    assert.equal(at(80), want(alert, '80%'))
    assert.equal(at(85), want(alert, '85%'))
    assert.equal(at(100), want(alert, '100%'))
  })

  test('rounded and clamped; unknown context defaults to 0%', () => {
    assert.equal(context(input({ contextPercent: 19.6 })), 'ctx:20%')
    assert.equal(context(input({ contextPercent: 140 })), 'ctx:100%')
    assert.equal(context(input({})), 'ctx:0%')
  })
})

describe('tokens', () => {
  test('raw under 1k, k to one decimal, M from 999,950', () => {
    assert.deepEqual(
      [0, 999, 1000, 69_500, 999_949, 999_950, 3_994_999, 3_995_000, 12_345_678].map(formatTokenCount),
      ['0', '999', '1.0k', '69.5k', '999.9k', '1.00M', '3.99M', '4.00M', '12.35M'],
    )
  })

  test('token count alerts at 1.00M (999,950) by default and 4.00M (3,995,000) with includeSubagents; hidden at zero', () => {
    assert.equal(tokens(input({ counts: counts({ tokens: 69_500 }) }, {}, { color: true })), t.paint('label', 'token:') + t.paint(calm, '69.5k'))
    assert.equal(tokens(input({ counts: counts({ tokens: 999_949 }) }, {}, { color: true })), t.paint('label', 'token:') + t.paint(calm, '999.9k'))
    assert.equal(tokens(input({ counts: counts({ tokens: 999_950 }) }, {}, { color: true })), t.paint('label', 'token:') + t.paint(alert, '1.00M'))
    assert.equal(tokens(input({ counts: counts({ tokens: 1_500_000 }) }, {}, { color: true })), t.paint('label', 'token:') + t.paint(alert, '1.50M'))
    assert.equal(tokens(input({ counts: counts({ tokens: 3_994_999 }) }, {}, { color: true })), t.paint('label', 'token:') + t.paint(alert, '3.99M'))
    assert.equal(tokens(input({})), null)

    // Subagents mode keeps the k/M format switch at 999,950 while expanding the alert flip to 4.00M (3,995,000).
    assert.equal(tokens(input({ counts: counts({ tokens: 999_949 }) }, { includeSubagents: true }, { color: true })), t.paint('label', 'token:') + t.paint(calm, '999.9k'))
    assert.equal(tokens(input({ counts: counts({ tokens: 999_950 }) }, { includeSubagents: true }, { color: true })), t.paint('label', 'token:') + t.paint(calm, '1.00M'))
    assert.equal(tokens(input({ counts: counts({ tokens: 1_500_000 }) }, { includeSubagents: true }, { color: true })), t.paint('label', 'token:') + t.paint(calm, '1.50M'))
    assert.equal(tokens(input({ counts: counts({ tokens: 3_994_999 }) }, { includeSubagents: true }, { color: true })), t.paint('label', 'token:') + t.paint(calm, '3.99M'))
    assert.equal(tokens(input({ counts: counts({ tokens: 3_995_000 }) }, { includeSubagents: true }, { color: true })), t.paint('label', 'token:') + t.paint(alert, '4.00M'))
    assert.equal(tokens(input({ counts: counts({ tokens: 4_500_000 }) }, { includeSubagents: true }, { color: true })), t.paint('label', 'token:') + t.paint(alert, '4.50M'))
    assert.equal(
      tokens(input({ counts: counts({ tokens: 3_994_999 }), cacheHitPercent: 95, tokensPerSecond: 48 }, { includeSubagents: true }, { color: true })),
      t.paint('label', 'token:') + t.paint(calm, '3.99M') + t.paint('faint', '(95%, 48t/s)'),
    )
    assert.equal(
      tokens(input({ counts: counts({ tokens: 3_995_000 }), cacheHitPercent: 95, tokensPerSecond: 48 }, { includeSubagents: true }, { color: true })),
      t.paint('label', 'token:') + t.paint(alert, '4.00M') + t.paint('faint', '(95%, 48t/s)'),
    )
    assert.equal(tokens(input({}, { includeSubagents: true }, { color: true })), null)
  })

  test('cache suffix shows up to one decimal and reserves 100% for a full hit', () => {
    const total = counts({ tokens: 103_200 })
    for (const [percent, shown] of [
      [0, '0'], [7, '7'], [7.2, '7.2'], [22.75, '22.8'],
      [99.5, '99.5'], [99.99, '99.9'], [100, '100'],
    ] as const) {
      assert.equal(tokens(input({ counts: total, cacheHitPercent: percent })), `token:103.2k(${shown}%)`)
    }
    assert.equal(tokens(input({ counts: total })), 'token:103.2k')
  })

  test('decode rate enforces a 500ms floor, formats decimals under 10 and joins with cache hit', () => {
    assert.equal(outputTokensPerSecond(100, 499), undefined)
    assert.equal(outputTokensPerSecond(0, 1000), undefined)
    assert.equal(outputTokensPerSecond(Number.MAX_VALUE, 500), undefined)
    assert.equal(outputTokensPerSecond(100, 500), 200)
    for (const [rate, shown] of [
      [NaN, null], [-1, null], [0, null], [0.04, null], [0.05, '0.1'],
      [4, '4'], [4.25, '4.3'], [9.94, '9.9'], [9.95, '10'], [48.4, '48'], [124.6, '125'],
    ] as const) {
      assert.equal(formatTokenRate(rate), shown)
    }
    const total = counts({ tokens: 69_500 })
    assert.equal(tokens(input({ counts: total, tokensPerSecond: 48.4 })), 'token:69.5k(48t/s)')
    assert.equal(tokens(input({ counts: total, cacheHitPercent: 99.4, tokensPerSecond: 48.4 })), 'token:69.5k(99.4%, 48t/s)')
    assert.equal(
      tokens(input({ counts: total, cacheHitPercent: 99.4, tokensPerSecond: 48.4 }, {}, { color: true })),
      t.paint('label', 'token:') + t.paint(calm, '69.5k') + t.paint('faint', '(99.4%, 48t/s)'),
    )
    assert.equal(tokens(input({ counts: total, cacheHitPercent: 99.4, tokensPerSecond: 0.04 })), 'token:69.5k(99.4%)')
  })
})

describe('session time', () => {
  test('45m, 3h12m, 2d5h; minutes floored', () => {
    assert.deepEqual([0, 45.9, 59, 60, 192, 1439, 1440, 3180].map(formatDuration), ['0m', '45m', '59m', '1h0m', '3h12m', '23h59m', '1d0h', '2d5h'])
  })

  test('since startedAt; calm under 12 h, alert from 12 h; hidden until known', () => {
    const at = (min: number) => session(input({ startedAt: 1000 }, {}, { now: 1000 + min * 60_000 + 59_999, color: true }))
    assert.equal(at(24), t.paint('label', 'session:') + t.paint(calm, '24m'))
    assert.equal(at(719), t.paint('label', 'session:') + t.paint(calm, '11h59m'))
    assert.equal(at(720), t.paint('label', 'session:') + t.paint(alert, '12h0m'))
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

  test('text on WSL: T:73 A:2 S:1 painted in label', () => {
    assert.equal(calls(input({ counts: c }, {}, { isWsl: true })), 'T:73 A:2 S:1')
    assert.equal(
      calls(input({ counts: c }, {}, { isWsl: true, color: true })),
      `${t.paint('label', 'T:73')} ${t.paint('label', 'A:2')} ${t.paint('label', 'S:1')}`,
    )
  })

  test('addCounts sums full or partial counts without mutating inputs', () => {
    const base = { tokens: 100, tools: 3, agents: 1, skills: 2 }
    const extra = { tokens: 50, tools: 4, agents: 2, skills: 1 }
    assert.deepEqual(addCounts(base, extra), { tokens: 150, tools: 7, agents: 3, skills: 3 })
    assert.deepEqual(addCounts(base, { tokens: 25 }), { tokens: 125, tools: 3, agents: 1, skills: 2 })
    const copy = addCounts(base)
    assert.deepEqual(copy, base)
    assert.notEqual(copy, base)
    assert.deepEqual(base, { tokens: 100, tools: 3, agents: 1, skills: 2 })
    assert.deepEqual(extra, { tokens: 50, tools: 4, agents: 2, skills: 1 })
  })
})
