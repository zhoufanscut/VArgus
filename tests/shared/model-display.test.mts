import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Values } from '../../src/core/types.ts'
import { antigravityDisplay } from '../../src/hosts/antigravity/display.ts'
import { claudeDisplay } from '../../src/hosts/claude/display.ts'
import { CodexCollector } from '../../src/hosts/codex/collect.ts'
import { codexDisplay } from '../../src/hosts/codex/display.ts'
import { resolveCodexOptions, type CodexOptions } from '../../src/hosts/codex/options.ts'
import { omoDisplay } from '../../src/hosts/omo/display.ts'
import { effortColor, model } from '../../src/render/fragments/model.ts'
import { calls } from '../../src/render/fragments/calls.ts'
import { context } from '../../src/render/fragments/context.ts'
import { DEFAULTS } from '../../src/options.ts'
import { en } from '../../src/i18n/en.ts'
import { makeTheme } from '../../src/theme/index.ts'
import { PALETTES } from '../../src/theme/palettes.ts'

const defaults = resolveCodexOptions({})
const plain = makeTheme('graphite', true)

function codexInput(v: Values, o: CodexOptions = defaults, t = plain) {
  return { v, display: codexDisplay(v.session, o), o, l: en, t, now: 0 }
}

test('each palette uses calm at or above the model default or high cutoff', () => {
  const collector = new CodexCollector('/repo', '/home/u')
  collector.start('/repo', 0)
  const v = collector.snapshot()!
  v.session.model = 'gpt-6.1-sol'
  for (const name of Object.keys(PALETTES)) {
    const t = makeTheme(name, false)
    for (const [effort, defaultEffort, color] of [
      ['low', 'low', t.rgb.gradLow], ['medium', 'medium', t.rgb.gradLow], ['high', 'xhigh', t.rgb.gradHigh],
      ['low', 'medium', t.rgb.gradHigh], ['HIGH', 'medium', t.rgb.gradLow], ['ultra', 'max', t.rgb.gradLow],
      ['medium', undefined, t.rgb.gradHigh], ['high', undefined, t.rgb.gradLow],
      ['xhigh', undefined, t.rgb.gradLow], ['max', undefined, t.rgb.gradLow], ['ultra', undefined, t.rgb.gradLow],
      ['odd', 'medium', t.rgb.gradHigh], [4096, 'medium', t.rgb.gradHigh],
    ] as const) {
      assert.deepEqual(effortColor(t, effort, defaultEffort), color, `${name}: ${effort} with default ${defaultEffort}`)
      v.session.effort = effort
      v.session.defaultEffort = defaultEffort
      assert.equal(model(codexInput(v, defaults, t)),
        t.paint('label', 'sol:') + t.paint(color, String(effort).toLowerCase()))
    }
  }
})

test('Codex short names retain full IDs internally and preserve unfamiliar model IDs', () => {
  const collector = new CodexCollector('/repo', '/home/u')
  collector.start('/repo', 0)
  const v = collector.snapshot()!
  v.session.effort = 'xhigh'
  for (const [id, short] of [
    ['gpt-6-astra', 'astra'], ['gpt-6.1-sol', 'sol'], ['gpt-6-sol', 'sol'],
    ['gpt-6.1-terra', 'terra'], ['gpt-6-luna', 'luna'],
    ['gpt-4o', 'gpt-4o'], ['vendor/gpt-6.1-sol', 'vendor/gpt-6.1-sol'], ['custom-sol', 'custom-sol'],
  ]) {
    v.session.model = id
    assert.equal(model(codexInput(v)), short + ':xhigh')
    assert.equal(v.session.model, id)
  }
  v.session.model = 'gpt-6.1-sol'
  assert.deepEqual(resolveCodexOptions({ codexShortModel: false }), defaults)
  assert.equal(model(codexInput(v, { ...defaults, effort: false })), 'sol')
  Object.assign(v.session.counts, { tools: 7, agents: 2, skills: 3 })
  assert.equal(calls(codexInput(v)), '🔧7 🤖2 ⚡3')
  assert.equal(calls(codexInput(v, resolveCodexOptions({ codexAgentCounts: false }))), '🔧7 ⚡3')
  assert.equal(calls(codexInput(v, resolveCodexOptions({ codexSkillCounts: false }))), '🔧7 🤖2')
  assert.equal(calls(codexInput(v)), '🔧7 🤖2 ⚡3')
  assert.equal(context(codexInput(v)), null)
  v.session.contextPercent = 0
  assert.equal(context(codexInput(v)), 'ctx:0%')
})

