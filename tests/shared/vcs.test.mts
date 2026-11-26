import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import childProcess, { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { promisify } from 'node:util'

import { initialSession } from '../../src/core/session.ts'
import { displaySession, shortModelName } from '../../src/render/session.ts'
import {
  deriveRepoAndBranch, initialVcs, parseGitStatus, parseSvnInfoXml, parseSvnStatusXml,
  repoNameFromUrl, type VcsValues,
} from '../../src/core/vcs.ts'
import type { FragmentInput, Theme } from '../../src/core/types.ts'
import { en, type Labels } from '../../src/i18n/en.ts'
import { findSvnRoot, readGit, readSvn, readVcs } from '../../src/node/vcs.ts'
import { DEFAULTS } from '../../src/options.ts'
import { folder } from '../../src/render/fragments/folder.ts'
import { branch, repo, status } from '../../src/render/fragments/vcs.ts'
import { makeTheme } from '../../src/theme/index.ts'
import { withCleanup } from '../fixture-commands.mts'

const exec = promisify(execFile)

test('readGit releases a non-repository working directory before returning on Windows', { skip: process.platform !== 'win32' }, async () => {
  await exec('git', ['--version'], { windowsHide: true })
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'vargus-git-cwd-'))
  const previous = process.env.GIT_CEILING_DIRECTORIES
  process.env.GIT_CEILING_DIRECTORIES = dirname(directory)
  await withCleanup(async () => {
    assert.deepEqual(await readGit(directory), initialVcs())
  }, async () => {
    if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES
    else process.env.GIT_CEILING_DIRECTORIES = previous
    await rmdir(directory).catch(error => { throw new Error(`Retained Git fixture at ${directory}`, { cause: error }) })
  })
})

test('readGit waits for each sibling probe when status fails', async () => {
  const pending = new Map<string, (error: Error) => void>()
  const original = childProcess.execFile
  let controlledRead: typeof readGit
  try {
    childProcess.execFile = ((_file: string, args: string[], _options: unknown, done: (error: Error) => void) => {
      pending.set(args[2]!, done)
    }) as unknown as typeof execFile
    syncBuiltinESMExports()
    const module = await import(new URL('../../src/node/git.ts?controlled-probes', import.meta.url).href)
    controlledRead = module.readGit
  } finally {
    childProcess.execFile = original
    syncBuiltinESMExports()
  }
  for (const last of ['rev-parse', 'remote']) {
    pending.clear()
    let returned = false
    const result = controlledRead('fixture').then(value => { returned = true; return value })
    assert.deepEqual([...pending.keys()].sort(), ['remote', 'rev-parse', 'status'])
    const failure = new Error('not a Git repository')
    pending.get('status')!(failure)
    pending.get(last === 'remote' ? 'rev-parse' : 'remote')!(failure)
    await nextTurn()
    assert.equal(returned, false, `returned before ${last} finished`)
    pending.get(last)!(failure)
    assert.deepEqual(await result, initialVcs())
  }
})

