import { describe, expect, test } from 'claude-code/testing'

import { initialLimits } from '../src/collect/limits'
import { initialSession } from '../src/collect/session'
import {
  deriveRepoAndBranch, initialVcs, parseGitStatus, parseSvnInfoXml, parseSvnStatusXml, repoNameFromUrl,
  type VcsValues,
} from '../src/collect/vcs'
import type { FragmentInput, Theme } from '../src/core/types'
import { en, type Labels } from '../src/i18n/en'
import { DEFAULTS, type Options } from '../src/options'
import { branch, repo, status } from '../src/render/fragments/vcs'
import { makeTheme } from '../src/theme'

// The vcs parsers and fragments (DESIGN, "Rules carried over from VantageHUD",
// git and svn; "Fragments" 9-11; "Languages"). git output captured from git
// 2.47.3 in throwaway repos; svn has no binary on the dev machine, so its XML
// is written to svn 1.14's documented shape (info.rnc, status.rnc).

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

const svnEntry = (path: string, attrs: string): string =>
  `<entry\n   path="${path}">\n<wc-status\n   ${attrs}>\n</wc-status>\n</entry>\n`
const SVN_STATUS = `<?xml version="1.0" encoding="UTF-8"?>
<status>
<target
   path=".">
${svnEntry('added.c', 'item="added"\n   props="none"')}${svnEntry('del.c', 'item="deleted"\n   props="none"')}${
  svnEntry('mod.c', 'item="modified"\n   revision="12"\n   props="none"')}${
  svnEntry('gone.c', 'item="missing"\n   props="none"')}${
  svnEntry('.', 'item="normal"\n   revision="12"\n   props="modified"')}${
  svnEntry('pc.c', 'item="normal"\n   revision="12"\n   props="conflicted"')}${
  svnEntry('tc.c', 'item="normal"\n   revision="12"\n   props="none"\n   tree-conflicted="true"')}${
  svnEntry('both.c', 'item="modified"\n   revision="12"\n   props="modified"')}${
  svnEntry('new.c', 'item="unversioned"\n   props="none"')}${
  svnEntry('ign.o', 'item="ignored"\n   props="none"')}</target>
</status>
`
const SVN_INFO = `<?xml version="1.0" encoding="UTF-8"?>
<info>
<entry
   kind="dir"
   path="."
   revision="12345">
<url>https://svn.example.com/repos/proj/branches/2.1/src</url>
<relative-url>^/proj/branches/2.1/src</relative-url>
<repository>
<root>https://svn.example.com/repos</root>
<uuid>13f79535-47bb-0310-9956-ffa450edef68</uuid>
</repository>
<commit
   revision="12000">
<author>u</author>
<date>2024-01-01T00:00:00.000000Z</date>
</commit>
</entry>
</info>
`

describe('git status', () => {
  test('porcelain v2: staged, modified (intent-to-add too), untracked, ahead, behind, the branch', async () => {
    expect(parseGitStatus(GIT_STATUS)).toEqual({
      head: 'main',
      counts: { staged: 3, modified: 2, untracked: 2, conflicted: 0, ahead: 1, behind: 1 },
    })
  })

  test('an unmerged path is a conflict, not staged', async () => {
    expect(parseGitStatus(GIT_CONFLICT).counts).toEqual(
      { staged: 0, modified: 0, untracked: 0, conflicted: 2, ahead: 0, behind: 0 })
  })

  test('any work-tree change is modified: a typechange counts; MM is staged and modified', async () => {
    expect(parseGitStatus(GIT_TYPECHANGE).counts).toEqual(
      { staged: 1, modified: 2, untracked: 0, conflicted: 0, ahead: 0, behind: 0 })
  })

  test('a detached HEAD reads as (detached); no upstream leaves ahead/behind at 0', async () => {
    expect(parseGitStatus('# branch.oid 18f6\n# branch.head (detached)\n').head).toBe('(detached)')
    expect(parseGitStatus('').counts.ahead).toBe(0)
  })
})

describe('repo name from the remote URL', () => {
  test('https, scp-like, a local path; .git and a trailing slash dropped', async () => {
    expect(repoNameFromUrl('https://github.com/zhoufanscut/VArgus.git')).toBe('VArgus')
    expect(repoNameFromUrl('git@github.com:zhoufanscut/VArgus.git')).toBe('VArgus')
    expect(repoNameFromUrl('git@host:proj')).toBe('proj')
    expect(repoNameFromUrl('/srv/git/proj.git/')).toBe('proj')
    expect(repoNameFromUrl('https://github.com/u/proj/')).toBe('proj')
  })
})

