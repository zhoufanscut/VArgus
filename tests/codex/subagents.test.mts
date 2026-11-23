import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Views, type View } from '../../src/hosts/codex/views.ts'
import { RolloutReader } from '../../src/hosts/codex/rollout.ts'
import { codexLine } from '../../src/cli/codex/line.ts'
import { foldDescendantCounts } from '../../src/cli/codex/worker.ts'
import { resolveCodexOptions } from '../../src/hosts/codex/options.ts'
import { makeTheme } from '../../src/theme/index.ts'

const theme = makeTheme('graphite', true)
const jsonl = (records: unknown[]) => records.map(r => JSON.stringify(r) + '\n').join('')

const sessionMeta = (id: string, cwd: string, parent?: string, path?: string, extra: Record<string, unknown> = {}) => ({
  type: 'session_meta',
  payload: {
    id, cwd, timestamp: '2026-11-23T04:00:00Z', model_provider: 'openai',
    source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent, agent_path: path } } } : 'cli',
    ...extra,
  },
})

const tokenCount = (input: number, cached: number, output: number, window = 200000) => ({
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output },
      last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output },
      model_context_window: window,
    },
  },
})

const settings = (threadId: string, model: string, effort: string, cwd: string) => ({
  type: 'event_msg',
  payload: { type: 'thread_settings_applied', thread_id: threadId, thread_settings: { model, reasoning_effort: effort, cwd } },
})

const toolItem = (threadId: string, id: string) => ({
  type: 'event_msg',
  payload: { type: 'item_completed', thread_id: threadId, item: { type: 'CommandExecution', id, source: 'agent' } },
})

const agentSpawn = (threadId: string, id: string) => ({
  type: 'event_msg',
  payload: { type: 'item_completed', thread_id: threadId, item: { type: 'SubAgentActivity', id, kind: 'started' } },
})

const skillInjection = (turnId: string, name: string) => ({
  type: 'response_item',
  payload: {
    type: 'message', role: 'user',
    content: [{ type: 'input_text', text: `<skill>\n<name>${name}</name>\n<path>/repo/${name}/SKILL.md</path>\nbody\n</skill>` }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId, content_item_kinds: ['skills.selected_skill_instructions'] },
  },
})

