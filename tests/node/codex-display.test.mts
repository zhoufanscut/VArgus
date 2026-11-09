import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CodexCollector } from '../../src/hosts/codex/collect.ts'
import { model } from '../../src/render/fragments/model.ts'
import { calls } from '../../src/render/fragments/calls.ts'
import { DEFAULTS } from '../../src/options.ts'
import { en } from '../../src/i18n/en.ts'
import { makeTheme } from '../../src/theme/index.ts'

test('Codex short names retain full IDs internally and preserve unfamiliar model IDs', () => {
  const collector = new CodexCollector('/repo', '/home/u')
  collector.start('/repo', 0)
  const v = collector.snapshot()!
  const input = { v, o: DEFAULTS, l: en, t: makeTheme('graphite', true), now: 0 }
  v.session.effort = 'xhigh'
  for (const [id, short] of [
    ['gpt-6-astra', 'astra'], ['gpt-6.1-sol', 'sol'], ['gpt-6-sol', 'sol'],
    ['gpt-6.1-terra', 'terra'], ['gpt-6-luna', 'luna'],
    ['gpt-4o', 'gpt-4o'], ['vendor/gpt-6.1-sol', 'vendor/gpt-6.1-sol'], ['custom-sol', 'custom-sol'],
  ]) {
    v.session.model = id
    assert.equal(model(input), short + ':xhigh')
    assert.equal(v.session.model, id)
    assert.equal(model({ ...input, o: { ...DEFAULTS, codexShortModel: false } }), id + ':xhigh')
  }
  v.session.model = 'gpt-6.1-sol'
  assert.equal(model({ ...input, o: { ...DEFAULTS, effort: false } }), 'sol')
  Object.assign(v.session.counts, { tools: 7, agents: 2, skills: 3 })
  assert.equal(calls(input), '🔧7 🤖2 ⚡3')
  assert.equal(calls({ ...input, o: { ...DEFAULTS, codexAgentCounts: false } }), '🔧7 ⚡3')
  assert.equal(calls({ ...input, o: { ...DEFAULTS, codexSkillCounts: false } }), '🔧7 🤖2')
  v.core.host = 'claude'; v.session.model = 'claude-opus-5-5'
  const disabled = { ...input, o: { ...DEFAULTS, codexShortModel: false, codexAgentCounts: false, codexSkillCounts: false } }
  assert.equal(model(disabled), 'opus:xhigh')
  assert.equal(calls(disabled), '🔧7 🤖2 ⚡3')
})
