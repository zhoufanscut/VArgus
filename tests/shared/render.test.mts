import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { initialLimits } from '../../src/core/limits.ts'

import type { Fragment, FragmentInput, Values } from '../../src/core/types.ts'
import { resolveLabels } from '../../src/i18n/index.ts'
import { en } from '../../src/i18n/en.ts'
import { DEFAULTS, resolveOptions, type Options } from '../../src/options.ts'
import { ORDER, render } from '../../src/render/index.ts'
import { limits } from '../../src/render/fragments/limits.ts'
import { initialSession } from '../../src/core/session.ts'
import { displaySession, shortModelName } from '../../src/render/session.ts'
import { initialVcs } from '../../src/core/vcs.ts'
import { makeTheme } from '../../src/theme/index.ts'

// The composer (DESIGN, "When the line is written", "Fragments", "Config").

function input(columns?: number, o: Partial<Options> = {}): FragmentInput {
  const v: Values = {
    core: { cwd: '/home/u/proj/x', home: '/home/u', columns, isWsl: false },
    session: initialSession(),
    limits: initialLimits(),
    vcs: initialVcs(),
  }
  return { v, display: displaySession(v.session, shortModelName), o: { ...DEFAULTS, ...o }, l: en, t: makeTheme('graphite', true), now: 0 }
}

const text = (s: string): Fragment => () => s

describe('render', () => {
  test('VantageHUD order, each behind its option', () => {
    assert.deepEqual(ORDER.map(([option]) => option), [
      'folder', 'model', 'rateLimits', 'context', 'tokens', 'session', 'callCounts', 'repo', 'branch', 'status',
    ])
    assert.equal(render(input(), [['folder', text('a')], ['model', text('b')]]), 'a | b')
    assert.equal(render(input(undefined, { model: false }), [['folder', text('a')], ['model', text('b')]]), 'a')
  })

  test('a fragment that throws or returns null is left out, not the line', () => {
    const boom: Fragment = () => {
      throw new Error('x')
    }
    assert.equal(render(input(), [['folder', text('a')], ['model', boom], ['context', () => null], ['tokens', text('d')]]), 'a | d')
  })

  test('too narrow: whole fragments dropped from the end; no width: nothing dropped', () => {
    const order = [['folder', text('aaaa')], ['model', text('bbbb')], ['context', text('cccc')]] as const
    assert.equal(render(input(undefined), order), 'aaaa | bbbb | cccc')
    assert.equal(render(input(18), order), 'aaaa | bbbb | cccc')
    assert.equal(render(input(17), order), 'aaaa | bbbb')
    assert.equal(render(input(2), order), 'aaaa')
  })

  test('the stub-free fragments run: folder', () => {
    assert.equal(render(input(), [['folder', ORDER[0]![1]]]), '~/proj/x')
  })
})

describe('options and labels', () => {
  test('defaults as VantageHUD, theme graphite; wrong types keep the default', () => {
    assert.deepEqual(resolveOptions({}), DEFAULTS)
    assert.deepEqual(resolveOptions({ spendLimit: true, theme: 'ember', folder: 'no' }), {
      ...DEFAULTS, spendLimit: true, theme: 'ember',
    })
    assert.equal(DEFAULTS.spendLimit || DEFAULTS.otherModelWeekly || DEFAULTS.workflowRuns || DEFAULTS.detachedHead, false)
  })

  test('an unknown language tag, constructor included, falls back to English', () => {
    assert.equal(resolveLabels('en'), en)
    assert.equal(resolveLabels('constructor'), en)
    assert.equal(resolveLabels('xx'), en)
  })
})

test('quota windows retain multiple labeled accounts, stale marks and unfamiliar durations', () => {
  const f = input()
  f.v.limits.engine = [
    { kind: 'five_hour', label: 'account-a/5h', percentUsed: 10 },
    { kind: 'five_hour', label: 'account-b/5h', percentUsed: 20, stale: true, resetsAt: new Date(3600000).toISOString() },
    { kind: 'other', label: 'provider/day\n', percentUsed: 30 },
    { kind: 'seven_day', label: 'expired', percentUsed: 99, resetsAt: new Date(0).toISOString() },
  ]
  assert.equal(limits(f), 'account-a/5h:10% account-b/5h:20%*(~1h0m) provider/day?:30%')
})
