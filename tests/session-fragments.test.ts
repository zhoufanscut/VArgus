import { describe, expect, test } from 'claude-code/testing'

import type { FragmentInput, Values } from '../src/core/types'
import { initialLimits } from '../src/collect/limits'
import { initialSession } from '../src/collect/session'
import { initialVcs } from '../src/collect/vcs'
import { en } from '../src/i18n/en'
import { DEFAULTS, type Options } from '../src/options'
import { calls } from '../src/render/fragments/calls'
import { context } from '../src/render/fragments/context'
import { folder } from '../src/render/fragments/folder'
import { effortColor, model, shortModelName } from '../src/render/fragments/model'
import { session } from '../src/render/fragments/session'
import { formatDuration } from '../src/render/format'
import { formatTokenCount, tokens } from '../src/render/fragments/tokens'
import { makeTheme } from '../src/theme'

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
    limits: initialLimits(),
    vcs: initialVcs(),
  }
  return { v, o: { ...DEFAULTS, ...o }, l: en, t: more.color ? t : plain, now: more.now ?? 0 }
}

const counts = (c: Partial<Values['session']['counts']>) => ({ ...initialSession().counts, ...c })

describe('model', () => {
  test('short name: the family after claude, legacy ids, an ARN\'s service, a gateway\'s first word', async () => {
    expect(shortModelName('claude-opus-5-5[1m]')).toBe('opus')
    expect(shortModelName('Claude Opus 5.5')).toBe('opus')
    expect(shortModelName('claude-fable-5')).toBe('fable')
    expect(shortModelName('claude-3-5-sonnet-20241022')).toBe('sonnet')
    expect(shortModelName('arn:aws:bedrock:us-east-1:1:application-inference-profile/x')).toBe('bedrock')
    expect(shortModelName('gpt-4o')).toBe('gpt')
    expect(shortModelName('deepseek-chat')).toBe('deepseek')
    expect(shortModelName('  ')).toBe(null)
  })

  test('effort colours inverted: max calm ... low alert; unknown or a number calm', async () => {
    expect(effortColor(t, 'max')).toEqual(gradLow)
    expect(effortColor(t, 'xhigh')).toEqual(t.lerp(gradLow, gradMid, 0.5))
    expect(effortColor(t, 'HIGH')).toEqual(gradMid)
    expect(effortColor(t, 'medium')).toEqual(t.lerp(gradMid, gradHigh, 0.5))
    expect(effortColor(t, 'low')).toEqual(gradHigh)
    expect(effortColor(t, 'odd')).toEqual(gradLow)
    expect(effortColor(t, 4096)).toEqual(gradLow)
    expect(effortColor(t, undefined)).toEqual(gradLow)
  })

  test('opus:high, label then effort colour; effort off or absent: the name alone, calm', async () => {
    const m = 'claude-opus-5-5[1m]'
    expect(model(input({ model: m, effort: 'high' }))).toBe('opus:high')
    expect(model(input({ model: m, effort: 'high' }, {}, { color: true })))
      .toBe(t.paint('label', 'opus:') + t.paint(gradMid, 'high'))
    expect(model(input({ model: m, effort: 'high' }, { effort: false }, { color: true }))).toBe(t.paint(gradLow, 'opus'))
    expect(model(input({ model: m }))).toBe('opus')
    expect(model(input({}))).toBe(null)
  })
})

