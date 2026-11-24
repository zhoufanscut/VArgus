import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { CodexCollector } from '../../src/hosts/codex/collect.ts'
import { codexLine } from '../../src/cli/codex/line.ts'
import { initialVcs } from '../../src/core/vcs.ts'
import { resolveCodexOptions } from '../../src/hosts/codex/options.ts'
import { makeTheme } from '../../src/theme/index.ts'

const exec = promisify(execFile)
const theme = makeTheme('graphite', true)

async function repository(parent: string, name: string): Promise<string> {
  const cwd = join(parent, name)
  await exec('git', ['init', '-q', '-b', name, cwd])
  await exec('git', ['remote', 'add', 'origin', `https://example.invalid/${name}.git`], { cwd })
  await writeFile(join(cwd, 'changed.txt'), 'local fixture\n')
  return cwd
}

async function ready(collector: CodexCollector, branch: string): Promise<void> {
  const until = Date.now() + 5000
  while (collector.snapshot()!.vcs.repo !== branch && Date.now() < until) await delay(10)
  assert.equal(collector.snapshot()!.vcs.repo, branch)
}

test('cwd changes clear the previous Git readings before rendering or pausing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-line-'))
  try {
    const first = await repository(dir, 'first'), second = await repository(dir, 'second')
    const collector = new CodexCollector(first, undefined)
    collector.start(first, 0)
    const line = codexLine(collector, resolveCodexOptions({ session: false }), theme)
    await line(500)
    await ready(collector, 'first')
    assert.match(await line(500), /repo:first.*branch:first.*\?1/)
    collector.snapshot()!.core.cwd = second
    const changed = await line(500)
    assert.equal(changed.split(' | ')[0], '.../' + basename(dir) + '/second')
    assert.doesNotMatch(changed, /repo:|branch:|\?1/)
    assert.equal(line.paused(500), changed)
    await ready(collector, 'second')
    assert.match(await line(500), /repo:second.*branch:second.*\?1/)
    const vcs = collector.snapshot()!.vcs
    assert.equal(vcs.counts!.untracked, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('hidden Git fragments leave the Codex collector untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-line-hidden-'))
  try {
    const cwd = await repository(dir, 'project')
    const hidden = new CodexCollector(cwd, undefined), visible = new CodexCollector(cwd, undefined)
    for (const collector of [hidden, visible]) collector.start(cwd, 0)
    const hiddenLine = codexLine(hidden, resolveCodexOptions({ repo: false, branch: false, status: false }), theme)
    await hiddenLine(500)
    // The same real repository and reader provide a positive collection control.
    await codexLine(visible, resolveCodexOptions({}), theme)(500)
    await ready(visible, 'project')
    await delay(100)
    assert.deepEqual(hidden.snapshot()!.vcs, initialVcs())
    assert.doesNotMatch(await hiddenLine(500), /repo:|branch:|\?1/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('Codex renders a detached tag and linked worktree by default and with a legacy setting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-line-worktree-'))
  try {
    const cwd = await repository(dir, 'main')
    const linked = join(dir, 'linked')
    await exec('git', ['add', 'changed.txt'], { cwd })
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com',
      'commit', '--no-gpg-sign', '-m', 'initial'], { cwd })
    await exec('git', ['tag', 'v1'], { cwd })
    await exec('git', ['worktree', 'add', '-b', 'feature', linked], { cwd })
    await exec('git', ['checkout', 'v1'], { cwd: linked })
    await writeFile(join(linked, 'untracked.txt'), 'local fixture\n')

    for (const options of [{}, { detachedHead: false }]) {
      const collector = new CodexCollector(linked, undefined)
      collector.start(linked, 0)
      const line = codexLine(collector, resolveCodexOptions(options), theme)
      await line(500)
      await ready(collector, 'main')
      const row = await line(500)
      assert.match(row, /repo:main.*\?1/)
      assert.match(row, /branch:@v1\(wt:linked\)/)
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('codexLine forwards isWsl to call counts and reuses the stale marker for a held side chat', async () => {
  const collector = new CodexCollector('/repo', undefined)
  collector.start('/repo', 0)
  collector.snapshot()!.session.counts.tools = 3
  const colored = makeTheme('graphite', false)
  const options = resolveCodexOptions({ repo: false, branch: false, status: false, session: false })
  const line = codexLine(collector, options, colored, true)
  const live = await line(200)
  assert.ok(live.includes(colored.paint('label', 'T:3')))
  assert.equal(line.paused(200, true), live + colored.paint('sep', ' | ') + colored.paint('label', '!:stale'))
})

test('codexLine renders SVN working copies outside Git', { skip: process.platform === 'win32' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-line-svn-'))
  const savedPath = process.env.PATH
  t.after(async () => {
    if (savedPath === undefined) delete process.env.PATH
    else process.env.PATH = savedPath
    await rm(dir, { recursive: true, force: true })
  })
  const bin = join(dir, 'bin')
  const wc = join(dir, 'wc')
  await mkdir(bin, { recursive: true })
  await mkdir(join(wc, '.svn'), { recursive: true })
  const shim = join(bin, 'svn')
  await writeFile(shim, [
    '#!/bin/sh',
    'if [ "$2" = "info" ]; then',
    '  printf \'%s\' \'<info><entry kind="dir" path="." revision="5"><url>https://h/r/svnproj/trunk</url><repository><root>https://h/r</root></repository></entry></info>\'',
    'elif [ "$2" = "status" ]; then',
    '  printf \'%s\' \'<status><target path="."><entry path="a"><wc-status item="unversioned" props="none"></wc-status></entry></target></status>\'',
    'else exit 1; fi',
  ].join('\n') + '\n')
  await chmod(shim, 0o755)
  process.env.PATH = `${bin}${delimiter}${savedPath ?? ''}`

  const collector = new CodexCollector(wc, undefined)
  collector.start(wc, 0)
  const line = codexLine(collector, resolveCodexOptions({ session: false }), theme)
  await line(500)
  await ready(collector, 'svnproj')
  assert.match(await line(500), /repo:svnproj \| branch:trunk \| \?1/)
})

test('codexLine folds extraCounts without mutating the collector, keeps viewed metrics and VCS live, and preserves folded counts in an ordinary draft', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-line-extra-'))
  try {
    const cwd = await repository(dir, 'project')
    const collector = new CodexCollector(cwd, undefined)
    collector.start(cwd, 0)
    const snap = collector.snapshot()!
    snap.session.model = 'gpt-6.1-sol'
    snap.session.effort = 'high'
    collector.updateUsage({
      total: { inputTokens: 42424, cachedInputTokens: 40000, outputTokens: 777, totalTokens: 43201 },
      last: { inputTokens: 42424, cachedInputTokens: 40000, outputTokens: 777, totalTokens: 43201 },
      modelContextWindow: 190000,
    })
    collector.recordResponseRate(150, 1000)
    snap.session.counts.tools = 2
    snap.session.counts.agents = 1
    snap.session.counts.skills = 1

    const line = codexLine(collector, resolveCodexOptions({ session: false }), theme)
    const extra = { tokens: 5000, tools: 3, agents: 2, skills: 4 }
    const first = await line(500, extra)
    assert.match(first, /ctx:18%/)
    assert.match(first, /token:8\.2k\(94\.3%, 150t\/s\)/)
    assert.match(first, /🔧5 🤖3 ⚡5/)
    assert.deepEqual(collector.snapshot()!.session.counts, { tokens: 3201, tools: 2, agents: 1, skills: 1 },
      'folding extraCounts must not mutate the live collector counts')
    assert.equal(line.paused(500), first, 'paused snapshot must retain folded counts')

    // Live async pollVcs() must still populate v.vcs even when extraCounts is passed.
    await ready(collector, 'project')
    const withVcs = await line(500, extra)
    assert.match(withVcs, /token:8\.2k\(94\.3%, 150t\/s\)/)
    assert.match(withVcs, /🔧5 🤖3 ⚡5/)
    assert.match(withVcs, /repo:project \| branch:project \| \?1/)
    assert.equal(line.paused(500), withVcs)

    // Rendering without extraCounts returns to the viewed thread's own totals.
    const selfOnly = await line(500)
    assert.match(selfOnly, /token:3\.2k\(94\.3%, 150t\/s\)/)
    assert.match(selfOnly, /🔧2 🤖1 ⚡1/)
    assert.doesNotMatch(selfOnly, /token:8\.2k/)

    // A zero-token main collector still renders folded descendant counts without mutating itself.
    const empty = new CodexCollector(cwd, undefined)
    empty.start(cwd, 0)
    const emptyLine = codexLine(empty, resolveCodexOptions({ session: false, repo: false, branch: false, status: false }), theme)
    const foldedEmpty = await emptyLine(500, { tokens: 1500, tools: 1, agents: 0, skills: 2 })
    assert.match(foldedEmpty, /token:1\.5k/)
    assert.match(foldedEmpty, /🔧1 ⚡2/)
    assert.deepEqual(empty.snapshot()!.session.counts, { tokens: 0, tools: 0, agents: 0, skills: 0 })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('codexLine uses the 1M alert threshold by default and 4M with includeSubagents (including paused snapshots)', async () => {
  const colored = makeTheme('graphite', false)
  const baseOpts = { session: false, repo: false, branch: false, status: false }
  const collector = new CodexCollector('/repo', undefined)
  collector.start('/repo', 0)
  collector.updateUsage({
    total: { inputTokens: 1_500_000, cachedInputTokens: 0, outputTokens: 0, totalTokens: 1_500_000 },
    last: { inputTokens: 1_500_000, cachedInputTokens: 0, outputTokens: 0, totalTokens: 1_500_000 },
    modelContextWindow: 200_000,
  })

  const mainLine = codexLine(collector, resolveCodexOptions({ ...baseOpts, includeSubagents: false }), colored)
  const mainRow = await mainLine(200)
  assert.ok(mainRow.includes(colored.paint('label', 'token:') + colored.paint('alert', '1.50M')))
  assert.equal(mainLine.paused(200), mainRow)

  const subLine = codexLine(collector, resolveCodexOptions({ ...baseOpts, includeSubagents: true }), colored)
  const subCalm = await subLine(200, { tokens: 2_494_999, tools: 0, agents: 0, skills: 0 })
  assert.ok(subCalm.includes(colored.paint('label', 'token:') + colored.paint('calm', '3.99M')))
  assert.equal(subLine.paused(200), subCalm)

  const subAlert = await subLine(200, { tokens: 2_495_000, tools: 0, agents: 0, skills: 0 })
  assert.ok(subAlert.includes(colored.paint('label', 'token:') + colored.paint('alert', '4.00M')))
  assert.equal(subLine.paused(200), subAlert)
})
