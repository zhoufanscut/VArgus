import { describe, expect, mock, test, type MockClock } from 'claude-code/testing'
import type { On, SessionRepo } from 'claude-code'

// The vcs collector driven through the mod's own hooks: the git-vs-svn
// choice, the worktree and detached-HEAD reads from the git dir, and the
// refresh policy (src/collect/vcs.ts, "When to refresh"). The rendered line
// is read back from the line file's fs.write.

const CWD = '/home/u/proj/x'
const GIT_DIR = `${CWD}/.git`
const SHA = '18f67cd43ae5c767c4e8bb91fd55f794fe97b8c9'

type World = {
  repo: SessionRepo | null
  gitDir: string
  status: string
  // ms each git status holds on the mock clock
  statusMs: number
  // files: path → text (fs.read), and existence (fs.exists)
  files: Record<string, string>
  dirs: Set<string>
  realCwd: string
  svnInfo: string
  svnStatus: string
  runs: string[][]
  // every fs.read path, in order
  reads: string[]
  writes: string[]
}

function world(on: On, clock: MockClock): World {
  const w: World = {
    repo: { root: CWD, remote: 'git@github.com:u/proj.git', internal: false, name: null },
    gitDir: GIT_DIR,
    status: '# branch.oid 1\n# branch.head main\n? new\n',
    statusMs: 0,
    files: {},
    dirs: new Set(),
    realCwd: CWD,
    svnInfo: '',
    svnStatus: '',
    runs: [],
    reads: [],
    writes: [],
  }
  mock.env(on, { HOME: '/home/u', NO_COLOR: '1' }) // plain text to match
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'S1' }))
  on('session.cwd', async () => ({ value: CWD }))
  on('session.repo', async () => ({ value: w.repo }))
  on('fs.write', async ($, e) => {
    w.writes.push(e.text)
    return { value: undefined }
  })
  on('fs.exists', async ($, e) => ({ value: e.path in w.files || w.dirs.has(e.path) }))
  on('fs.read', async ($, e) => {
    w.reads.push(e.path)
    const text = w.files[e.path]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.stat', async () => ({ value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false, realPath: w.realCwd } }))
  const ok = (stdout: string, exitCode = 0) =>
    ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', async ($, e) => {
    const argv = [...e.argv]
    if (argv[0] === 'mv') return ok('')
    w.runs.push(argv)
    if (argv[0] === 'git') expect(e.init?.env).toEqual({ GIT_OPTIONAL_LOCKS: '0' })
    if (argv.includes('--absolute-git-dir')) return ok(`${w.gitDir}\n`)
    if (argv.includes('status') && argv[0] === 'git') {
      if (w.statusMs) await clock.sleep(w.statusMs)
      return ok(w.status)
    }
    if (argv.includes('--short')) return ok('a1b2c3d\n')
    if (argv[0] === 'svn' && argv.includes('info')) return ok(w.svnInfo)
    if (argv[0] === 'svn' && argv.includes('status')) return ok(w.svnStatus)
    return ok('', 1)
  })
  return w
}

const start = { cwd: CWD, surface: 'terminal', isInteractive: true } as const
const gitStatusRuns = (w: World) => w.runs.filter(r => r[0] === 'git' && r.includes('status')).length
const line = (w: World) => w.writes[w.writes.length - 1] ?? ''

