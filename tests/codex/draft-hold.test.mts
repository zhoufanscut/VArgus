import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CodexCollector } from '../../src/hosts/codex/collect.ts'
import { codexLine } from '../../src/cli/codex/line.ts'
import { resolveCodexOptions } from '../../src/hosts/codex/options.ts'
import { makeTheme } from '../../src/theme/index.ts'
import { stringWidth } from '../../src/render/width.ts'

test('paused readings clone the last rendered values and time by default', async t => {
  let now = 60000
  t.mock.method(Date, 'now', () => now)
  const collector = new CodexCollector(process.cwd(), undefined)
  collector.start(process.cwd(), 0)
  const value = collector.snapshot()!
  value.session.model = 'gpt-6.1-sol'
  value.session.effort = 'xhigh'
  value.session.contextPercent = 18
  value.session.counts.agents = 1
  const options = resolveCodexOptions({ folder: false, rateLimits: false, tokens: false,
    repo: false, branch: false, status: false })
  const line = codexLine(collector, options, makeTheme('graphite', true))
  assert.equal(line.paused(200), '', 'no confirmed reading exists before the first render')
  const original = await line(200)
  assert.match(original, /sol:xhigh.*ctx:18%.*🤖1/)
  assert.equal(line.paused(200), original)
  now = 180000
  value.core.cwd = '/changed'
  value.session.model = 'gpt-6.1-terra'
  value.session.contextPercent = 90
  value.session.counts.agents = 2
  value.session.startedAt = Date.now()
  assert.equal(line.paused(200), original, 'mutable collector state cannot change paused readings')
  const narrow = line.paused(24)
  assert.ok(stringWidth(narrow) <= 24, 'the frozen values can reflow within the current width')
  assert.match(narrow, /^sol:xhigh/)
  assert.doesNotMatch(narrow, /stale/)
  assert.equal(line.paused(8, true), '⌛stale')
  const changed = await line(200)
  assert.match(changed, /terra:xhigh.*ctx:90%.*🤖2/)
  assert.equal(line.paused(200), changed, 'a new confirmed render replaces the snapshot')
})

test('a retained obsolete false option cannot disable paused readings', async () => {
  const collector = new CodexCollector(process.cwd(), undefined)
  collector.start(process.cwd(), 0)
  collector.snapshot()!.session.model = 'gpt-6.1-sol'
  const options = resolveCodexOptions({ codexDraftHold: false })
  assert.equal('codexDraftHold' in options, false)
  const line = codexLine(collector, options, makeTheme('graphite', true))
  const rendered = await line(200)
  assert.match(rendered, /sol/)
  assert.equal(line.paused(200), rendered)
})
