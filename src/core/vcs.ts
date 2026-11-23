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
  // null until read, or when the read failed
  counts: VcsCounts | null
}


export function initialVcs(): VcsValues {
  return {
    kind: null, repo: null, branch: null, detached: null, worktree: null, counts: null,
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


// ---------------------------------------------------------------------------
// svn: pure XML and URL parsers shared across hosts (`svn info|status --xml`).

const XML_ENTITIES = new Map([['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"], ['amp', '&']])

// An element's text from `svn info --xml`, a URL, as it reads: the five
// predefined entities in one pass (so the `&` an `&amp;` gives is never read
// again: `&amp;lt;` is `&lt;`), then the percent-encoding. A text that is not
// UTF-8 percent-encoding keeps its `%`s. The result can hold control
// characters (`%1B`): the fragments clean it.
function urlText(raw: string): string {
  const text = raw.replace(/&(lt|gt|quot|apos|amp);/g, (_, name: string) => XML_ENTITIES.get(name)!)
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

const SVN_LAYOUT = new Set(['trunk', 'branches', 'tags'])

// The working copy's path below the repository root, as folder names:
// `<relative-url>` when svn gives it (`^/proj/trunk`), else the URL past the
// root, else (no root either) the URL's own path past the host.
function pathInRepo(url: string, root: string | null, relativeUrl: string | null): string[] {
  let path: string
  if (relativeUrl) path = relativeUrl.replace(/^\^(?=\/)/, '')
  else if (root && url.startsWith(root)) path = url.slice(root.length)
  else path = url.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*/, '')
  return path.split('/').filter(Boolean)
}

// The project and branch from the URL below the repository root, by svn's
// trunk / branches/<name> / tags/<name> convention (VantageHUD svn.js
// deriveRepoAndBranch): the segment before the first of those names the
// project (else the root's own name), `trunk` names itself, `branches` and
// `tags` name what follows them. With none of the three, the whole relative
// path is the branch: the only "where am I" such a layout has.
export function deriveRepoAndBranch(
  url: string, root: string | null, relativeUrl: string | null,
): { project: string | null; branch: string | null } {
  const parts = pathInRepo(url, root, relativeUrl)
  const rootName = root?.split('/').filter(Boolean).pop() ?? null
  const at = parts.findIndex(part => SVN_LAYOUT.has(part))
  if (at < 0) return { project: rootName, branch: parts.join('/') || null }
  const project = parts[at - 1] ?? rootName
  // a checkout of `branches` or `tags` itself names that folder
  const branch = parts[at] === 'trunk' ? 'trunk' : (parts[at + 1] ?? parts[at]!)
  return { project, branch }
}

// `svn info --xml`: url, root, and relative-url (svn 1.8+).
export function parseSvnInfoXml(xml: string): { project: string | null; branch: string | null } {
  const tag = (name: string): string | null => {
    const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)
    return m ? urlText(m[1]!) : null
  }
  const url = tag('url')
  if (!url) return { project: null, branch: null }
  return deriveRepoAndBranch(url, tag('root'), tag('relative-url'))
}

type SvnBucket = 'conflicted' | 'staged' | 'modified' | 'untracked'

// The `item` values that place an entry, whatever its props say.
const SVN_ITEM_BUCKET = new Map<string, SvnBucket>([
  ['conflicted', 'conflicted'], ['obstructed', 'conflicted'],
  ['added', 'staged'], ['deleted', 'staged'], ['replaced', 'staged'],
  ['modified', 'modified'], ['merged', 'modified'], ['missing', 'modified'], ['incomplete', 'modified'],
  ['unversioned', 'untracked'],
])

// One <wc-status>'s bucket, or null for a clean entry (normal, ignored,
// external, none, with clean props).
function svnBucket(attrs: string): SvnBucket | null {
  const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1]
  if (attr('tree-conflicted') === 'true' || attr('props') === 'conflicted') return 'conflicted'
  return SVN_ITEM_BUCKET.get(attr('item') ?? '') ?? (attr('props') === 'modified' ? 'modified' : null)
}

// `svn status --xml` into git's shape (VantageHUD AGENTS.md mapping; svn has
// no index, so "staged" is "scheduled for commit"). Both the `item` and the
// `props` column count: a property conflict is item normal, props conflicted,
// and a property-only edit (every merge root's svn:mergeinfo) item normal,
// props modified.
// - conflicted: item conflicted or obstructed, props conflicted, or any
//   tree-conflicted="true"
// - staged: added, deleted, replaced
// - modified: modified, merged, missing, incomplete; then props modified,
//   checked last so a path is counted once
// - untracked: unversioned
// Only <wc-status> counts; <repos-status> (from `-u`, never passed) is the
// server's view.
export function parseSvnStatusXml(xml: string): VcsCounts {
  const counts: VcsCounts = { staged: 0, modified: 0, untracked: 0, conflicted: 0, ahead: 0, behind: 0 }
  for (const [, attrs] of xml.matchAll(/<wc-status\b([^>]*)>/g)) {
    const bucket = svnBucket(attrs!)
    if (bucket) counts[bucket] += 1
  }
  return counts
}
