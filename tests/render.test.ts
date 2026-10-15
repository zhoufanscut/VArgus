import { describe, expect, test } from 'claude-code/testing'

import type { Fragment, FragmentInput, Values } from '../src/core/types'
import { resolveLabels } from '../src/i18n'
import { en } from '../src/i18n/en'
import { DEFAULTS, resolveOptions, type Options } from '../src/options'
import { ORDER, render } from '../src/render'
import { initialLimits } from '../src/collect/limits'
import { initialSession } from '../src/collect/session'
import { initialVcs } from '../src/collect/vcs'
import { makeTheme } from '../src/theme'

// The composer (DESIGN, "When the line is written", "Fragments", "Config").

function input(columns?: number, o: Partial<Options> = {}): FragmentInput {
  const v: Values = {
    core: { cwd: '/home/u/proj/x', home: '/home/u', columns, isWsl: false },
    session: initialSession(),
    limits: initialLimits(),
    vcs: initialVcs(),
  }
  return { v, o: { ...DEFAULTS, ...o }, l: en, t: makeTheme('graphite', true), now: 0 }
}

const text = (s: string): Fragment => () => s

describe('render', () => {
  test('VantageHUD order, each behind its option', async () => {
    expect(ORDER.map(([option]) => option)).toEqual([
      'folder', 'model', 'rateLimits', 'context', 'tokens', 'session', 'callCounts', 'repo', 'branch', 'status',
    ])
    expect(render(input(), [['folder', text('a')], ['model', text('b')]])).toBe('a | b')
    expect(render(input(undefined, { model: false }), [['folder', text('a')], ['model', text('b')]])).toBe('a')
  })

  test('a fragment that throws or returns null is left out, not the line', async () => {
    const boom: Fragment = () => {
      throw new Error('x')
    }
    expect(render(input(), [['folder', text('a')], ['model', boom], ['context', () => null], ['tokens', text('d')]]))
      .toBe('a | d')
  })

  test('too narrow: whole fragments dropped from the end; no width: nothing dropped', async () => {
    const order = [['folder', text('aaaa')], ['model', text('bbbb')], ['context', text('cccc')]] as const
    expect(render(input(undefined), order)).toBe('aaaa | bbbb | cccc')
    expect(render(input(18), order)).toBe('aaaa | bbbb | cccc')
    expect(render(input(17), order)).toBe('aaaa | bbbb')
    expect(render(input(2), order)).toBe('aaaa')
  })

  test('the stub-free fragments run: folder', async () => {
    expect(render(input(), [['folder', ORDER[0]![1]]])).toBe('~/proj/x')
  })
})

describe('options and labels', () => {
  test('defaults as VantageHUD, theme graphite; wrong types keep the default', async () => {
    expect(resolveOptions({})).toEqual(DEFAULTS)
    expect(resolveOptions({ spendLimit: true, theme: 'ember', folder: 'no' })).toEqual({
      ...DEFAULTS, spendLimit: true, theme: 'ember',
    })
    expect(DEFAULTS.spendLimit || DEFAULTS.otherModelWeekly || DEFAULTS.workflowRuns || DEFAULTS.detachedHead)
      .toBe(false)
  })

  test('an unknown language tag, constructor included, falls back to English', async () => {
    expect(resolveLabels('en')).toBe(en)
    expect(resolveLabels('constructor')).toBe(en)
    expect(resolveLabels('xx')).toBe(en)
  })
})
