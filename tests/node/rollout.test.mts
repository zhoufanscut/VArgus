import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, appendFile, rm, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { RolloutReader, findRollout } from '../../src/hosts/codex/rollout'

const meta = { type: 'session_meta', payload: { id: 'thread-a', cwd: '/repo', timestamp: '2026-11-08T05:41:17Z' } }
const amount = { input_tokens: 42424, cached_input_tokens: 40000, output_tokens: 777, total_tokens: 43201 }
const count = { type: 'event_msg', payload: { type: 'token_count', info: {
  total_token_usage: amount, last_token_usage: amount, model_context_window: 190000,
}, rate_limits: { limit_id: 'codex', primary: { used_percent: 27.5, window_minutes: 300, resets_at: null } } } }
const settings = { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: 'thread-a',
  thread_settings: { model: 'gpt-6.1-sol', reasoning_effort: 'low', cwd: '/repo' } } }

test('official rollout readings replay cumulative usage, settings and limits without counting user-shell controls', () => {
  const r = new RolloutReader('/unused', 'thread-a', '/repo', '/home/user')
  r.observe(meta); r.observe(settings); r.observe(count); r.observe(count)
  r.observe({ type: 'event_msg', payload: { type: 'item_completed', thread_id: 'thread-a',
    item: { type: 'CommandExecution', id: 'user', source: 'user_shell' } } })
  assert.equal(r.collector.snapshot()!.session.counts.tools, 0)
  const tool = { type: 'event_msg', payload: { type: 'item_completed', thread_id: 'thread-a',
    item: { type: 'CommandExecution', id: 'tool', source: 'agent' } } }
  r.observe(tool); r.observe(tool)
  const v = r.collector.snapshot()!
  assert.equal(v.session.model, 'gpt-6.1-sol'); assert.equal(v.session.effort, 'low')
  assert.equal(v.session.counts.tokens, 3201); assert.equal(v.session.counts.tools, 1)
  assert.equal(v.session.contextPercent, 18); assert.equal(v.limits.engine[0]!.percentUsed, 27.5)
  r.observe({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: 'other',
    thread_settings: { model: 'wrong', cwd: '/wrong' } } })
  assert.equal(v.session.model, 'gpt-6.1-sol')
  r.observe({ type: 'compacted', payload: {} }); assert.equal(v.session.contextPercent, undefined)
  r.observe(count); assert.equal(v.session.contextPercent, 18)
})

test('rollout polling waits for complete UTF-8 JSONL records and selects the exact thread filename', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-rollout-'))
  try {
    await mkdir(join(dir, 'sessions'))
    const file = join(dir, 'sessions', 'rollout-date-thread-a.jsonl')
    await writeFile(file, JSON.stringify(meta) + '\n')
    await writeFile(join(dir, 'sessions', 'rollout-date-thread-b.jsonl'), 'other conversation')
    assert.equal(await findRollout(dir, 'thread-a'), file)
    const r = new RolloutReader(file, 'thread-a', '/repo', dir)
    await r.poll()
    const text = JSON.stringify({ type: 'turn_context', payload: { model: 'model', cwd: '/repo/中文', effort: 'low' } }) + '\n'
    const data = Buffer.from(text), split = data.indexOf(Buffer.from('中文')) + 1
    await appendFile(file, data.subarray(0, split)); await r.poll()
    assert.equal(r.collector.snapshot()!.core.cwd, '/repo')
    await appendFile(file, data.subarray(split)); await r.poll()
    assert.equal(r.collector.snapshot()!.core.cwd, '/repo/中文')
    await appendFile(file, JSON.stringify(count) + '\n'); await r.poll()
    assert.equal(r.collector.snapshot()!.session.counts.tokens, 3201)
    await writeFile(file, ''); await assert.rejects(r.poll(), /replaced/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('the Bash entry resolves an external symlink and runs from a different cwd', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus entry '))
  try {
    const link = join(dir, 'vargus')
    await symlink(resolve('bin/vargus'), link)
    const { stdout } = await promisify(execFile)(link, ['--help'], { cwd: dir })
    assert.match(stdout, /vargus on\|off\|status/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
