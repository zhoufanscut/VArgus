import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clipOmoLine, mountOmo, type OmoUi } from '../../src/outputs/omo.ts'
import { initialSession } from '../../src/core/session.ts'
import { initialLimits } from '../../src/core/limits.ts'
import { initialVcs } from '../../src/core/vcs.ts'
import type { FragmentInput } from '../../src/core/types.ts'
import { DEFAULTS } from '../../src/options.ts'
import { en } from '../../src/i18n/en.ts'
import { makeTheme } from '../../src/theme/index.ts'
import { limits } from '../../src/render/fragments/limits.ts'
import { context } from '../../src/render/fragments/context.ts'
import { model } from '../../src/render/fragments/model.ts'

function input(): FragmentInput {
  return {
    v: {
      core: { cwd: '/repo', home: undefined, columns: 200, isWsl: false, host: 'omo' },
      session: initialSession(), limits: initialLimits(), vcs: initialVcs(),
    },
    o: DEFAULTS, l: en, t: makeTheme('graphite', true), now: 0,
  }
}

test('OmO clips ANSI, wide glyphs and combining sequences without partial cells', () => {
  const red = '\x1b[38;2;255;0;0m'
  for (const [line, width, expected] of [
    [`${red}界界\x1b[0m`, 3, `${red}界\x1b[0m`],
    ['e\u0301x', 1, 'e\u0301'],
    ['界', 1, ''],
    ['abc', 0, ''],
    ['abc', 2, 'ab'],
    ['abc', 3, 'abc'],
    ['👨‍👩‍👧x', 2, ''],
  ] as const) assert.equal(clipOmoLine(line, width), expected)
})

test('OmO row hides the footer, redraws and restores only its own widget on disposal', () => {
  const widgets = new Map<string, { render(width: number): string[]; invalidate(): void }>()
  widgets.set('todo', { render: () => ['keep todo'], invalidate() {} })
  let footer: ReturnType<NonNullable<Parameters<OmoUi['setFooter']>[0]>> | undefined
  let renders = 0
  let placement: string | undefined
  const ui: OmoUi = {
    setWidget(key, factory, options) {
      if (factory) widgets.set(key, factory({ requestRender() { renders++ } }))
      else widgets.delete(key)
      placement = options?.placement
    },
    setFooter(factory) { footer = factory?.() },
  }
  let budget: number | undefined
  const output = mountOmo(ui, width => { budget = width; return '界abcd' })
  assert.equal(placement, 'belowEditor')
  assert.deepEqual(footer?.render(100), [])
  const row = widgets.get('vargus')
  assert.deepEqual(row?.render(5), ['  界a'])
  assert.equal(budget, 3)
  for (const width of [0, 1, 2, 3]) assert.deepEqual(row?.render(width), [''])
  assert.deepEqual(row?.render(4), ['  界'])
  output.refresh()
  assert.equal(renders, 1)
  output.dispose()
  output.dispose()
  output.refresh()
  assert.equal(renders, 1)
  assert.equal(footer, undefined)
  assert.deepEqual([...widgets.keys()], ['todo'])
  assert.deepEqual(row?.render(100), [])
})

test('OmO preserves unknown context and renders short model families', () => {
  const f = input()
  assert.equal(context(f), null)
  f.v.session.contextPercent = 0
  assert.equal(context(f), 'ctx:0%')
  f.v.session.effort = 'high'
  for (const [id, expected] of [
    ['gpt-6.1-sol', 'sol:high'],
    ['claude-fable-5', 'fable:high'],
    ['custom/provider-model', 'provider:high'],
  ]) {
    f.v.session.model = id
    assert.equal(model(f), expected)
  }
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
