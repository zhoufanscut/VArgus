import type { EngineInterface, SessionStartInput, ToolCallInput } from 'claude-code'

// The vcs area's collector: git or svn, the repo name, the branch and the
// working-tree counts behind fragments 9-11 (DESIGN, "Fragments"; "Rules
// carried over from VantageHUD", git and svn). Reads run off the render path,
// on the policy under "When to refresh" below; the 1 s tick only renders.

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
  // svn: the working copy's revision
  revision: string | null
  // null until read, or when the read failed
  counts: VcsCounts | null
}

export function initialVcs(): VcsValues {
  return { kind: null, repo: null, branch: null, detached: null, worktree: null, revision: null, counts: null }
}

// ---------------------------------------------------------------------------
// When to refresh.
//
// Measured 2026-10-15 on the dev machine (4 cores, git 2.47.3), median of 10
// runs of `git status --porcelain=v2 --branch` with the flags below: 2.7 ms
// in VArgus (17 files), 75.9 ms in a 9,227-file checkout. So:
// - session.start starts the first refresh, not awaited (the engine awaits
//   the first session.start before the first prompt);
// - after a tool call that can change files or the working folder returns,
//   one refresh is asked for, so Claude's own edits show on the next tick;
// - every POLL_MS otherwise, for edits and git commands made outside Claude:
//   at 76 ms a walk that is 1.5 % of one core;
// - VantageHUD's slow-walk rule (status-memo.js): a walk that took d ms holds
//   off the next one, asked for or polled, until 10 x d after it ended, so a
//   slow tree spends at most about a tenth of the time walking;
// - one refresh at a time; an ask that comes during one is run on a later
//   tick (TICK_MS), never in parallel.
export const POLL_MS = 5000
export const TICK_MS = 1000
const HOLD_FACTOR = 10
// The built-in tools that write files or move the session to another folder
// (claude-code-tools types). Other tools are caught by the poll.
const CHANGES_FILES = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit', 'EnterWorktree', 'ExitWorktree'])

type Pump = {
  started: boolean
  running: boolean
  asked: boolean
  // when the last refresh ended, and how long it took, in $.clock ms
  lastEnd: number
  lastMs: number
  timer: { cancel: () => void } | null
  // the detachedHead option: name a detached HEAD only when it is on
  detachedHead: boolean
}

// One per loaded copy of the module; a hot reload starts it over, and runs
// session.start (so startVcs) again.
const p: Pump = {
  started: false, running: false, asked: false, lastEnd: -Infinity, lastMs: 0, timer: null, detachedHead: false,
}

// The validator refuses a second hook on one event without a matcher, so
// register.ts holds the hooks and calls these.

// From session.start: interactive sessions only (DESIGN, "When the line is
// written"). Starts the first read and does not wait for it.
export function startVcs($: EngineInterface, values: VcsValues, e: SessionStartInput, detachedHead: boolean): void {
  if (!e.isInteractive) return
  p.started = true
  p.detachedHead = detachedHead
  p.asked = true
  p.timer?.cancel()
  p.timer = $.clock.every(TICK_MS, () => {
    pump($, values, p).catch(() => {})
  })
  pump($, values, p).catch(() => {})
}

// From tool.call, after `next(e)` resolved (the tool has run). Not awaited
// work: returns at once.
export function toolCalledVcs($: EngineInterface, values: VcsValues, e: ToolCallInput): void {
  if (!p.started || !CHANGES_FILES.has(e.tool)) return
  p.asked = true
  pump($, values, p).catch(() => {})
}

async function pump($: EngineInterface, values: VcsValues, p: Pump): Promise<void> {
  if (p.running) return
  p.running = true
  try {
    const start = await $.clock.now()
    const hold = HOLD_FACTOR * p.lastMs
    const due = p.asked ? start >= p.lastEnd + hold : start >= p.lastEnd + Math.max(POLL_MS, hold)
    if (!due) return
    p.asked = false
    try {
      Object.assign(values, await readVcs($, p.detachedHead))
    } catch {
      // A command that can't start or outlives $.process.run's 30 s: keep
      // what was shown, as VantageHUD kept its last good counts. A command
      // that exits non-zero is an answer, and blanks what it was asked for.
    }
    p.lastEnd = await $.clock.now()
    p.lastMs = p.lastEnd - start
  } finally {
    p.running = false
  }
}

