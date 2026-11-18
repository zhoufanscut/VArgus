import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { initialVcs } from '../../src/core/vcs.ts'
import { OmoVcs } from '../../src/hosts/omo/vcs.ts'

const exec = promisify(execFile)
const git = (cwd: string, args: string[]) => exec('git', args, {
  cwd,
  env: {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  },
})

async function repository(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'vargus-omo-git-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'repo')
  await mkdir(cwd)
  await git(cwd, ['init', '-b', 'main'])
  await git(cwd, ['remote', 'add', 'origin', 'https://example.com/fetch.git'])
  await git(cwd, ['remote', 'set-url', '--push', 'origin', 'https://example.com/push.git'])
  await writeFile(join(cwd, 'tracked.txt'), 'one\n')
  await git(cwd, ['add', '.'])
  await git(cwd, ['commit', '-m', 'initial'])
  return { root, cwd }
}

test('OmO reads real Git push remote, branch and porcelain counts', async t => {
  const { cwd } = await repository(t)
  await writeFile(join(cwd, 'tracked.txt'), 'two\n')
  await writeFile(join(cwd, 'new.txt'), 'new\n')
  const vcs = await new OmoVcs().refresh(cwd, false)
  assert.equal(vcs.kind, 'git')
  assert.equal(vcs.repo, 'push')
  assert.equal(vcs.branch, 'main')
  assert.deepEqual(vcs.counts, { staged: 0, modified: 1, untracked: 1, conflicted: 0, ahead: 0, behind: 0 })
})

test('OmO honors the poll floor while forced tool refreshes bypass it', async t => {
  const { cwd } = await repository(t)
  t.mock.method(Date, 'now', () => 0)
  const reader = new OmoVcs()
  await reader.refresh(cwd, false, 100_000)
  await writeFile(join(cwd, 'first.txt'), 'one\n')
  assert.equal((await reader.refresh(cwd, false, 104_999)).counts?.untracked, 0)
  assert.equal((await reader.refresh(cwd, false, 105_000)).counts?.untracked, 1)
  await writeFile(join(cwd, 'second.txt'), 'two\n')
  assert.equal((await reader.refresh(cwd, false, 105_001, true)).counts?.untracked, 2)
})

test('OmO holds slow Git reads for ten durations even on forced events', async t => {
  const { cwd } = await repository(t)
  // Model a 600 ms walk using the runtime clock; Git itself still runs in a real repository.
  let clock = 0
  t.mock.method(Date, 'now', () => {
    const now = clock
    clock += 600
    return now
  })
  const reader = new OmoVcs()
  await reader.refresh(cwd, false, 100_000)
  await writeFile(join(cwd, 'new.txt'), 'one\n')
  assert.equal((await reader.refresh(cwd, false, 106_599, true)).counts?.untracked, 0)
  assert.equal((await reader.refresh(cwd, false, 106_599)).counts?.untracked, 0)
  assert.equal((await reader.refresh(cwd, false, 106_600, true)).counts?.untracked, 1)
})

test('OmO refreshes after backward clock steps', async t => {
  const { cwd } = await repository(t)
  t.mock.method(Date, 'now', () => 0)
  const reader = new OmoVcs()
  await reader.refresh(cwd, false, 100_000)
  await writeFile(join(cwd, 'new.txt'), 'one\n')
  assert.equal((await reader.refresh(cwd, false, 99_999)).counts?.untracked, 1)
})

test('OmO reads linked worktrees and detached refs when enabled', async t => {
  const { root, cwd } = await repository(t)
  await git(cwd, ['tag', 'release'])
  const worktree = join(root, 'linked')
  await git(cwd, ['worktree', 'add', '-b', 'feature', worktree])
  await git(worktree, ['checkout', 'release'])
  const reader = new OmoVcs()
  const hidden = await reader.refresh(worktree, false)
  assert.equal(hidden.worktree, 'linked')
  assert.equal(hidden.detached, null)
  const shown = await reader.refresh(worktree, true)
  assert.equal(shown.branch, null)
  assert.deepEqual(shown.detached, { name: 'release', onBranch: false, operation: null, progress: '' })
})

test('OmO coalesces concurrent reads of the same directory', async t => {
  const { cwd } = await repository(t)
  t.mock.method(Date, 'now', () => 0)
  const reader = new OmoVcs()
  const first = reader.refresh(cwd, false, 100_000)
  const second = reader.refresh(cwd, false, 100_000, true)
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.branch, 'main')
  assert.equal(a, b)
  assert.equal(reader.values, a)
})

test('OmO directory changes clear values and discard earlier pending results', async t => {
  const { root, cwd } = await repository(t)
  const other = join(root, 'other')
  await mkdir(other)
  await git(other, ['init', '-b', 'other'])
  const reader = new OmoVcs()
  const first = reader.refresh(cwd, false)
  const second = reader.refresh(other, false)
  assert.deepEqual(reader.values, initialVcs())
  assert.deepEqual(await first, initialVcs())
  assert.equal((await second).branch, 'other')
  assert.equal(reader.values.branch, 'other')
})

test('OmO disposal prevents pending and future reads from publishing values', async t => {
  const { cwd } = await repository(t)
  const reader = new OmoVcs()
  const pending = reader.refresh(cwd, false)
  reader.dispose()
  assert.deepEqual(await pending, initialVcs())
  assert.deepEqual(await reader.refresh(cwd, false), initialVcs())
  assert.deepEqual(reader.values, initialVcs())
})

test('OmO clears Git values on an empty or non-repository directory', async t => {
  const { root, cwd } = await repository(t)
  const reader = new OmoVcs()
  await reader.refresh(cwd, false)
  assert.deepEqual(await reader.refresh('', false), initialVcs())
  assert.deepEqual(await reader.refresh(root, false), initialVcs())
})
