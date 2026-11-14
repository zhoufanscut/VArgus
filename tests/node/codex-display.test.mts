import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CodexCollector } from '../../src/hosts/codex/collect.ts'
import { model } from '../../src/render/fragments/model.ts'
import { calls } from '../../src/render/fragments/calls.ts'
import { DEFAULTS, resolveOptions } from '../../src/options.ts'
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
  }
  v.session.model = 'gpt-6.1-sol'
  assert.deepEqual(resolveOptions({ codexShortModel: false }), DEFAULTS)
  assert.equal(model({ ...input, o: resolveOptions({ codexShortModel: false }) }), 'sol:xhigh')
  assert.equal(model({ ...input, o: { ...DEFAULTS, effort: false } }), 'sol')
  Object.assign(v.session.counts, { tools: 7, agents: 2, skills: 3 })
  assert.equal(calls(input), '🔧7 🤖2 ⚡3')
  assert.equal(calls({ ...input, o: { ...DEFAULTS, codexAgentCounts: false } }), '🔧7 ⚡3')
  assert.equal(calls({ ...input, o: { ...DEFAULTS, codexSkillCounts: false } }), '🔧7 🤖2')
  v.core.host = 'claude'; v.session.model = 'claude-opus-5-5'
  const disabled = { ...input, o: { ...DEFAULTS, codexAgentCounts: false, codexSkillCounts: false } }
  assert.equal(model(disabled), 'opus:xhigh')
  assert.equal(calls(disabled), '🔧7 🤖2 ⚡3')
})

test('Fast mode stays beside the model when effort is hidden or unavailable', () => {
  const collector = new CodexCollector('/repo', '/home/u')
  collector.start('/repo', 0)
  const v = collector.snapshot()!
  const input = { v, o: DEFAULTS, l: en, t: makeTheme('graphite', true), now: 0 }
  v.session.model = 'gpt-6.1-sol'; v.session.effort = 'max'
  assert.equal(model(input), 'sol:max')
  v.session.fast = true
  assert.equal(model(input), 'sol:max(fast)')
  assert.equal(model({ ...input, o: { ...DEFAULTS, effort: false } }), 'sol(fast)')
  const t = makeTheme('graphite', false)
  assert.equal(model({ ...input, t }), t.paint('label', 'sol:') + t.paint(t.rgb.gradLow, 'max') + t.paint('faint', '(fast)'))
  v.session.effort = undefined
  assert.equal(model(input), 'sol(fast)')
  v.session.fast = false
  assert.equal(model(input), 'sol')
  v.session.model = undefined
  assert.equal(model(input), null)
})

test('OmO model IDs display named families or provider stems without versions', () => {
  const collector = new CodexCollector('/repo', '/home/u')
  collector.start('/repo', 0)
  const v = collector.snapshot()!
  v.core.host = 'omo'
  v.session.effort = 'high'
  const input = { v, o: DEFAULTS, l: en, t: makeTheme('graphite', true), now: 0 }
  for (const [id, name] of [
    ['claude-fable-5', 'fable'], ['claude-opus-5-5', 'opus'],
    ['claude-3-7-sonnet', 'sonnet'], ['claude-haiku-4-5', 'haiku'],
    ['gpt-6.1-sol', 'sol'], ['gpt-6-terra', 'terra'], ['gpt-6-luna', 'luna'],
    ['gpt-6-astra', 'astra'], ['gemini-4-argon', 'argon'],
    ['sol-6.1', 'sol'], ['GLM-5.1', 'glm'], ['k3', 'kimi'],
    ['k3.1-pro', 'kimi'], ['kimi-for-coding', 'kimi'], ['kimi-k3', 'kimi'],
    ['grok-4.1', 'grok'], ['qwen3.5-coder', 'qwen'], ['deepseek-v4', 'deepseek'],
    ['gemini-4-pro', 'gemini'], ['MiniMax-M3', 'minimax'],
    ['vendor/glm-5', 'glm'], ['custom-model-v2', 'custom'],
  ] as const) {
    v.session.model = id
    assert.equal(model(input), `${name}:high`, id)
    assert.equal(v.session.model, id)
  }
  v.session.model = undefined
  assert.equal(model(input), null)
})

test('OmO speed suffixes follow effort and stay visible when effort is hidden', () => {
  const collector = new CodexCollector('/repo', '/home/u')
  collector.start('/repo', 0)
  const v = collector.snapshot()!
  v.core.host = 'omo'
  const input = { v, o: DEFAULTS, l: en, t: makeTheme('graphite', true), now: 0 }
  for (const [id, name, speed] of [
    ['gpt-6.1-sol-fast', 'sol', 'fast'],
    ['claude-fable-5-ultrafast', 'fable', 'ultrafast'],
    ['k3.1-pro-highspeed', 'kimi', 'fast'],
    ['GLM-5-FAST', 'glm', 'fast'],
  ]) {
    v.session.model = id
    v.session.effort = 'high'
    assert.equal(model(input), `${name}:high(${speed})`)
    assert.equal(model({ ...input, o: { ...DEFAULTS, effort: false } }), `${name}(${speed})`)
    v.session.effort = 'off'
    assert.equal(model(input), `${name}:off(${speed})`)
    v.session.effort = undefined
    assert.equal(model(input), `${name}(${speed})`)
  }
  v.session.model = 'gpt-6.1-sol-ultrafast'
  v.session.effort = 'high'
  v.session.fast = true
  const t = makeTheme('graphite', false)
  assert.equal(model({ ...input, t }),
    t.paint('label', 'sol:') + t.paint(t.rgb.gradMid, 'high') + t.paint('faint', '(ultrafast)'))
  v.session.fast = false
  for (const [host, id, name] of [
    ['codex', 'gpt-6.1-sol-fast', 'gpt-6.1-sol-fast'],
    ['claude', 'claude-opus-5-5-fast', 'opus'],
    ['antigravity', 'gemini-4-pro-fast', 'pro-fast'],
  ] as const) {
    v.core.host = host
    v.session.model = id
    assert.equal(model(input), `${name}:high`)
    v.session.fast = true
    assert.equal(model(input), `${name}:high(fast)`)
    v.session.fast = false
  }
})
