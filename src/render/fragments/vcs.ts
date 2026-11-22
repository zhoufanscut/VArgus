import type { Fragment, FragmentInput } from '../../core/types.ts'
import { cleanText } from '../text.ts'

// 9-11. repo, branch, working-tree status, for git or svn (DESIGN,
// "Fragments"): prefixes and `@` in `label`, repo and branch names in bold
// `text` like folder, worktree in `faint`, an operation in progress in `alert`,
// then `add` / `del` / `track` for all status counts (including conflicts in `del`).

// repo:VArgus
export const repo: Fragment = ({ v, l, t }) =>
  v.vcs.kind && v.vcs.repo ? t.paint('label', `${l.repo}:`) + t.bold(t.paint('text', cleanText(v.vcs.repo))) : null

// git: branch:main, branch:main (wt:x), or a detached HEAD:
// branch:@v1.0, branch:@a1b2c3d (bisect), branch:feat (rebase 2/3).
// svn: branch:trunk.
export const branch: Fragment = f => {
  const { v, l, t } = f
  const head = branchName(f)
  if (!head) return null
  const wt = v.vcs.kind === 'git' && v.vcs.worktree
    ? ` ${t.paint('faint', `${l.worktree}${cleanText(v.vcs.worktree)})`)}`
    : ''
  return `${t.paint('label', `${l.branch}:`)}${head}${wt}`
}

function branchName({ v, l, t }: FragmentInput): string | null {
  if (!v.vcs.kind) return null
  if (v.vcs.branch) return t.bold(t.paint('text', cleanText(v.vcs.branch)))
  const d = v.vcs.detached
  if (v.vcs.kind !== 'git' || !d) return null
  const name = t.bold(t.paint('text', cleanText(d.name)))
  const head = d.onBranch ? name : t.paint('label', l.detachedAt) + name
  if (!d.operation) return head
  const step = d.progress ? ` ${d.progress}` : ''
  return `${head} ${t.paint('alert', `(${cleanText(l[d.operation])}${step})`)}`
}

// ✗1 +2 !3 ?1 ⇡1 ⇣2, each only when non-zero; conflicts first, since an
// unmerged tree is what must be cleared before anything else lands.
export const status: Fragment = ({ v, l, t }) => {
  const c = v.vcs.kind ? v.vcs.counts : null
  if (!c) return null
  const parts = [
    c.conflicted > 0 ? t.paint('del', `${l.conflict}${c.conflicted}`) : '',
    c.staged > 0 ? t.paint('add', `${l.staged}${c.staged}`) : '',
    c.modified > 0 ? t.paint('del', `${l.modified}${c.modified}`) : '',
    c.untracked > 0 ? t.paint('track', `${l.untracked}${c.untracked}`) : '',
    c.ahead > 0 ? t.paint('add', `${l.ahead}${c.ahead}`) : '',
    c.behind > 0 ? t.paint('del', `${l.behind}${c.behind}`) : '',
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : null
}