describe('vcs collector', () => {
  test('git: repo from the remote, branch, counts; git runs with fsmonitor off', async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    await $.session.start(start)
    await clock.advance(1000)
    expect(line(w)).toContain('repo:proj | branch:main | ?1')
    expect(w.runs[0]?.slice(0, 3)).toEqual(['git', '-c', 'core.fsmonitor=false'])
  })

  test('a linked worktree (commondir in its git dir) gets the (wt:) suffix', async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    w.gitDir = '/home/u/proj/main/.git/worktrees/wt1'
    w.files[`${w.gitDir}/commondir`] = '../..\n'
    await $.session.start(start)
    await clock.advance(1000)
    expect(line(w)).toContain('branch:main (wt:wt1)')
  })

  test('git wins over svn: a git repo inside an svn working copy never runs svn', async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    w.dirs.add('/home/u/.svn')
    await $.session.start(start)
    await clock.advance(1000)
    expect(w.runs.some(r => r[0] === 'svn')).toBe(false)
    expect(line(w)).toContain('branch:main')
  })

  test('svn only outside git: .svn found above the resolved folder', async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    w.repo = null
    // the session's folder is a symlink into /data/wc/sub; .svn is at /data/wc
    w.realCwd = '/data/wc/sub'
    w.dirs.add('/data/wc/.svn')
    w.svnInfo = '<info><entry kind="dir" path="." revision="7"><url>https://h/r/proj/trunk/sub</url>'
      + '<repository><root>https://h/r</root></repository></entry></info>'
    w.svnStatus = '<status><target path="."><entry path="a"><wc-status item="unversioned" props="none"></wc-status></entry></target></status>'
    await $.session.start(start)
    await clock.advance(1000)
    expect(line(w)).toContain('repo:proj | branch:trunk@7 | ?1')
    expect(w.runs).toEqual([['svn', '--non-interactive', 'info', '--xml'], ['svn', '--non-interactive', 'status', '--xml']])
  })

  test('neither git nor svn: no vcs fragments and no commands', async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    w.repo = null
    await $.session.start(start)
    await clock.advance(1000)
    expect(w.runs).toEqual([])
    expect(line(w)).not.toContain('branch:')
  })

  test('detached at a tag: named from the reflog and refs, with the option on', { options: { detachedHead: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    w.status = `# branch.oid ${SHA}\n# branch.head (detached)\n`
    w.files[`${GIT_DIR}/HEAD`] = `${SHA}\n`
    w.files[`${GIT_DIR}/logs/HEAD`] = `0000 c4ef t <t@t> 1 +0800\tcommit: x\nc4ef ${SHA} t <t@t> 1792051315 +0800\tcheckout: moving from feat to v1.0\n`
    w.files[`${GIT_DIR}/packed-refs`] = `# pack-refs with: peeled fully-peeled sorted \n${SHA} refs/tags/v1.0\n`
    await $.session.start(start)
    await clock.advance(1000)
    expect(line(w)).toContain('branch:@v1.0')
  })

  test('detached, the reflog moved on: 7 sha digits; a loose ref in the common dir names it', { options: { detachedHead: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    w.status = `# branch.oid ${SHA}\n# branch.head (detached)\n`
    w.files[`${GIT_DIR}/HEAD`] = `${SHA}\n`
    w.files[`${GIT_DIR}/logs/HEAD`] = `c4ef ${SHA} t <t@t> 1 +0800\tcommit: moved on\n`
    w.files[`${GIT_DIR}/packed-refs`] = `${SHA} refs/tags/v1.0\n`
    await $.session.start(start)
    await clock.advance(1000)
    expect(line(w)).toContain('branch:@18f67cd')
    // a checkout entry that did not produce this HEAD (a reset since) names nothing
    w.files[`${GIT_DIR}/logs/HEAD`] = `c4ef 0000000000000000000000000000000000000001 t <t@t> 1 +0800\tcheckout: moving from main to v1.0\n`
    await clock.advance(5000)
    expect(line(w)).toContain('branch:@18f67cd')
    // a linked worktree's refs are in its common dir
    w.gitDir = '/r/.git/worktrees/w'
    w.files['/r/.git/worktrees/w/HEAD'] = `${SHA}\n`
    w.files['/r/.git/worktrees/w/commondir'] = '../..\n'
    w.files['/r/.git/worktrees/w/logs/HEAD'] = `c4ef ${SHA} t <t@t> 1 +0800\tcheckout: moving from main to origin/main\n`
    w.files['/r/.git/refs/remotes/origin/main'] = `${SHA}\n`
    await clock.advance(5000)
    expect(line(w)).toContain('branch:@origin/main (wt:w)')
  })

  test('mid-rebase: the branch from head-name with the step; am when rebase-apply has no rebasing', { options: { detachedHead: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    w.status = `# branch.oid ${SHA}\n# branch.head (detached)\nu UU N... 1 2 3 4 a b c f\n`
    w.files[`${GIT_DIR}/HEAD`] = `${SHA}\n`
    w.files[`${GIT_DIR}/rebase-merge/head-name`] = 'refs/heads/feat\n'
    w.files[`${GIT_DIR}/rebase-merge/msgnum`] = '2\n'
    w.files[`${GIT_DIR}/rebase-merge/end`] = '3\n'
    // CHERRY_PICK_HEAD too, as a stopped rebase can have: the rebase wins
    w.files[`${GIT_DIR}/CHERRY_PICK_HEAD`] = `${SHA}\n`
    w.dirs.add(`${GIT_DIR}/rebase-merge`)
    await $.session.start(start)
    await clock.advance(1000)
    expect(line(w)).toContain('branch:feat (rebase 2/3) | ✗1')
    w.dirs.delete(`${GIT_DIR}/rebase-merge`)
    w.dirs.add(`${GIT_DIR}/rebase-apply`)
    w.files[`${GIT_DIR}/rebase-apply/next`] = '1\n'
    w.files[`${GIT_DIR}/rebase-apply/last`] = '4\n'
    w.files[`${GIT_DIR}/rebase-apply/head-name`] = 'refs/heads/feat\n'
    w.files[`${GIT_DIR}/rebase-apply/rebasing`] = ''
    await clock.advance(5000)
    expect(line(w)).toContain('branch:feat (rebase 1/4)')
    delete w.files[`${GIT_DIR}/rebase-apply/rebasing`]
    await clock.advance(5000)
    expect(line(w)).toContain('branch:feat (am 1/4)')
  })

  test('bisect on a detached sha: no ref name, the operation shown', { options: { detachedHead: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    w.status = `# branch.oid ${SHA}\n# branch.head (detached)\n`
    w.files[`${GIT_DIR}/HEAD`] = `${SHA}\n`
    w.files[`${GIT_DIR}/BISECT_LOG`] = 'git bisect start\n'
    w.files[`${GIT_DIR}/logs/HEAD`] = `c4ef ${SHA} t <t@t> 1 +0800\tcheckout: moving from main to v1.0\n`
    w.dirs.add(`${GIT_DIR}/refs/tags/v1.0`)
    await $.session.start(start)
    await clock.advance(1000)
    expect(line(w)).toContain('branch:@18f67cd (bisect)')
  })

  test('a reftable HEAD asks git for the short sha', { options: { detachedHead: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    w.status = '# branch.oid 1\n# branch.head (detached)\n'
    w.files[`${GIT_DIR}/HEAD`] = 'ref: refs/heads/.invalid\n'
    await $.session.start(start)
    await clock.advance(1000)
    expect(line(w)).toContain('branch:@a1b2c3d')
  })

  test('with the detachedHead option off a detached HEAD is not read', async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    w.status = '# branch.oid 1\n# branch.head (detached)\n? a\n'
    w.files[`${GIT_DIR}/HEAD`] = 'ref: refs/heads/.invalid\n'
    await $.session.start(start)
    await clock.advance(1000)
    expect(line(w)).toContain('repo:proj | ?1')
    expect(w.runs.some(r => r.includes('--short'))).toBe(false)
    expect(w.reads.filter(r => r.startsWith(GIT_DIR))).toEqual([])
  })

  test('an attached HEAD in the file while status says detached: no branch shown', { options: { detachedHead: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    w.status = '# branch.oid 1\n# branch.head (detached)\n? a\n'
    w.files[`${GIT_DIR}/HEAD`] = 'ref: refs/heads/main\n'
    await $.session.start(start)
    await clock.advance(1000)
    expect(line(w)).not.toContain('branch:')
    expect(line(w)).toContain('repo:proj | ?1')
  })
})

describe('vcs refresh policy', () => {
  test('first read at start, then every 5 s; nothing between', async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    await $.session.start(start)
    await clock.settle()
    expect(gitStatusRuns(w)).toBe(1)
    await clock.advance(4000)
    expect(gitStatusRuns(w)).toBe(1)
    await clock.advance(1000)
    expect(gitStatusRuns(w)).toBe(2)
  })

  test('the first read is not awaited by session.start', async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    w.statusMs = 60_000
    // resolves although git status is held for a minute of mock time
    await $.session.start(start)
    expect(w.runs.length).toBeGreaterThan(0)
  })

  test('a file-changing tool call asks for a read at once; a Read does not', async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    on('tool.call', async () => ({ result: 'ok' }))
    await $.session.start(start)
    await clock.advance(1000)
    expect(gitStatusRuns(w)).toBe(1)
    w.status = '# branch.oid 1\n# branch.head main\n? new\n? other\n'
    const result = await $.tool.call({ tool: 'Bash', command: 'touch other' })
    expect(result).toEqual({ result: 'ok' })
    await clock.settle()
    expect(gitStatusRuns(w)).toBe(2)
    await $.tool.call({ tool: 'Read', file_path: '/x' })
    await clock.settle()
    expect(gitStatusRuns(w)).toBe(2)
    await clock.advance(1000)
    expect(line(w)).toContain('?2')
  })

  test('the read asked for by a tool call runs after the tool has run', async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    // The tool runs 500 ms of mock time and changes the tree at its end: a
    // read asked for before it ran would see the old tree.
    on('tool.call', async () => {
      await clock.sleep(500)
      w.status = '# branch.oid 1\n# branch.head main\n? new\n? other\n? third\n'
      return { result: 'ok' }
    })
    await $.session.start(start)
    await clock.advance(1000)
    expect(line(w)).toContain('?1')
    const call = $.tool.call({ tool: 'Bash', command: 'touch other third' })
    await clock.advance(500)
    expect(await call).toEqual({ result: 'ok' })
    await clock.settle()
    expect(gitStatusRuns(w)).toBe(2)
    await clock.advance(1000)
    expect(line(w)).toContain('?3')
  })

  for (const tool of ['EnterWorktree', 'ExitWorktree']) {
    test(`${tool} asks for a read at once (it moves the session's folder)`, async ($, on) => {
      const clock = mock.clock(on, { now: 0 })
      const w = world(on, clock)
      on('tool.call', async () => ({ result: 'ok' }))
      await $.session.start(start)
      await clock.advance(1000)
      expect(gitStatusRuns(w)).toBe(1)
      await $.tool.call({ tool, name: 'wt1' } as never)
      await clock.settle()
      expect(gitStatusRuns(w)).toBe(2)
    })
  }

  test('a slow walk holds off the next one for 10x its length, asked for or polled', async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    on('tool.call', async () => ({ result: 'ok' }))
    w.statusMs = 2000
    await $.session.start(start)
    // the walk runs 0 → 2000; the next is due at 2000 + 20000
    await clock.advance(2000)
    expect(gitStatusRuns(w)).toBe(1)
    await $.tool.call({ tool: 'Edit', file_path: '/x', old_string: 'a', new_string: 'b' })
    await clock.advance(15_000)
    expect(gitStatusRuns(w)).toBe(1)
    await clock.advance(5000)
    expect(gitStatusRuns(w)).toBe(2)
  })

  test('one read at a time: an ask during a read waits for a later tick', async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    on('tool.call', async () => ({ result: 'ok' }))
    w.statusMs = 300
    await $.session.start(start)
    await clock.settle()
    await $.tool.call({ tool: 'Write', file_path: '/x', content: 'y' })
    await clock.settle()
    expect(gitStatusRuns(w)).toBe(1)
    // ends at 300; hold 3000 → due at 3300, run on the 4000 tick
    await clock.advance(3000)
    expect(gitStatusRuns(w)).toBe(1)
    await clock.advance(1000)
    expect(gitStatusRuns(w)).toBe(2)
  })

  test('outside an interactive session nothing runs, tool calls included', async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    on('tool.call', async () => ({ result: 'ok' }))
    await $.session.start({ ...start, surface: null, isInteractive: false })
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await clock.advance(10_000)
    expect(w.runs).toEqual([])
  })
})