describe('svn', () => {
  test('both columns count, a path once: the AGENTS.md mapping', async () => {
    // added, deleted → staged; modified, missing, props-only, both → modified;
    // props conflicted, tree-conflicted → conflicted; ignored → nothing
    expect(parseSvnStatusXml(SVN_STATUS)).toEqual(
      { staged: 2, modified: 4, untracked: 1, conflicted: 2, ahead: 0, behind: 0 })
  })

  test('only <wc-status> counts, never the server view of -u', async () => {
    const xml = `<entry path="a"><wc-status item="normal" props="none"></wc-status>`
      + `<repos-status item="modified" props="none"></repos-status></entry>`
    expect(parseSvnStatusXml(xml).modified).toBe(0)
  })

  test('a cut-off output counts the entries read whole', async () => {
    const cut = SVN_STATUS.slice(0, SVN_STATUS.indexOf('path="gone.c"'))
    expect(parseSvnStatusXml(cut)).toEqual({ staged: 2, modified: 1, untracked: 0, conflicted: 0, ahead: 0, behind: 0 })
  })

  test('info: project and branch from the URL, the working copy revision from <entry>', async () => {
    expect(parseSvnInfoXml(SVN_INFO)).toEqual({ project: 'proj', branch: '2.1', revision: '12345' })
  })

  test('trunk / branches / tags convention; root name for a repo per project; a flat layout', async () => {
    expect(deriveRepoAndBranch('https://h/svn/proj/trunk/src', 'https://h/svn', null))
      .toEqual({ project: 'proj', branch: 'trunk' })
    expect(deriveRepoAndBranch('https://h/proj/tags/v1', 'https://h/proj', '^/tags/v1'))
      .toEqual({ project: 'proj', branch: 'v1' })
    expect(deriveRepoAndBranch('https://h/r/proj/branches', 'https://h/r', null))
      .toEqual({ project: 'proj', branch: 'branches' })
    expect(deriveRepoAndBranch('https://h/r/a/b', 'https://h/r', null)).toEqual({ project: 'r', branch: 'a/b' })
    expect(deriveRepoAndBranch('https://h/r/x/trunk', '', null)).toEqual({ project: 'x', branch: 'trunk' })
  })

  test('URL text is decoded: entities and percent-encoding', async () => {
    const xml = SVN_INFO.replace('proj/branches/2.1', 'p%20q&amp;r/branches/2.1').replace('^/proj', '^/p%20q&amp;r')
    expect(parseSvnInfoXml(xml).project).toBe('p q&r')
  })
})

// Fragments.

function input(vcs: Partial<VcsValues>, o: Partial<Options> = {}, l: Labels = en, t?: Theme): FragmentInput {
  return {
    v: {
      core: { cwd: '/w', home: '/h', columns: undefined, isWsl: false },
      session: initialSession(),
      limits: initialLimits(),
      vcs: { ...initialVcs(), ...vcs },
    },
    o: { ...DEFAULTS, ...o },
    l,
    t: t ?? makeTheme('graphite', true),
    now: 0,
  }
}

const counts = (c: Partial<VcsValues['counts'] & object>) =>
  ({ staged: 0, modified: 0, untracked: 0, conflicted: 0, ahead: 0, behind: 0, ...c })