// Only the theme adds escapes (DESIGN, "Colours"): a control character in
// outside text reaches the line as `?`. Non-SGR escapes in the inputs, so a
// leak can't pass for a theme code.
describe('outside text is cleaned', () => {
  const sgr = /\x1b\[[0-9;]*m/g
  const leaks = (s: string | null) => (s ?? '').replace(sgr, '').includes('\x1b')

  test('folder: /home/u/a<ESC>b is ~/a?b; coloured, no escape but the theme\'s', async () => {
    for (const color of [false, true]) {
      const f = input({}, {}, { color })
      f.v.core.cwd = '/home/u/a\x1bb'
      f.v.core.home = '/home/u'
      const out = folder(f)
      expect(out!.replace(sgr, '')).toBe('~/a?b')
      expect(leaks(out)).toBe(false)
      if (!color) expect(out!.includes('\x1b')).toBe(false)
    }
  })

  test('model and effort: a control character becomes ?; with NO_COLOR no escape at all', async () => {
    const id = 'gpt\x1b[2J-4o'
    const effort = 'hi\x1b]0;x\x07gh'
    expect(model(input({ model: id, effort }))).toBe('gpt?[2j:hi?]0;x?gh')
    expect(model(input({ model: id, effort }))!.includes('\x1b')).toBe(false)
    expect(leaks(model(input({ model: id, effort }, {}, { color: true })))).toBe(false)
    expect(leaks(model(input({ model: id }, {}, { color: true })))).toBe(false)
  })
})

describe('context', () => {
  test('70 / 80 / 85: colour at 70 and 85, COMPRESS? from 80, CRITICAL from 85', async () => {
    const at = (p: number) => context(input({ contextPercent: p }, {}, { color: true }))
    const want = (rgb: typeof gradLow, text: string) => t.paint('label', 'ctx:') + t.paint(rgb, text)
    expect(at(69)).toBe(want(gradLow, '69%'))
    expect(at(70)).toBe(want(gradMid, '70%'))
    expect(at(79)).toBe(want(gradMid, '79%'))
    expect(at(80)).toBe(want(gradMid, '80% COMPRESS?'))
    expect(at(84)).toBe(want(gradMid, '84% COMPRESS?'))
    expect(at(85)).toBe(want(gradHigh, '85% CRITICAL'))
  })

  test('rounded and clamped; unknown shows 0%', async () => {
    expect(context(input({ contextPercent: 19.6 }))).toBe('ctx:20%')
    expect(context(input({ contextPercent: 140 }))).toBe('ctx:100% CRITICAL')
    expect(context(input({}))).toBe('ctx:0%')
  })
})

describe('tokens', () => {
  test('raw under 1k, k to one decimal, M from 999,950', async () => {
    expect([0, 999, 1000, 69_500, 999_949, 999_950, 12_345_678].map(formatTokenCount))
      .toEqual(['0', '999', '1.0k', '69.5k', '999.9k', '1.00M', '12.35M'])
  })

  test('token:69.5k, label then gradLow; hidden at zero', async () => {
    expect(tokens(input({ counts: counts({ tokens: 69_500 }) }, {}, { color: true })))
      .toBe(t.paint('label', 'token:') + t.paint(gradLow, '69.5k'))
    expect(tokens(input({}))).toBe(null)
  })
})

describe('session time', () => {
  test('45m, 3h12m, 2d5h; minutes floored', async () => {
    expect([0, 45.9, 59, 60, 192, 1439, 1440, 3180].map(formatDuration))
      .toEqual(['0m', '45m', '59m', '1h0m', '3h12m', '23h59m', '1d0h', '2d5h'])
  })

  test('since startedAt; tier colour over 8 h (calm < 5.6 h, alert from 6.8 h); hidden until known', async () => {
    const at = (min: number) => session(input({ startedAt: 1000 }, {}, { now: 1000 + min * 60_000 + 59_999, color: true }))
    expect(at(24)).toBe(t.paint('label', 'session:') + t.paint(gradLow, '24m'))
    expect(at(335)).toBe(t.paint('label', 'session:') + t.paint(gradLow, '5h35m'))
    expect(at(336)).toBe(t.paint('label', 'session:') + t.paint(gradMid, '5h36m'))
    expect(at(408)).toBe(t.paint('label', 'session:') + t.paint(gradHigh, '6h48m'))
    expect(session(input({ startedAt: 5000 }, {}, { now: 0 }))).toBe('session:0m')
    expect(session(input({}))).toBe(null)
  })
})

describe('call counts', () => {
  const c = counts({ tools: 73, agents: 2, skills: 1, workflows: 3 })

  test('emoji, zeros left out, all zero hidden; numbers in the label tone', async () => {
    expect(calls(input({ counts: c }))).toBe('🔧73 🤖2 ⚡1')
    expect(calls(input({ counts: counts({ tools: 5, skills: 2 }) }))).toBe('🔧5 ⚡2')
    expect(calls(input({}))).toBe(null)
    expect(calls(input({ counts: counts({ tools: 1 }) }, {}, { color: true }))).toBe('🔧' + t.paint('label', '1'))
  })

  test('workflow runs after the agents, only with the option on', async () => {
    expect(calls(input({ counts: c }, { workflowRuns: true }))).toBe('🔧73 🤖2 🔀3 ⚡1')
    expect(calls(input({ counts: counts({ workflows: 3 }) }))).toBe(null)
  })

  test('text on WSL: T:73 A:2 W:3 S:1', async () => {
    expect(calls(input({ counts: c }, { workflowRuns: true }, { isWsl: true }))).toBe('T:73 A:2 W:3 S:1')
  })
})
