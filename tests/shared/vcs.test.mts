import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { initialSession } from '../../src/core/session.ts'
import { displaySession, shortModelName } from '../../src/render/session.ts'
import { initialVcs, parseGitStatus, repoNameFromUrl, type VcsValues } from '../../src/core/vcs.ts'
import type { FragmentInput, Theme } from '../../src/core/types.ts'
import { en, type Labels } from '../../src/i18n/en.ts'
import { DEFAULTS } from '../../src/options.ts'
import { branch, repo, status } from '../../src/render/fragments/vcs.ts'
import { makeTheme } from '../../src/theme/index.ts'

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
    assert.equal(branch(f), 'branch:main (wt:wt1)')
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
    assert.equal(branch(input(sha)), 'branch:@a1b2c3d (bisect)')
    const rebase = { kind: 'git' as const, worktree: 'w', detached: { name: 'feat', onBranch: true, operation: 'gitRebase' as const, progress: '2/3' } }
    assert.equal(branch(input(rebase)), 'branch:feat (rebase 2/3) (wt:w)')
  })

  test('SVN shows the branch name alone, even with a revision and worktree present', () => {
    const f = input({ kind: 'svn', repo: 'proj', branch: 'trunk', revision: '12345', worktree: 'x', counts: counts({ staged: 1 }) })
    assert.equal(repo(f), 'repo:proj')
    assert.equal(branch(f), 'branch:trunk')
    assert.equal(status(f), '+1')
    const none = input({ kind: null, repo: 'x', branch: 'y', counts: counts({ staged: 1 }) })
    assert.deepEqual([repo(none), branch(none), status(none)], [null, null, null])
  })

  test('outside text is cleaned of control characters', () => {
    const f = input({ kind: 'git', repo: 'r\x1b[31m', branch: 'b\nx', worktree: 'w\x07' })
    assert.equal(repo(f), 'repo:r?[31m')
    assert.equal(branch(f), 'branch:b?x (wt:w?)')
  })

  test('every word and mark comes from the labels', () => {
    const marked = Object.fromEntries(Object.keys(en).map(k => [k, `⟦${k}⟧`])) as Labels
    const all = counts({ staged: 1, modified: 1, untracked: 1, conflicted: 1, ahead: 1, behind: 1 })
    const g = input({ kind: 'git', repo: 'R', branch: 'B', worktree: 'W', counts: all }, marked)
    assert.equal(repo(g), '⟦repo⟧:R')
    assert.equal(branch(g), '⟦branch⟧:B ⟦worktree⟧W)')
    assert.equal(status(g), '⟦conflict⟧1 ⟦staged⟧1 ⟦modified⟧1 ⟦untracked⟧1 ⟦ahead⟧1 ⟦behind⟧1')
    const d = input({ kind: 'git', detached: { name: 'N', onBranch: false, operation: 'gitCherryPick', progress: '' } },
      marked)
    assert.equal(branch(d), '⟦branch⟧:⟦detachedAt⟧N (⟦gitCherryPick⟧)')
    assert.equal(branch(input({ kind: 'svn', branch: 'T', revision: '9' }, marked)), '⟦branch⟧:T')
  })

  test('colours: bold text for repo/branch, faint worktree, alert git ops, del for conflicts', () => {
    const tag: Theme = {
      ...makeTheme('graphite', true),
      paint: (c, s) => `<${String(c)}>${s}</>`,
      bold: s => `<b>${s}</b>`,
    }
    const all = counts({ staged: 1, modified: 1, untracked: 1, conflicted: 1, ahead: 1, behind: 1 })
    const f = input({ kind: 'git', repo: 'R', branch: 'B', worktree: 'W', counts: all }, en, tag)
    assert.equal(repo(f), '<label>repo:</><b><text>R</></b>')
    assert.equal(branch(f), '<label>branch:</><b><text>B</></b> <faint>(wt:W)</>')
    assert.equal(status(f), '<del>✗1</> <add>+1</> <del>!1</> <track>?1</> <add>⇡1</> <del>⇣1</>')
    const d = input({ kind: 'git', detached: { name: 'N', onBranch: false, operation: 'gitMerge', progress: '' } },
      en, tag)
    assert.equal(branch(d), '<label>branch:</><label>@</><b><text>N</></b> <alert>(merge)</>')
  })
})