// ---------------------------------------------------------------------------
// The choice: git when the engine says the folder is in a repository, svn only
// outside one when a `.svn` is found above the folder, else nothing. Git wins
// ties: a git clone inside an svn working copy is git (VantageHUD render.js).
// A detached HEAD is named only with the detachedHead option on (VantageHUD
// read it only then): off, the branch fragment hides it anyway.

export async function readVcs($: EngineInterface, detachedHead: boolean): Promise<VcsValues> {
  const repo = await $.session.repo()
  if (repo) return readGit($, repo.remote, detachedHead)
  const cwd = await $.session.cwd()
  if (await findSvnRoot($, cwd)) return readSvn($)
  return initialVcs()
}

// ---------------------------------------------------------------------------
// git.
//
// Every git command runs through $.process.run (no shell) with:
// - GIT_OPTIONAL_LOCKS=0: `status` does not refresh and rewrite the index,
//   so it never holds index.lock against the person's own git. The variable,
//   not `--no-optional-locks`: an older git ignores it where it rejects the
//   flag (VantageHUD git-exec.js).
// - `-c core.fsmonitor=false`: a repository's config can name an fsmonitor
//   hook program, which `status` would run, or start git's fsmonitor daemon,
//   a background process left behind by a status line.
// - repo hooks: off already, by the host ("Git runs with repo hooks off",
//   $.process.run in the types); none of these commands runs a hook anyway.
// An inherited GIT_DIR / GIT_WORK_TREE is followed, as Claude Code's own git
// commands follow it.
const GIT = ['git', '-c', 'core.fsmonitor=false'] as const
const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0' }

