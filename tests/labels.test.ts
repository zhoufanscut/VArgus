import { describe, expect, test } from 'claude-code/testing'

import type { Fragment, FragmentInput, Values } from '../src/core/types'
import { initialLimits } from '../src/collect/limits'
import { initialSession } from '../src/collect/session'
import { initialVcs } from '../src/collect/vcs'
import { en, type Labels } from '../src/i18n/en'
import { DEFAULTS, type Options } from '../src/options'
import { calls } from '../src/render/fragments/calls'
import { context } from '../src/render/fragments/context'
import { folder } from '../src/render/fragments/folder'
import { model } from '../src/render/fragments/model'
import { session } from '../src/render/fragments/session'
import { tokens } from '../src/render/fragments/tokens'
import { makeTheme } from '../src/theme'

// DESIGN, "Languages": every fragment rendered with labels `⟦<key>⟧` shows only
// those for its words, which catches a word written straight into a fragment.
// Numbers, units (`k`, `M`, `d`/`h`/`m` after a digit), emoji and punctuation
// are the same in every language; values from the host (the folder, the model
// and effort) are data, removed by name.

const marked = Object.fromEntries(Object.keys(en).map(k => [k, `⟦${k}⟧`])) as Labels

function input(session: Partial<Values['session']>, o: Partial<Options> = {}, isWsl = false): FragmentInput {
  const v: Values = {
    core: { cwd: '/home/u/proj', home: '/home/u', columns: undefined, isWsl },
    session: { ...initialSession(), ...session },
    limits: initialLimits(),
    vcs: initialVcs(),
  }
  return { v, o: { ...DEFAULTS, ...o }, l: marked, t: makeTheme('graphite', false), now: 3 * 3_600_000 }
}

// What is left once the escapes, the marked labels, the data and the numbers
// with their units are taken out: no letter may remain.
function leftover(text: string, data: string[]): string {
  let s = text.replace(/\x1b\[[0-9;]*m/g, '').replace(/⟦\w+⟧/g, '')
  for (const d of data) s = s.split(d).join('')
  return s.replace(/(\d+[dhm])+/g, '').replace(/\d+(\.\d+)?[kM]?/g, '')
}

const counts = { tokens: 69_500, tools: 73, agents: 2, skills: 1, workflows: 3 }
const cases: [string, Fragment, FragmentInput, string[], string[]][] = [
  ['folder', folder, input({}), ['~/proj'], []],
  ['model', model, input({ model: 'claude-opus-5-5[1m]', effort: 'high' }), ['opus', 'high'], []],
  ['context', context, input({ contextPercent: 20 }), [], ['context']],
  ['context compress', context, input({ contextPercent: 82 }), [], ['context', 'compress']],
  ['context critical', context, input({ contextPercent: 90 }), [], ['context', 'critical']],
  ['tokens', tokens, input({ counts }), [], ['tokens']],
  ['session', session, input({ startedAt: 0 }), [], ['session']],
  ['calls emoji', calls, input({ counts }, { workflowRuns: true }), [], []],
  ['calls text', calls, input({ counts }, { workflowRuns: true }, true), [], ['tool', 'agent', 'workflow', 'skill']],
]

describe('labels', () => {
  for (const [name, fragment, f, data, keys] of cases) {
    test(`${name}: only labels for its words`, async () => {
      const text = fragment(f)
      expect(text).not.toBe(null)
      expect(leftover(text!, data)).not.toMatch(/\p{L}/u)
      for (const key of keys) expect(text).toContain(`⟦${key}⟧`)
    })
  }
})
