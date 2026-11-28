import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import type { Fragment, FragmentInput, Values } from '../../src/core/types.ts'
import { initialSession } from '../../src/core/session.ts'
import { displaySession, shortModelName } from '../../src/render/session.ts'
import { initialVcs } from '../../src/core/vcs.ts'
import { en, type Labels } from '../../src/i18n/en.ts'
import { DEFAULTS } from '../../src/options.ts'
import { calls } from '../../src/render/fragments/calls.ts'
import { context } from '../../src/render/fragments/context.ts'
import { folder } from '../../src/render/fragments/folder.ts'
import { staleLine, staleParts } from '../../src/render/freshness.ts'
import { configErrorLine } from '../../src/render/index.ts'
import { model } from '../../src/render/fragments/model.ts'
import { session } from '../../src/render/fragments/session.ts'
import { tokens } from '../../src/render/fragments/tokens.ts'
import { makeTheme } from '../../src/theme/index.ts'

// DESIGN, "Languages": every fragment rendered with labels `⟦<key>⟧` shows only
// those for its words, which catches a word written straight into a fragment.
// Numbers, units (`k`, `M`, `d`/`h`/`m` after a digit), emoji and punctuation
// are the same in every language; values from the host (the folder, the model
// and effort) are data, removed by name.

const marked = Object.fromEntries(Object.keys(en).map(k => [k, `⟦${k}⟧`])) as Labels

function input(session: Partial<Values['session']>, isWsl = false): FragmentInput {
  const v: Values = {
    core: { cwd: '/home/u/proj', home: '/home/u', columns: undefined, isWsl },
    session: { ...initialSession(), ...session },
    limits: [],
    vcs: initialVcs(),
  }
  return { v, display: displaySession(v.session, shortModelName), o: DEFAULTS, l: marked, t: makeTheme('graphite', false), now: 3 * 3_600_000 }
}

// What is left once the escapes, the marked labels, the data and the numbers
// with their units are taken out: no letter may remain.
function leftover(text: string, data: string[]): string {
  let s = text.replace(/\x1b\[[0-9;]*m/g, '').replace(/⟦\w+⟧/g, '')
  for (const d of data) s = s.split(d).join('')
  return s.replace(/(\d+[dhm])+/g, '').replace(/\d+(\.\d+)?[kM]?/g, '')
}

const counts = { tokens: 69_500, tools: 73, agents: 2, skills: 1 }
const cases: [string, Fragment, FragmentInput, string[], string[]][] = [
  ['folder', folder, input({}), ['~/proj'], []],
  ['model', model, input({ model: 'claude-opus-5-5[1m]', effort: 'high' }), ['opus', 'high'], []],
  ['context', context, input({ contextPercent: 20 }), [], ['context']],
  ['context alert', context, input({ contextPercent: 90 }), [], ['context']],
  ['tokens', tokens, input({ counts, cacheHitPercent: 23, tokensPerSecond: 48 }), [], ['tokens', 'tokensPerSecond']],
  ['session', session, input({ startedAt: 0 }), [], ['session']],
  ['calls emoji', calls, input({ counts }), [], []],
  ['calls text', calls, input({ counts }, true), [], ['tool', 'agent', 'skill']],
  ['stale emoji', f => staleLine('a', undefined, { t: f.t, l: f.l, isWsl: false }), input({}), ['a'], ['stale']],
  ['stale text', f => staleLine('a', undefined, { t: f.t, l: f.l, isWsl: true }), input({}, true), ['a'], ['staleMark', 'stale']],
  ['staleParts emoji', f => staleParts(['a'], undefined, { t: f.t, l: f.l, isWsl: false }), input({}), ['a'], ['stale']],
  ['staleParts text', f => staleParts(['a'], undefined, { t: f.t, l: f.l, isWsl: true }), input({}, true), ['a'], ['staleMark', 'stale']],
  ['configError', f => configErrorLine(new Error('bad json'), { t: f.t, l: f.l, file: 'f' }), input({}), ['f:', 'bad', 'json'], ['configError']],
]

describe('labels', () => {
  for (const [name, fragment, f, data, keys] of cases) {
    test(`${name}: only labels for its words`, () => {
      const text = fragment(f)
      assert.notEqual(text, null)
      assert.doesNotMatch(leftover(text!, data), /\p{L}/u)
      for (const key of keys) assert.ok(text!.includes(`⟦${key}⟧`))
    })
  }
})