// Git porcelain examples captured from Git 2.47.3 in throwaway repositories.
// ahead 1 behind 1; R. M. A. staged; .M .A (git add -N) modified; two untracked
const GIT_STATUS = `# branch.oid 04fe4a804fa956e726bfc03bbdc0e82f497db21b
# branch.head main
# branch.upstream origin/main
# branch.ab +1 -1
2 R. N... 100644 100644 100644 93829c7b4af9dfbeea3b31395b042a614d7a190d 93829c7b4af9dfbeea3b31395b042a614d7a190d R100 a2\ta
1 .M N... 100644 100644 100644 61780798228d17af2d34fce4cfbdf35556832472 61780798228d17af2d34fce4cfbdf35556832472 b
1 M. N... 100644 100644 100644 f2ad6c76f0115a6ba5b00456a849810e7ec0af20 9f853d356ef053c03e6444c0060d66e1e26d5d97 c
1 .A N... 000000 000000 100644 0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 new2
1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 b4785957bc986dc39c629de9fac9df46972c00fc staged
? d/
? new
`
// a merge stopped on two conflicts
const GIT_CONFLICT = `# branch.oid 248a4bc78b81ee7f236e145d5d1961ef3fbc5e55
# branch.head main
u UU N... 100644 100644 100644 100644 d00491fd7e5bb6fa28c517a0bb32b8b506539d4d ba2906d0666cf726c7eaadd2cd3db615dedfdf3a c7747099cf9e073babc68f52cdfb4d280ba5689f f
u UU N... 100644 100644 100644 100644 01058d844a98d293a3b03a8615a34700e4ed2be3 c4f81769efe62f3a595ee0adc788c49e7df22d4b 830bc9c3a830f021a2408782ddd1e08315c65c3a g
`
// MM: staged and modified; .T: a file replaced by a symlink
const GIT_TYPECHANGE = `# branch.oid c5f742e239d9e7c5f24a294c0032601ccc650b80
# branch.head main
1 MM N... 100644 100644 100644 78981922613b2afb6025042ff6bd878ac1994e85 1db6db040ffa9028e77dbc84c8a40939c13f4f81 a
1 .T N... 100644 100644 120000 61780798228d17af2d34fce4cfbdf35556832472 61780798228d17af2d34fce4cfbdf35556832472 b
`

describe('git status', () => {
  test('porcelain v2: staged, modified (intent-to-add too), untracked, ahead, behind, the branch', () => {
    assert.deepEqual(parseGitStatus(GIT_STATUS), {
      head: 'main',
      counts: { staged: 3, modified: 2, untracked: 2, conflicted: 0, ahead: 1, behind: 1 },
    })
  })

  test('an unmerged path is a conflict, not staged', () => {
    assert.deepEqual(parseGitStatus(GIT_CONFLICT).counts,
      { staged: 0, modified: 0, untracked: 0, conflicted: 2, ahead: 0, behind: 0 })
  })

  test('any work-tree change is modified: a typechange counts; MM is staged and modified', () => {
    assert.deepEqual(parseGitStatus(GIT_TYPECHANGE).counts,
      { staged: 1, modified: 2, untracked: 0, conflicted: 0, ahead: 0, behind: 0 })
  })

  test('a detached HEAD reads as (detached); no upstream leaves ahead/behind at 0', () => {
    assert.equal(parseGitStatus('# branch.oid 18f6\n# branch.head (detached)\n').head, '(detached)')
    assert.equal(parseGitStatus('').counts.ahead, 0)
  })
})

describe('repo name from the remote URL', () => {
  test('https, scp-like, a local path; .git and a trailing slash dropped', () => {
    assert.equal(repoNameFromUrl('https://github.com/zhoufanscut/VArgus.git'), 'VArgus')
    assert.equal(repoNameFromUrl('git@github.com:zhoufanscut/VArgus.git'), 'VArgus')
    assert.equal(repoNameFromUrl('git@host:proj'), 'proj')
    assert.equal(repoNameFromUrl('/srv/git/proj.git/'), 'proj')
    assert.equal(repoNameFromUrl('https://github.com/u/proj/'), 'proj')
  })
})

// Fragments.

function input(vcs: Partial<VcsValues>, l: Labels = en, t?: Theme): FragmentInput {
  return {
    v: {
      core: { cwd: '/w', home: '/h', columns: undefined, isWsl: false },
      session: initialSession(),
      limits: [],
      vcs: { ...initialVcs(), ...vcs },
    },
    display: displaySession(initialSession(), shortModelName),
    o: DEFAULTS,
    l,
    t: t ?? makeTheme('graphite', true),
    now: 0,
  }
}

const counts = (c: Partial<VcsValues['counts'] & object>) =>
  ({ staged: 0, modified: 0, untracked: 0, conflicted: 0, ahead: 0, behind: 0, ...c })