test('Codex descendant folding sums attributable multi-level subtrees, skips unsafe logs and isolates view-only metrics', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-codex-subagents-'))
  const sessions = join(dir, 'sessions')
  await mkdir(sessions)
  try {
    const write = (name: string, records: unknown[]) => writeFile(join(sessions, name), jsonl(records))

    // Root: 2000 uncached + 500 output = 2500 tokens, 1 tool, 2 agents (spawned childA & childB), 1 skill.
    await write('rollout-root.jsonl', [
      sessionMeta('root', '/repo'),
      settings('root', 'gpt-6.1-sol', 'high', '/repo'),
      tokenCount(10000, 8000, 500),
      toolItem('root', 'r-t1'),
      agentSpawn('root', 'r-a1'),
      agentSpawn('root', 'r-a2'),
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'r1' } },
      skillInjection('r1', 'alpha'),
    ])

    // Clean childA: 3000 uncached + 1000 output = 4000 tokens, 2 tools, 1 agent (spawned grandchild), 1 skill.
    await write('rollout-childA.jsonl', [
      sessionMeta('childA', '/repo/child-a', 'root', '/root/childA'),
      settings('childA', 'gpt-6.1-sol', 'low', '/repo/child-a'),
      tokenCount(4000, 1000, 1000),
      toolItem('childA', 'a-t1'),
      toolItem('childA', 'a-t2'),
      agentSpawn('childA', 'a-a1'),
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'a1' } },
      skillInjection('a1', 'beta'),
    ])

    // Grandchild under childA: 1000 uncached + 500 output = 1500 tokens, 1 tool, 0 agents, 1 skill.
    await write('rollout-grandchild.jsonl', [
      sessionMeta('grandchild', '/repo/grand', 'childA', '/root/childA/grand'),
      settings('grandchild', 'gpt-6-luna', 'medium', '/repo/grand'),
      tokenCount(1000, 0, 500),
      toolItem('grandchild', 'g-t1'),
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'g1' } },
      skillInjection('g1', 'gamma'),
    ])

    // Paginated forked childB: skips inherited parent prefix (ordinals 1..2), counts own 2000 tokens + 1 tool.
    await write('rollout-childB.jsonl', [
      { ...sessionMeta('childB', '/repo', 'root', '/root/childB', { history_mode: 'paginated', subagent_history_start_ordinal: 3 }), ordinal: 0 },
      { ...sessionMeta('root', '/repo'), ordinal: 1 },
      { ...tokenCount(99000, 0, 1000), ordinal: 2 },
      { ...tokenCount(1500, 0, 500), ordinal: 3 },
      { ...toolItem('childB', 'b-t1'), ordinal: 4 },
    ])

    // Non-paginated mixed child: hits foreign session_meta, must be excluded from folding.
    await write('rollout-mixed.jsonl', [
      sessionMeta('mixed', '/repo', 'root', '/root/mixed'),
      sessionMeta('root', '/repo'),
      tokenCount(50000, 0, 0),
    ])

    // Replaced child: starts valid, later shrinks and regrows, must be excluded once replaced.
    const replacedFile = join(sessions, 'rollout-replaced.jsonl')
    await write('rollout-replaced.jsonl', [
      sessionMeta('replaced', '/repo', 'root', '/root/replaced'),
      tokenCount(1000, 0, 0),
    ])

    // Foreign root and its child: must be excluded from root's descendants.
    await write('rollout-foreign.jsonl', [
      sessionMeta('foreignRoot', '/other'),
      tokenCount(77000, 0, 0),
    ])
    await write('rollout-foreign-child.jsonl', [
      sessionMeta('foreignChild', '/other', 'foreignRoot', '/root/foreign'),
      tokenCount(88000, 0, 0),
    ])

    const views = new Views(dir, 'root', join(sessions, 'rollout-root.jsonl'))
    await views.refresh()
    // Unreadable/missing child registered in known views: skipped without disturbing active view.
    views.known.set('missing', { thread: 'missing', parent: 'root', path: '/root/missing', file: join(sessions, 'missing.jsonl'), cwd: '/repo' })

    const defaultLookups: string[] = []
    const modelDefault = async (model: string) => { defaultLookups.push(model); return 'high' }
    const readers = new Map<string, RolloutReader>()
    const getReader = (view: View) => {
      let reader = readers.get(view.thread)
      if (!reader) {
        reader = new RolloutReader(view.file, view.thread, view.cwd, dir, modelDefault)
        readers.set(view.thread, reader)
      }
      return reader
    }

    const rootView = views.known.get('root')!
    const rootReader = getReader(rootView)
    await rootReader.poll(true)
    const rootExtra = await foldDescendantCounts(views.descendants('root'), getReader)
    // childA (4000,2,1,1) + grandchild (1500,1,0,1) + childB (2000,1,0,0) + replaced (1000,0,0,0)
    assert.deepEqual(rootExtra, { tokens: 8500, tools: 4, agents: 1, skills: 2 })
    assert.deepEqual(defaultLookups, ['gpt-6.1-sol'], 'background descendant polls must not call modelDefault')

    const opts = resolveCodexOptions({ session: false, repo: false, branch: false, status: false, includeSubagents: true })
    const rootLine = codexLine(rootReader.collector, opts, theme)
    // Root (2500, 1, 2, 1) + extra (8500, 4, 1, 2) = (11000, 5, 3, 3), keeping root cache% (80%) and model (sol:high)
    const renderedRoot = await rootLine(500, rootExtra)
    assert.match(renderedRoot, /sol:high/)
    assert.match(renderedRoot, /token:11\.0k\(80%\)/)
    assert.match(renderedRoot, /🔧5 🤖3 ⚡3/)

    // Omitting extraCounts renders root self-only without mutating counts.
    const selfRoot = await rootLine(500)
    assert.match(selfRoot, /token:2\.5k\(80%\)/)
    assert.match(selfRoot, /🔧1 🤖2 ⚡1/)

    // Replace + regrow 'replaced' and append clean lines to 'mixed': neither may fold on next tick.
    await writeFile(replacedFile, '')
    await foldDescendantCounts(views.descendants('root'), getReader)
    await writeFile(replacedFile, jsonl([sessionMeta('replaced', '/repo', 'root', '/root/replaced'), tokenCount(9000, 0, 0), tokenCount(9000, 0, 0)]))
    await appendFile(join(sessions, 'rollout-mixed.jsonl'), jsonl([tokenCount(60000, 0, 0)]))
    const afterFaults = await foldDescendantCounts(views.descendants('root'), getReader)
    // Now only childA + grandchild + childB = (7500, 4, 1, 2)
    assert.deepEqual(afterFaults, { tokens: 7500, tools: 4, agents: 1, skills: 2 })

    // Promoting childA to active view resolves its modelDefault on unchanged file size and folds only grandchild.
    const childAView = views.known.get('childA')!
    const childAReader = getReader(childAView)
    await childAReader.poll(true)
    assert.equal(defaultLookups.length, 2)
    assert.equal(childAReader.collector.snapshot()!.session.defaultEffort, 'high')
    const childAExtra = await foldDescendantCounts(views.descendants('childA'), getReader)
    assert.deepEqual(childAExtra, { tokens: 1500, tools: 1, agents: 0, skills: 1 })
    const childALine = codexLine(childAReader.collector, opts, theme)
    // childA (4000, 2, 1, 1) + grandchild (1500, 1, 0, 1) = (5500, 3, 1, 2), cache% from childA (1000/4000 = 25%)
    const renderedChildA = await childALine(500, childAExtra)
    assert.match(renderedChildA, /sol:low/)
    assert.match(renderedChildA, /token:5\.5k\(25%\)/)
    assert.match(renderedChildA, /🔧3 🤖1 ⚡2/)

    // Leaf grandchild view has no descendants -> extraCounts is undefined -> self-only.
    const grandView = views.known.get('grandchild')!
    const grandReader = getReader(grandView)
    await grandReader.poll(true)
    const grandExtra = await foldDescendantCounts(views.descendants('grandchild'), getReader)
    assert.equal(grandExtra, undefined)
    const grandLine = codexLine(grandReader.collector, opts, theme)
    const renderedGrand = await grandLine(500, grandExtra)
    assert.match(renderedGrand, /luna:medium/)
    assert.match(renderedGrand, /token:1\.5k\(0%\)/)
    assert.match(renderedGrand, /🔧1/)
    assert.match(renderedGrand, /⚡1/)
    assert.doesNotMatch(renderedGrand, /🤖/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
