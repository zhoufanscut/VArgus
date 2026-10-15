import type { Fragment, FragmentInput } from '../../core/types'
import { cleanText } from '../text'

// 9-11. repo, branch, working-tree status, for git or svn (DESIGN,
// "Fragments"), with VantageHUD's colours (git.js, svn.js): labels in `label`,
// names in `gradLow`, an operation in progress in `gradMid`, conflicts in
// `gradHigh`, then `add` / `del` / `track` for the counts.

// repo:VArgus
export const repo: Fragment = ({ v, l, t }) =>
  v.vcs.kind && v.vcs.repo ? t.paint('label', `${l.repo}:`) + t.paint('gradLow', cleanText(v.vcs.repo)) : null

// git: branch:main, branch:main (wt:x), and with the detachedHead option
// branch:@v1.0, branch:@a1b2c3d (bisect), branch:feat (rebase 2/3).
// svn: branch:trunk@12345, the working copy's revision after `@`.
export const branch: Fragment = f => {
  const { v, l, t } = f
  const head = v.vcs.kind === 'svn' ? svnHead(f) : v.vcs.kind === 'git' ? gitHead(f) : null
  if (!head) return null
  const wt = v.vcs.kind === 'git' && v.vcs.worktree
    ? ` ${t.paint('label', l.worktree)}${t.paint('gradLow', cleanText(v.vcs.worktree))}${t.paint('label', ')')}`
    : ''
  return `${t.paint('label', `${l.branch}:`)}${head}${wt}`
}

function svnHead({ v, l, t }: FragmentInput): string | null {
  if (!v.vcs.branch) return null
  const revision = v.vcs.revision ? t.paint('label', l.detachedAt) + t.paint('gradLow', cleanText(v.vcs.revision)) : ''
  return t.paint('gradLow', cleanText(v.vcs.branch)) + revision
}

// A detached HEAD shows only with the option on, as in VantageHUD; off, the
// branch fragment is left out. The operation shows only here, as there.
function gitHead({ v, o, l, t }: FragmentInput): string | null {
  if (v.vcs.branch) return t.paint('gradLow', cleanText(v.vcs.branch))
  const d = v.vcs.detached
  if (!o.detachedHead || !d) return null
  const name = t.paint('gradLow', cleanText(d.name))
  const head = d.onBranch ? name : t.paint('label', l.detachedAt) + name
  if (!d.operation) return head
  const step = d.progress ? ` ${d.progress}` : ''
  return `${head} ${t.paint('gradMid', `(${cleanText(l[d.operation])}${step})`)}`
}

// ✗1 +2 !3 ?1 ⇡1 ⇣2, each only when non-zero; conflicts first, since an
// unmerged tree is what must be cleared before anything else lands.
export const status: Fragment = ({ v, l, t }) => {
  const c = v.vcs.kind ? v.vcs.counts : null
  if (!c) return null
  const parts = [
    c.conflicted > 0 ? t.paint('gradHigh', `${l.conflict}${c.conflicted}`) : '',
    c.staged > 0 ? t.paint('add', `${l.staged}${c.staged}`) : '',
    c.modified > 0 ? t.paint('del', `${l.modified}${c.modified}`) : '',
    c.untracked > 0 ? t.paint('track', `${l.untracked}${c.untracked}`) : '',
    c.ahead > 0 ? t.paint('add', `${l.ahead}${c.ahead}`) : '',
    c.behind > 0 ? t.paint('del', `${l.behind}${c.behind}`) : '',
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : null
}