test('Fast mode stays beside the model when effort is hidden or unavailable', () => {
  const collector = new CodexCollector('/repo', '/home/u')
  collector.start('/repo', 0)
  const v = collector.snapshot()!
  v.session.model = 'gpt-6.1-sol'; v.session.effort = 'max'
  v.session.defaultEffort = 'low'
  assert.equal(model(codexInput(v)), 'sol:max')
  v.session.fast = true
  assert.equal(model(codexInput(v)), 'sol:max(fast)')
  assert.equal(model(codexInput(v, { ...defaults, effort: false })), 'sol(fast)')
  const t = makeTheme('graphite', false)
  assert.equal(model(codexInput(v, defaults, t)), t.paint('label', 'sol:') + t.paint(t.rgb.gradLow, 'max') + t.paint('faint', '(fast)'))
  v.session.effort = undefined
  assert.equal(model(codexInput(v)), 'sol(fast)')
  v.session.fast = false
  assert.equal(model(codexInput(v)), 'sol')
  v.session.model = undefined
  assert.equal(model(codexInput(v)), null)
})

test('OmO model IDs display named families or provider stems without versions', () => {
  const collector = new CodexCollector('/repo', '/home/u')
  collector.start('/repo', 0)
  const v = collector.snapshot()!
  v.session.effort = 'high'
  const input = () => ({ v, display: omoDisplay(v.session), o: DEFAULTS, l: en, t: plain, now: 0 })
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
    assert.equal(model(input()), `${name}:high`, id)
    assert.equal(v.session.model, id)
  }
  v.session.model = undefined
  assert.equal(model(input()), null)
})

test('OmO speed suffixes follow effort and stay visible when effort is hidden', () => {
  const collector = new CodexCollector('/repo', '/home/u')
  collector.start('/repo', 0)
  const v = collector.snapshot()!
  const input = () => ({ v, display: omoDisplay(v.session), o: DEFAULTS, l: en, t: plain, now: 0 })
  for (const [id, name, speed] of [
    ['gpt-6.1-sol-fast', 'sol', 'fast'],
    ['claude-fable-5-ultrafast', 'fable', 'ultrafast'],
    ['k3.1-pro-highspeed', 'kimi', 'fast'],
    ['GLM-5-FAST', 'glm', 'fast'],
  ]) {
    v.session.model = id
    v.session.effort = 'high'
    assert.equal(model(input()), `${name}:high(${speed})`)
    assert.equal(model({ ...input(), o: { ...DEFAULTS, effort: false } }), `${name}(${speed})`)
    v.session.effort = 'off'
    assert.equal(model(input()), `${name}:off(${speed})`)
    v.session.effort = undefined
    assert.equal(model(input()), `${name}(${speed})`)
  }
  v.session.model = 'gpt-6.1-sol-ultrafast'
  v.session.effort = 'high'
  v.session.defaultEffort = 'high'
  v.session.fast = true
  const t = makeTheme('graphite', false)
  assert.equal(model({ ...input(), t }),
    t.paint('label', 'sol:') + t.paint(t.rgb.gradLow, 'high') + t.paint('faint', '(ultrafast)'))
  v.session.fast = false
  for (const [display, id, name] of [
    [(session: Values['session']) => codexDisplay(session, defaults), 'gpt-6.1-sol-fast', 'gpt-6.1-sol-fast'],
    [claudeDisplay, 'claude-opus-5-5-fast', 'opus'],
    [antigravityDisplay, 'gemini-4-pro-fast', 'pro-fast'],
  ] as const) {
    v.session.model = id
    const other = () => ({ ...input(), display: display(v.session) })
    assert.equal(model(other()), `${name}:high`)
    v.session.fast = true
    assert.equal(model(other()), `${name}:high(fast)`)
    v.session.fast = false
  }
})