describe('vcs fragments', () => {
  test('repo, branch with worktree suffix, status: VantageHUD shapes', () => {
    const f = input({ kind: 'git', repo: 'VArgus', branch: 'main', worktree: 'wt1', counts: counts({ untracked: 4 }) })
    assert.equal(repo(f), 'repo:VArgus')
    assert.equal(branch(f), 'branch:main(wt:wt1)')
    assert.equal(status(f), '?4')
    assert.equal(branch(input({ kind: 'git', branch: 'main' })), 'branch:main')
  })

  test('status order: conflicts first, then + ! ? ⇡ ⇣; a clean tree shows nothing', () => {
    const all = counts({ staged: 2, modified: 3, untracked: 1, conflicted: 1, ahead: 1, behind: 2 })
    assert.equal(status(input({ kind: 'git', counts: all })), '✗1 +2 !3 ?1 ⇡1 ⇣2')
    assert.equal(status(input({ kind: 'git', counts: counts({}) })), null)
    assert.equal(status(input({ kind: 'git', counts: null })), null)
  })

  test('a detached HEAD shows its name and any operation', () => {
    const at = { kind: 'git' as const, detached: { name: 'v1.0', onBranch: false, operation: null, progress: '' } }
    assert.equal(branch(input(at)), 'branch:@v1.0')
    const sha = { kind: 'git' as const, detached: { name: 'a1b2c3d', onBranch: false, operation: 'gitBisect' as const, progress: '' } }
    assert.equal(branch(input(sha)), 'branch:@a1b2c3d(bisect)')
    const rebase = { kind: 'git' as const, worktree: 'w', detached: { name: 'feat', onBranch: true, operation: 'gitRebase' as const, progress: '2/3' } }
    assert.equal(branch(input(rebase)), 'branch:feat(rebase 2/3)(wt:w)')
  })

  test('SVN shows the branch name alone, ignoring worktree', () => {
    const f = input({ kind: 'svn', repo: 'proj', branch: 'trunk', worktree: 'x', counts: counts({ staged: 1 }) })
    assert.equal(repo(f), 'repo:proj')
    assert.equal(branch(f), 'branch:trunk')
    assert.equal(status(f), '+1')
    const none = input({ kind: null, repo: 'x', branch: 'y', counts: counts({ staged: 1 }) })
    assert.deepEqual([repo(none), branch(none), status(none)], [null, null, null])
  })

  test('outside text is cleaned of control characters', () => {
    const f = input({ kind: 'git', repo: 'r\x1b[31m', branch: 'b\nx', worktree: 'w\x07' })
    assert.equal(repo(f), 'repo:r?[31m')
    assert.equal(branch(f), 'branch:b?x(wt:w?)')
  })

  test('every word and mark comes from the labels', () => {
    const marked = Object.fromEntries(Object.keys(en).map(k => [k, `⟦${k}⟧`])) as Labels
    const all = counts({ staged: 1, modified: 1, untracked: 1, conflicted: 1, ahead: 1, behind: 1 })
    const g = input({ kind: 'git', repo: 'R', branch: 'B', worktree: 'W', counts: all }, marked)
    assert.equal(repo(g), '⟦repo⟧:R')
    assert.equal(branch(g), '⟦branch⟧:B⟦worktree⟧W)')
    assert.equal(status(g), '⟦conflict⟧1 ⟦staged⟧1 ⟦modified⟧1 ⟦untracked⟧1 ⟦ahead⟧1 ⟦behind⟧1')
    const d = input({ kind: 'git', detached: { name: 'N', onBranch: false, operation: 'gitCherryPick', progress: '' } },
      marked)
    assert.equal(branch(d), '⟦branch⟧:⟦detachedAt⟧N(⟦gitCherryPick⟧)')
    assert.equal(branch(input({ kind: 'svn', branch: 'T' }, marked)), '⟦branch⟧:T')
  })

  test('colours: bold text for folder, plain text for repo/branch, detail worktree, alert git ops, del for conflicts', () => {
    const tag: Theme = {
      ...makeTheme('graphite', true),
      paint: (c, s) => `<${String(c)}>${s}</>`,
      bold: s => `<b>${s}</b>`,
    }
    const all = counts({ staged: 1, modified: 1, untracked: 1, conflicted: 1, ahead: 1, behind: 1 })
    const f = input({ kind: 'git', repo: 'R', branch: 'B', worktree: 'W', counts: all }, en, tag)
    assert.equal(folder(f), '<b><text>/w</></b>')
    assert.equal(repo(f), '<label>repo:</><text>R</>')
    assert.equal(branch(f), '<label>branch:</><text>B</><detail>(wt:W)</>')
    assert.equal(status(f), '<del>✗1</> <add>+1</> <del>!1</> <track>?1</> <add>⇡1</> <del>⇣1</>')
    const d = input({ kind: 'git', detached: { name: 'N', onBranch: false, operation: 'gitMerge', progress: '' } },
      en, tag)
    assert.equal(branch(d), '<label>branch:</><label>@</><text>N</><alert>(merge)</>')
    const combined = input({ kind: 'git', worktree: 'w', detached: { name: 'feat', onBranch: true, operation: 'gitRebase', progress: '2/3' } },
      en, tag)
    assert.equal(branch(combined), '<label>branch:</><text>feat</><alert>(rebase 2/3)</><detail>(wt:w)</>')
  })
})

