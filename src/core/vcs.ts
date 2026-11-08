// Shared VCS readings and pure porcelain parsers. Hosts own command execution.


export type Operation = 'gitRebase' | 'gitAm' | 'gitMerge' | 'gitCherryPick' | 'gitRevert' | 'gitBisect'


// A detached HEAD as VantageHUD's getDetachedHead named it: the branch under a
// rebase (`onBranch`), else the tag or ref it was checked out at, else 7 sha
// digits; the operation in progress and its `<step>/<total>`, '' when none.
export type DetachedHead = { name: string; onBranch: boolean; operation: Operation | null; progress: string }


export type VcsCounts = {
  staged: number
  modified: number
  untracked: number
  conflicted: number
  ahead: number
  behind: number
}


// A changed path for the detail view: its kinds (staged and modified can go
// together) and the path as git or svn prints it, relative to the repository
// root (git) or the working folder (svn).
export type VcsFileKind = 'conflicted' | 'staged' | 'modified' | 'untracked'

export type VcsFile = { kinds: VcsFileKind[]; path: string }


// The detail view lists this many changed paths; the counts give the rest.
export const MAX_FILES = 8


export type VcsValues = {
  // Chosen once per refresh, and every field below assigned together, so the
  // three fragments never mix git and svn (VantageHUD's render.js rule).
  kind: 'git' | 'svn' | null
  repo: string | null
  // git: the attached branch (an unborn one too); svn: the branch from the URL
  branch: string | null
  // git only, when HEAD is detached
  detached: DetachedHead | null
  // git: the linked worktree's name; null in the main working tree
  worktree: string | null
  // svn: the working copy's revision
  revision: string | null
  // null until read, or when the read failed
  counts: VcsCounts | null
  // the first MAX_FILES changed paths in git's or svn's order and how many
  // there are, for the detail view; read beside the counts, never changing them
  files: VcsFile[]
  fileCount: number
}


export function initialVcs(): VcsValues {
  return {
    kind: null, repo: null, branch: null, detached: null, worktree: null, revision: null, counts: null, files: [],
    fileCount: 0,
  }
}


// The repo name from a remote URL (VantageHUD getGitRepoName):
// `https://host/u/proj.git`, `git@host:u/proj.git`, `/srv/proj.git` → `proj`.
// A trailing slash is valid for git and would defeat both patterns, so it goes.
export function repoNameFromUrl(url: string): string | null {
  const trimmed = url.trim().replace(/\/+$/, '')
  const match = /\/([^/]+?)(?:\.git)?$/.exec(trimmed) ?? /:([^/]+?)(?:\.git)?$/.exec(trimmed)
  return match?.[1] ? match[1].replace(/\.git$/, '') : null
}


// `git status --porcelain=v2 --branch` (git 2.11+): the branch from
// `# branch.head` (an unborn branch is named too; `(detached)` when detached),
// ahead/behind from `# branch.ab`, and per entry the XY pair, `.` for
// unchanged. VantageHUD's counting rules (git.js parseGitStatus):
// - an unmerged path is a conflict, not staged: v2 gives all seven unmerged
//   pairs (DD AU UD UA DU AA UU) their own `u` line;
// - any work-tree change counts as modified, not only M and D: a typechange
//   (`.T`) and an intent-to-add (`.A`, `git add -N`) included;
// - ignored entries (`!`) need --ignored, which is never passed.
export function parseGitStatus(output: string): { head: string | null; counts: VcsCounts } {
  const counts: VcsCounts = { staged: 0, modified: 0, untracked: 0, conflicted: 0, ahead: 0, behind: 0 }
  let head: string | null = null
  for (const line of output.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      head = line.slice('# branch.head '.length)
    } else if (line.startsWith('# branch.ab ')) {
      const ab = /^# branch\.ab \+(\d+) -(\d+)/.exec(line)
      if (ab) {
        counts.ahead = Number(ab[1])
        counts.behind = Number(ab[2])
      }
    } else if (line.startsWith('? ')) {
      counts.untracked += 1
    } else if (line.startsWith('u ')) {
      counts.conflicted += 1
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      if (line[2] !== '.') counts.staged += 1
      if (line[3] !== '.') counts.modified += 1
    }
  }
  return { head, counts }
}


// The first MAX_FILES changed paths of the same output, with parseGitStatus's
// kinds. The path is the line's last field (`1`: after 8 fields, `2`: after 9,
// the new path before the tab, `u`: after 10, `?`: after 1), as git prints it:
// a path with unusual characters stays in git's C-style quotes.
export function parseGitFiles(output: string): { files: VcsFile[]; fileCount: number } {
  const files: VcsFile[] = []
  let fileCount = 0
  for (const line of output.split('\n')) {
    const kind = line[0]
    if (line[1] !== ' ') continue
    const fields = kind === '1' ? 8 : kind === '2' ? 9 : kind === 'u' ? 10 : kind === '?' ? 1 : 0
    if (fields === 0) continue
    const path = line.split(' ').slice(fields).join(' ').split('\t')[0]!
    if (path === '') continue
    fileCount += 1
    if (files.length >= MAX_FILES) continue
    const kinds: VcsFileKind[] = []
    if (kind === '?') kinds.push('untracked')
    else if (kind === 'u') kinds.push('conflicted')
    else {
      if (line[2] !== '.') kinds.push('staged')
      if (line[3] !== '.') kinds.push('modified')
    }
    files.push({ kinds, path })
  }
  return { files, fileCount }
}
