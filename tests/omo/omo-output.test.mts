import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clipOmoLine, mountOmo, type OmoUi } from '../../src/outputs/omo.ts'
import { initialSession } from '../../src/core/session.ts'
import { initialVcs } from '../../src/core/vcs.ts'
import type { FragmentInput } from '../../src/core/types.ts'
import { DEFAULTS } from '../../src/options.ts'
import { en } from '../../src/i18n/en.ts'
import { makeTheme } from '../../src/theme/index.ts'
import { context } from '../../src/render/fragments/context.ts'
import { model } from '../../src/render/fragments/model.ts'
import { omoDisplay } from '../../src/hosts/omo/display.ts'

function input(reading: Partial<FragmentInput['v']['session']> = {}): FragmentInput {
  const session = { ...initialSession(), ...reading }
  return {
    v: {
      core: { cwd: '/repo', home: undefined, columns: 200, isWsl: false },
      session, limits: [], vcs: initialVcs(),
    },
    display: omoDisplay(session),
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

test('OmO defaults unknown context to 0% and renders short model families', () => {
  assert.equal(context(input()), 'ctx:0%')
  assert.equal(context(input({ contextPercent: 0 })), 'ctx:0%')
  for (const [id, expected] of [
    ['gpt-6.1-sol', 'sol:high'],
    ['claude-fable-5', 'fable:high'],
    ['us.amazon.nova-pro-v1:0', 'nova-pro:high'],
    ['custom/provider-model', 'custom/provider-model:high'],
  ]) {
    assert.equal(model(input({ model: id, effort: 'high' })), expected)
  }
})
