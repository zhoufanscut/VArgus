import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    assert.ok(changed.includes(second))
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

test('Codex renders a detached tag and linked worktree when detachedHead is on', async () => {
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

    for (const detachedHead of [false, true]) {
      const collector = new CodexCollector(linked, undefined)
      collector.start(linked, 0)
      const line = codexLine(collector, resolveCodexOptions({ detachedHead }), theme)
      await line(500)
      await ready(collector, 'main')
      const row = await line(500)
      assert.match(row, /repo:main.*\?1/)
      if (detachedHead) assert.match(row, /branch:@v1 \(wt:linked\)/)
      else assert.doesNotMatch(row, /branch:/)
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
