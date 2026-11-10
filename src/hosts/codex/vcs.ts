import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { initialVcs, parseGitStatus, parseGitFiles, repoNameFromUrl } from '../../core/vcs.ts'

const exec = promisify(execFile)

export async function readGit(cwd: string) {
  const v = initialVcs()
  const run = (args: string[]) => exec('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  })
  try {
    const { stdout } = await run(['status', '--porcelain=v2', '--branch'])
    const parsed = parseGitStatus(stdout)
    v.kind = 'git'
    v.branch = parsed.head === '(detached)' ? null : parsed.head
    v.counts = parsed.counts
    Object.assign(v, parseGitFiles(stdout))
    try { v.repo = repoNameFromUrl((await run(['remote', 'get-url', '--push', 'origin'])).stdout.trim()) } catch { /* local repository */ }
  } catch { /* not a git worktree; no stale reading from another cwd */ }
  return v
}
