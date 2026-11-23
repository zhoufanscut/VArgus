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
    assert.equal(line.paused(500), changed + ' | ⌛stale')
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
      assert.match(row, /branch:@v1 \(wt:linked\)/)
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('codexLine forwards isWsl to call counts and reuses the stale marker when paused', async () => {
  const collector = new CodexCollector('/repo', undefined)
  collector.start('/repo', 0)
  collector.snapshot()!.session.counts.tools = 3
  const colored = makeTheme('graphite', false)
  const options = resolveCodexOptions({ repo: false, branch: false, status: false, session: false })
  const line = codexLine(collector, options, colored, true)
  const live = await line(200)
  assert.ok(live.includes(colored.paint('label', 'T:3')))
  assert.equal(line.paused(200), live + colored.paint('sep', ' | ') + colored.paint('label', '!:stale'))
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