// The engine's repo() gives whether this is git and the origin URL (so no
// `git remote get-url`), but its root is the main working tree's even in a
// linked worktree, so the worktree and branch still need git.
async function readGit($: EngineInterface, remote: string | null, detachedHead: boolean): Promise<VcsValues> {
  const out = initialVcs()
  out.kind = 'git'
  out.repo = remote ? repoNameFromUrl(remote) : null
  const dirRun = await $.process.run([...GIT, 'rev-parse', '--absolute-git-dir'], { env: GIT_ENV })
  const gitDir = dirRun.exitCode === 0 ? dirRun.stdout.trim() : ''
  // A linked worktree's own git dir (`<common>/worktrees/<name>`) holds a
  // `commondir` file; the main one's does not. Read from the file, not by
  // comparing paths, so a symlinked spelling can't tell them apart wrongly.
  if (gitDir && (await $.fs.exists(`${gitDir}/commondir`))) out.worktree = baseName(gitDir)
  const run = await $.process.run([...GIT, 'status', '--porcelain=v2', '--branch'], { env: GIT_ENV })
  if (run.exitCode !== 0) return out
  // Past 4 MiB of output the counts are those of the part read, a lower
  // bound (the branch headers come first, so ahead/behind stay whole).
  const status = parseGitStatus(run.stdout)
  out.counts = status.counts
  if (status.head === '(detached)') {
    out.detached = gitDir && detachedHead ? await readDetachedHead($, gitDir) : null
  } else {
    out.branch = status.head
  }
  return out
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

// The operations that leave files in the git dir, in git-prompt.sh's order
// (VantageHUD git.js GIT_OPERATIONS): the rebase directories first, since a
// rebase stopped on a conflict has other operations' files too. A
// `rebase-apply/` folder is either an apply-backend rebase or `git am`: it is
// a rebase when the folder holds a `rebasing` file.
const OPERATIONS: readonly { path: string; label: Operation | 'rebaseOrAm'; progress?: readonly [string, string] }[] = [
  { path: 'rebase-merge', label: 'gitRebase', progress: ['msgnum', 'end'] },
  { path: 'rebase-apply', label: 'rebaseOrAm', progress: ['next', 'last'] },
  { path: 'MERGE_HEAD', label: 'gitMerge' },
  { path: 'CHERRY_PICK_HEAD', label: 'gitCherryPick' },
  { path: 'REVERT_HEAD', label: 'gitRevert' },
  { path: 'BISECT_LOG', label: 'gitBisect' },
]
// A full object name in HEAD: SHA-1, or SHA-256 in a sha256 repository.
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const SHORT_SHA = 7
// What a reftable repository keeps in HEAD, whatever HEAD points at.
const REFTABLE_HEAD = 'ref: refs/heads/.invalid'

async function readText($: EngineInterface, path: string): Promise<string | null> {
  try {
    return (await $.fs.read(path)).trim()
  } catch {
    return null
  }
}

// Names a detached HEAD from the files in this worktree's git dir, as
// VantageHUD's getDetachedHead (git.js); git runs only for a reftable HEAD.
// - Mid-rebase (and `git am`) the branch being rebased, from `head-name`, with
//   the step: `feat`, onBranch, gitRebase, `2/3`.
// - Otherwise the tag or ref HEAD was checked out at, else 7 sha digits, and
//   any operation in progress (bisect, merge, cherry-pick, revert); a ref
//   name only when no operation is in progress, as there.
// - An attached HEAD in the file means status and the file disagree: null.
// Edges left: `logs/HEAD` or `packed-refs` over 4 MiB can't be read whole
// ($.fs.read rejects), so the sha shows instead of the name.
export async function readDetachedHead($: EngineInterface, gitDir: string): Promise<DetachedHead | null> {
  const head = await readText($, `${gitDir}/HEAD`)
  if (head?.startsWith('ref: ') && head !== REFTABLE_HEAD) return null
  let operation: Operation | null = null
  let progress = ''
  let branch: string | null = null
  for (const op of OPERATIONS) {
    const path = `${gitDir}/${op.path}`
    if (!(await $.fs.exists(path))) continue
    operation = op.label === 'rebaseOrAm' ? ((await $.fs.exists(`${path}/rebasing`)) ? 'gitRebase' : 'gitAm') : op.label
    if (op.progress) {
      const step = Number(await readText($, `${path}/${op.progress[0]}`))
      const total = Number(await readText($, `${path}/${op.progress[1]}`))
      if (Number.isInteger(step) && Number.isInteger(total) && step > 0 && total > 0) progress = `${step}/${total}`
      // `refs/heads/feat`, or `detached HEAD` when a detached HEAD was rebased
      const headName = await readText($, `${path}/head-name`)
      if (headName?.startsWith('refs/heads/')) branch = headName.slice('refs/heads/'.length)
    }
    break
  }
  if (branch) return { name: branch, onBranch: true, operation, progress }
  let name: string | null = null
  if (head && FULL_SHA.test(head)) {
    name = (!operation && (await readDetachedRefName($, gitDir, head))) || head.slice(0, SHORT_SHA)
  } else {
    const run = await $.process.run([...GIT, 'rev-parse', '--short', 'HEAD'], { env: GIT_ENV })
    name = run.exitCode === 0 ? run.stdout.trim() || null : null
  }
  return name ? { name, onBranch: false, operation, progress } : null
}

// The name HEAD was detached at, the way `git status` finds it ("HEAD
// detached at v1.0"): the last reflog entry must be the `checkout: moving
// from X to <name>` that produced this HEAD (a commit or reset since moves it
// off), and <name> a tag, branch or remote-tracking ref; `HEAD~2` or a typed
// sha are not names, so the sha shows instead (VantageHUD git.js).
async function readDetachedRefName($: EngineInterface, gitDir: string, sha: string): Promise<string | null> {
  const log = await readText($, `${gitDir}/logs/HEAD`)
  const name = log === null ? null : checkoutTarget(log.slice(log.lastIndexOf('\n') + 1), sha)
  if (name === null || !looksLikeRefName(name)) return null
  return (await refExists($, await commonGitDir($, gitDir), name)) ? name : null
}

// What a reflog line checked out, when that checkout left HEAD at `sha`. A
// line is `<old sha> <new sha> <who> <when> <tz>`, a tab, then the message.
function checkoutTarget(line: string, sha: string): string | null {
  const tab = line.indexOf('\t')
  if (tab < 0) return null
  const [, newSha] = line.slice(0, tab).split(' ')
  if (newSha !== sha) return null
  const message = line.slice(tab + 1).trim()
  return /^checkout: moving from \S+ to (\S+)$/.exec(message)?.[1] ?? null
}

// Only a plain name reads from the refs folders: `HEAD`, `@`, an option-like
// or absolute name, `..` (a range, or a path out of refs/), `@{` (a reflog
// selector) and git's other revision characters (`~ ^ : ? * [ \`, space) are
// what `git checkout` takes for a revision, never a ref (check-ref-format).
function looksLikeRefName(name: string): boolean {
  if (name === 'HEAD' || name === '@') return false
  return !/^[-/]|\.\.|@\{|[\\~^:?*[\s]/.test(name)
}

const REF_KINDS = ['tags', 'heads', 'remotes'] as const

// A tag, branch or remote-tracking ref of that name, loose or packed
// (packed-refs lines are `<sha> refs/<kind>/<name>`).
async function refExists($: EngineInterface, commonDir: string, name: string): Promise<boolean> {
  for (const kind of REF_KINDS) {
    if (await $.fs.exists(`${commonDir}/refs/${kind}/${name}`)) return true
  }
  const packed = await readText($, `${commonDir}/packed-refs`)
  if (packed === null) return false
  const wanted = REF_KINDS.map(kind => ` refs/${kind}/${name}`)
  return packed.split('\n').some(line => wanted.some(end => line.endsWith(end)))
}

// The git dir that holds the refs: a linked worktree's own git dir points to
// it with a `commondir` file (a path relative to the worktree's git dir, or
// absolute); the main working tree's git dir is it.
async function commonGitDir($: EngineInterface, gitDir: string): Promise<string> {
  const pointer = await readText($, `${gitDir}/commondir`)
  return pointer ? resolvePath(gitDir, pointer) : gitDir
}

// ---------------------------------------------------------------------------
// svn: `svn info|status --xml --non-interactive` (VantageHUD svn.js, AGENTS.md):
// `--xml` keeps the parse free of the locale's words, `--non-interactive`
// makes a credentials prompt impossible, and no `-u` keeps both local (hence
// no ahead/behind for svn).

// The nearest `.svn` at or above the folder, after resolving symlinks: a
// folder reached through a link into a working copy has no `.svn` among the
// link's own parents (VantageHUD worktree-paths.js findSvnWorkingCopyRoot).
// Since svn 1.7 only a working copy's root (and each external's) holds `.svn`,
// so the first one found is it. `$.fs.ancestors` can't do this walk: it takes
// `.md` names only (types, FsAncestorsRequest).
// Edge left: a pre-1.7 working copy (a `.svn` in every folder) is found at
// the folder itself; svn 1.7+ asks for `svn upgrade` before reading one.
export async function findSvnRoot($: EngineInterface, cwd: string): Promise<string | null> {
  let dir = cwd
  try {
    dir = (await $.fs.stat(cwd, { resolve: true })).realPath ?? cwd
  } catch {
    // missing or unreadable: walk it as given
  }
  for (;;) {
    if (await $.fs.exists(`${dir === '/' ? '' : dir}/.svn`)) return dir
    const parent = dir.replace(/\/[^/]*$/, '') || '/'
    if (parent === dir) return null
    dir = parent
  }
}

const SVN = ['svn', '--non-interactive'] as const

async function readSvn($: EngineInterface): Promise<VcsValues> {
  const out = initialVcs()
  out.kind = 'svn'
  const info = await $.process.run([...SVN, 'info', '--xml'])
  if (info.exitCode === 0) {
    const parsed = parseSvnInfoXml(info.stdout)
    out.repo = parsed.project
    out.branch = parsed.branch
    out.revision = parsed.revision
  }
  const status = await $.process.run([...SVN, 'status', '--xml'])
  // Past 4 MiB (`isStdoutTruncated`, ~90 bytes an unversioned path) the
  // counts are those of the entries read whole, a lower bound.
  if (status.exitCode === 0) out.counts = parseSvnStatusXml(status.stdout)
  return out
}

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

// `svn info --xml`: url, root, relative-url (svn 1.8+), and the working
// copy's revision, from <entry> (<commit revision> is the last-changed one).
export function parseSvnInfoXml(xml: string): { project: string | null; branch: string | null; revision: string | null } {
  const tag = (name: string): string | null => {
    const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)
    return m ? urlText(m[1]!) : null
  }
  const url = tag('url')
  if (!url) return { project: null, branch: null, revision: null }
  const { project, branch } = deriveRepoAndBranch(url, tag('root'), tag('relative-url'))
  return { project, branch, revision: /<entry\b[^>]*\brevision="(\d+)"/.exec(xml)?.[1] ?? null }
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

// ---------------------------------------------------------------------------
// Paths, without node:path (a mod imports only its own files and claude-code).

function baseName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() ?? path
}

// `rel` against the absolute folder `base`, `.` and `..` folded.
function resolvePath(base: string, rel: string): string {
  const parts: string[] = []
  for (const part of (rel.startsWith('/') ? rel : `${base}/${rel}`).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}