describe('shared svn parsers and Node VCS fallback', () => {
  test('parseSvnInfoXml, deriveRepoAndBranch and parseSvnStatusXml handle standard layouts and properties', () => {
    const info = `<?xml version="1.0" encoding="UTF-8"?><info><entry kind="dir" path="." revision="42">`
      + `<url>https://svn.example.com/repos/p%20q&amp;r/branches/2.1/src</url>`
      + `<relative-url>^/p%20q&amp;r/branches/2.1/src</relative-url>`
      + `<repository><root>https://svn.example.com/repos</root></repository></entry></info>`
    assert.deepEqual(parseSvnInfoXml(info), { project: 'p q&r', branch: '2.1' })
    assert.deepEqual(deriveRepoAndBranch('https://h/svn/proj/trunk/sub', 'https://h/svn', null), { project: 'proj', branch: 'trunk' })
    assert.deepEqual(deriveRepoAndBranch('https://h/r/a/b', 'https://h/r', null), { project: 'r', branch: 'a/b' })
    const statusXml = `<status><target path=".">`
      + `<entry path="a"><wc-status item="added" props="none"></wc-status></entry>`
      + `<entry path="."><wc-status item="normal" props="modified"></wc-status></entry>`
      + `<entry path="c"><wc-status item="normal" props="conflicted"></wc-status></entry>`
      + `<entry path="u"><wc-status item="unversioned" props="none"></wc-status></entry>`
      + `<entry path="r"><wc-status item="normal" props="none"></wc-status><repos-status item="modified" props="none"></repos-status></entry>`
      + `</target></status>`
    assert.deepEqual(parseSvnStatusXml(statusXml), { staged: 1, modified: 1, untracked: 1, conflicted: 1, ahead: 0, behind: 0 })
  })

  test('parseSvnStatusXml maps all SVN <wc-status> buckets across the 4 local marks', () => {
    const statusXml = `<status><target path=".">`
      + `<entry path="add"><wc-status item="added" props="none"></wc-status></entry>`
      + `<entry path="del"><wc-status item="deleted" props="none"></wc-status></entry>`
      + `<entry path="rep"><wc-status item="replaced" props="none"></wc-status></entry>`
      + `<entry path="mod"><wc-status item="modified" props="none"></wc-status></entry>`
      + `<entry path="mod-prop"><wc-status item="modified" props="modified"></wc-status></entry>`
      + `<entry path="prop"><wc-status item="normal" props="modified"></wc-status></entry>`
      + `<entry path="mrg"><wc-status item="merged" props="none"></wc-status></entry>`
      + `<entry path="mis"><wc-status item="missing" props="none"></wc-status></entry>`
      + `<entry path="inc"><wc-status item="incomplete" props="none"></wc-status></entry>`
      + `<entry path="conf"><wc-status item="conflicted" props="none"></wc-status></entry>`
      + `<entry path="obs"><wc-status item="obstructed" props="none"></wc-status></entry>`
      + `<entry path="pconf"><wc-status item="normal" props="conflicted"></wc-status></entry>`
      + `<entry path="tconf"><wc-status item="normal" props="none" tree-conflicted="true"></wc-status></entry>`
      + `<entry path="unv"><wc-status item="unversioned" props="none"></wc-status></entry>`
      + `<entry path="norm"><wc-status item="normal" props="none"></wc-status></entry>`
      + `<entry path="none"><wc-status item="none" props="normal"></wc-status></entry>`
      + `<entry path="ign"><wc-status item="ignored" props="none"></wc-status></entry>`
      + `<entry path="ext"><wc-status item="external" props="none"></wc-status></entry>`
      + `</target></status>`
    const parsed = parseSvnStatusXml(statusXml)
    assert.deepEqual(parsed, { staged: 1, modified: 8, untracked: 1, conflicted: 4, ahead: 0, behind: 0 })
    assert.equal(status(input({ kind: 'svn', counts: parsed })), '✗4 +1 !8 ?1')
  })

  test('findSvnRoot walks up from nested and symlinked folders', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'vargus-svn-root-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const wc = join(dir, 'wc')
    const sub = join(wc, 'a', 'b')
    const plain = join(dir, 'plain')
    await mkdir(join(wc, '.svn'), { recursive: true })
    await mkdir(sub, { recursive: true })
    await mkdir(plain, { recursive: true })
    assert.equal(await findSvnRoot(sub), await findSvnRoot(wc))
    assert.equal(await findSvnRoot(plain), null)
    assert.equal(await findSvnRoot(''), null)
    if (process.platform !== 'win32') {
      const link = join(plain, 'into-wc')
      await symlink(sub, link)
      assert.equal(await findSvnRoot(link), await findSvnRoot(wc))
    }
  })

  test('readVcs falls back to local SVN outside Git, and Git wins when nested', { skip: process.platform === 'win32' }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'vargus-node-svn-'))
    const savedPath = process.env.PATH
    t.after(async () => {
      if (savedPath === undefined) delete process.env.PATH
      else process.env.PATH = savedPath
      await rm(dir, { recursive: true, force: true })
    })
    const bin = join(dir, 'bin')
    const callsFile = join(dir, 'svn-calls.log')
    await mkdir(bin, { recursive: true })
    const shim = join(bin, 'svn')
    await writeFile(shim, [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> "${callsFile}"`,
      'if [ "$2" = "info" ]; then',
      '  printf \'%s\' \'<info><entry kind="dir" path="." revision="9"><url>https://h/r/proj/trunk/sub</url><repository><root>https://h/r</root></repository></entry></info>\'',
      'elif [ "$2" = "status" ]; then',
      '  printf \'%s\' \'<status><target path="."><entry path="a"><wc-status item="modified" props="none"></wc-status></entry><entry path="b"><wc-status item="unversioned" props="none"></wc-status></entry></target></status>\'',
      'else exit 1; fi',
    ].join('\n') + '\n')
    await chmod(shim, 0o755)
    process.env.PATH = `${bin}${delimiter}${savedPath ?? ''}`

    const wc = join(dir, 'wc')
    const sub = join(wc, 'sub')
    const nestedGit = join(wc, 'nested-git')
    const empty = join(dir, 'empty')
    await mkdir(join(wc, '.svn'), { recursive: true })
    await mkdir(sub, { recursive: true })
    await mkdir(nestedGit, { recursive: true })
    await mkdir(empty, { recursive: true })
    await exec('git', ['init', '-q', '-b', 'main', nestedGit])

    // Outside Git or SVN: svn is never called.
    assert.deepEqual(await readVcs(empty), initialVcs())
    await assert.rejects(readFile(callsFile, 'utf8'))

    // Git inside SVN: Git wins and svn is never called.
    const gitVcs = await readVcs(nestedGit)
    assert.equal(gitVcs.kind, 'git')
    assert.equal(gitVcs.branch, 'main')
    await assert.rejects(readFile(callsFile, 'utf8'))

    // SVN working copy outside Git: runs local info + status with --non-interactive.
    const svnVcs = await readVcs(sub)
    assert.deepEqual(svnVcs, {
      kind: 'svn',
      repo: 'proj',
      branch: 'trunk',
      detached: null,
      worktree: null,
      counts: { staged: 0, modified: 1, untracked: 1, conflicted: 0, ahead: 0, behind: 0 },
    })
    const calls = (await readFile(callsFile, 'utf8')).trim().split('\n').sort()
    assert.deepEqual(calls, ['--non-interactive info --xml', '--non-interactive status --xml'])

    // Failing svn commands leave initialVcs cleanly.
    await writeFile(shim, '#!/bin/sh\nexit 1\n')
    assert.deepEqual(await readSvn(sub), initialVcs())

    // Stdout maxBuffer overflow (>4 MiB) recovers partial status counts;
    // stderr maxBuffer overflow is rejected instead of misreported as clean counts.
    const nodeExec = JSON.stringify(process.execPath)
    await writeFile(shim, [
      '#!/bin/sh',
      'if [ "$2" = "info" ]; then',
      '  printf \'%s\' \'<info><entry kind="dir" path="."><url>https://h/r/proj/trunk</url><repository><root>https://h/r</root></repository></entry></info>\'',
      'elif [ "$2" = "status" ]; then',
      `  exec ${nodeExec} -e 'process.stdout.write("<status><target path=\\".\\"><entry path=\\"a\\"><wc-status item=\\"modified\\" props=\\"none\\"></wc-status></entry>"); const pad = "x".repeat(65536); for (let i = 0; i < 80; i++) process.stdout.write(pad);'`,
      'else exit 1; fi',
    ].join('\n') + '\n')
    const stdoutOverflow = await readSvn(sub, 10_000)
    assert.equal(stdoutOverflow.kind, 'svn')
    assert.equal(stdoutOverflow.repo, 'proj')
    assert.equal(stdoutOverflow.counts?.modified, 1)

    await writeFile(shim, [
      '#!/bin/sh',
      'if [ "$2" = "info" ]; then exit 1',
      'elif [ "$2" = "status" ]; then',
      `  exec ${nodeExec} -e 'const pad = "e".repeat(65536); for (let i = 0; i < 80; i++) process.stderr.write(pad);'`,
      'else exit 1; fi',
    ].join('\n') + '\n')
    assert.deepEqual(await readSvn(sub, 10_000), initialVcs())

    await writeFile(shim, [
      '#!/bin/sh',
      'if [ "$2" = "info" ]; then',
      '  printf \'%s\' \'<info><entry kind="dir" path="."><url>https://h/r/proj/trunk</url><repository><root>https://h/r</root></repository></entry></info>\'',
      'elif [ "$2" = "status" ]; then',
      `  exec ${nodeExec} -e 'process.stdout.write("<status><target path=\\".\\"><entry path=\\"a\\"><wc-status item=\\"modified\\" props=\\"none\\"></wc-status></entry>"); const pad = "e".repeat(65536); for (let i = 0; i < 80; i++) process.stderr.write(pad);'`,
      'else exit 1; fi',
    ].join('\n') + '\n')
    const stderrWithInfo = await readSvn(sub, 10_000)
    assert.equal(stderrWithInfo.kind, 'svn')
    assert.equal(stderrWithInfo.repo, 'proj')
    assert.equal(stderrWithInfo.counts, null)

    // Non-positive or exhausted timeout budget skips both Git and SVN.
    const budgetLog = join(dir, 'budget-svn.log')
    await writeFile(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${budgetLog}"\nexit 0\n`)
    assert.deepEqual(await readVcs(nestedGit, 0), initialVcs())
    assert.deepEqual(await readVcs(nestedGit, -1), initialVcs())
    assert.deepEqual(await readVcs(sub, 0), initialVcs())
    await assert.rejects(readFile(budgetLog, 'utf8'))

    const gitShim = join(bin, 'git')
    await writeFile(gitShim, '#!/bin/sh\nexec sleep 0.15\n')
    await chmod(gitShim, 0o755)
    assert.deepEqual(await readVcs(sub, 50), initialVcs())
    await assert.rejects(readFile(budgetLog, 'utf8'))
  })
})