describe('vcs fragments', () => {
  test('repo, branch with worktree suffix, status: VantageHUD shapes', async () => {
    const f = input({ kind: 'git', repo: 'VArgus', branch: 'main', worktree: 'wt1', counts: counts({ untracked: 4 }) })
    expect(repo(f)).toBe('repo:VArgus')
    expect(branch(f)).toBe('branch:main (wt:wt1)')
    expect(status(f)).toBe('?4')
    expect(branch(input({ kind: 'git', branch: 'main' }))).toBe('branch:main')
  })

  test('status order: conflicts first, then + ! ? ⇡ ⇣; a clean tree shows nothing', async () => {
    const all = counts({ staged: 2, modified: 3, untracked: 1, conflicted: 1, ahead: 1, behind: 2 })
    expect(status(input({ kind: 'git', counts: all }))).toBe('✗1 +2 !3 ?1 ⇡1 ⇣2')
    expect(status(input({ kind: 'git', counts: counts({}) }))).toBe(null)
    expect(status(input({ kind: 'git', counts: null }))).toBe(null)
  })

  test('a detached HEAD is named only with the detachedHead option', async () => {
    const at = { kind: 'git' as const, detached: { name: 'v1.0', onBranch: false, operation: null, progress: '' } }
    expect(branch(input(at))).toBe(null)
    expect(branch(input(at, { detachedHead: true }))).toBe('branch:@v1.0')
    const sha = { kind: 'git' as const, detached: { name: 'a1b2c3d', onBranch: false, operation: 'gitBisect' as const, progress: '' } }
    expect(branch(input(sha, { detachedHead: true }))).toBe('branch:@a1b2c3d (bisect)')
    const rebase = { kind: 'git' as const, worktree: 'w', detached: { name: 'feat', onBranch: true, operation: 'gitRebase' as const, progress: '2/3' } }
    expect(branch(input(rebase, { detachedHead: true }))).toBe('branch:feat (rebase 2/3) (wt:w)')
  })

  test('svn: branch with the revision after @, no worktree; nothing outside a repo', async () => {
    const f = input({ kind: 'svn', repo: 'proj', branch: 'trunk', revision: '12345', worktree: 'x', counts: counts({ staged: 1 }) })
    expect(repo(f)).toBe('repo:proj')
    expect(branch(f)).toBe('branch:trunk@12345')
    expect(status(f)).toBe('+1')
    const none = input({ kind: null, repo: 'x', branch: 'y', counts: counts({ staged: 1 }) })
    expect([repo(none), branch(none), status(none)]).toEqual([null, null, null])
  })

  test('outside text is cleaned of control characters', async () => {
    const f = input({ kind: 'git', repo: 'r\x1b[31m', branch: 'b\nx', worktree: 'w\x07' })
    expect(repo(f)).toBe('repo:r?[31m')
    expect(branch(f)).toBe('branch:b?x (wt:w?)')
  })

  test('every word and mark comes from the labels', async () => {
    const marked = Object.fromEntries(Object.keys(en).map(k => [k, `⟦${k}⟧`])) as Labels
    const all = counts({ staged: 1, modified: 1, untracked: 1, conflicted: 1, ahead: 1, behind: 1 })
    const g = input({ kind: 'git', repo: 'R', branch: 'B', worktree: 'W', counts: all }, {}, marked)
    expect(repo(g)).toBe('⟦repo⟧:R')
    expect(branch(g)).toBe('⟦branch⟧:B ⟦worktree⟧W)')
    expect(status(g)).toBe('⟦conflict⟧1 ⟦staged⟧1 ⟦modified⟧1 ⟦untracked⟧1 ⟦ahead⟧1 ⟦behind⟧1')
    const d = input({ kind: 'git', detached: { name: 'N', onBranch: false, operation: 'gitCherryPick', progress: '' } },
      { detachedHead: true }, marked)
    expect(branch(d)).toBe('⟦branch⟧:⟦detachedAt⟧N (⟦gitCherryPick⟧)')
    expect(branch(input({ kind: 'svn', branch: 'T', revision: '9' }, {}, marked))).toBe('⟦branch⟧:T⟦detachedAt⟧9')
  })

  test('colours as VantageHUD git.js', async () => {
    const tag: Theme = { ...makeTheme('graphite', true), paint: (c, s) => `<${String(c)}>${s}</>` }
    const all = counts({ staged: 1, modified: 1, untracked: 1, conflicted: 1, ahead: 1, behind: 1 })
    const f = input({ kind: 'git', repo: 'R', branch: 'B', worktree: 'W', counts: all }, {}, en, tag)
    expect(repo(f)).toBe('<label>repo:</><gradLow>R</>')
    expect(branch(f)).toBe('<label>branch:</><gradLow>B</> <label>(wt:</><gradLow>W</><label>)</>')
    expect(status(f)).toBe('<gradHigh>✗1</> <add>+1</> <del>!1</> <track>?1</> <add>⇡1</> <del>⇣1</>')
    const d = input({ kind: 'git', detached: { name: 'N', onBranch: false, operation: 'gitMerge', progress: '' } },
      { detachedHead: true }, en, tag)
    expect(branch(d)).toBe('<label>branch:</><label>@</><gradLow>N</> <gradMid>(merge)</>')
  })
})
