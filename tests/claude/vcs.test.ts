import { describe, expect, test } from 'claude-code/testing'

import { deriveRepoAndBranch, parseSvnInfoXml, parseSvnStatusXml } from '../../src/hosts/claude/collect/vcs'

// SVN XML fixtures follow the svn 1.14 info.rnc and status.rnc formats.
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
