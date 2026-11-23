import { initialVcs, type VcsValues } from '../core/vcs.ts'
import { readGit } from './git.ts'
import { findSvnRoot, readSvn } from './svn.ts'

export { readGit } from './git.ts'
export { findSvnRoot, readSvn } from './svn.ts'

const VCS_TIMEOUT_MS = 4000

// Git wins ties (a git clone inside an SVN working copy reads as git).
// Outside Git, fall back to local SVN XML only when a `.svn` root exists.
export async function readVcs(cwd: string, timeout = VCS_TIMEOUT_MS): Promise<VcsValues> {
  if (!cwd || timeout <= 0) return initialVcs()
  const start = performance.now()
  const remaining = () => Math.round(timeout - Math.max(0, performance.now() - start))
  const git = await readGit(cwd, timeout)
  if (git.kind === 'git') return git
  if (remaining() <= 0) return initialVcs()
  if (!(await findSvnRoot(cwd))) return initialVcs()
  const left = remaining()
  if (left <= 0) return initialVcs()
  return readSvn(cwd, left)
}
