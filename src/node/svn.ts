import { execFile } from 'node:child_process'
import { access, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { initialVcs, parseSvnInfoXml, parseSvnStatusXml, type VcsValues } from '../core/vcs.ts'

const exec = promisify(execFile)

// Keep under Antigravity CLI's 5 s statusLine timeout, matching git.ts.
const SVN_TIMEOUT_MS = 4000
const MAX_BUFFER = 4 * 1024 * 1024

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

// The nearest `.svn` at or above the folder, after resolving symlinks: a
// folder reached through a link into a working copy has no `.svn` among the
// link's own parents (VantageHUD worktree-paths.js findSvnWorkingCopyRoot).
export async function findSvnRoot(cwd: string): Promise<string | null> {
  if (!cwd) return null
  let dir: string
  try {
    dir = await realpath(cwd)
  } catch {
    dir = resolve(cwd)
  }
  for (;;) {
    if (await exists(join(dir, '.svn'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function runSvn(cwd: string, args: string[], timeout: number): Promise<{ stdout: string; stderr: string }> {
  return exec('svn', ['--non-interactive', ...args], {
    cwd,
    windowsHide: true,
    timeout,
    maxBuffer: MAX_BUFFER,
  })
}

function runSvnStatus(cwd: string, timeout: number): Promise<string | null> {
  return runSvn(cwd, ['status', '--xml'], timeout).then(
    run => run.stdout,
    error => (error && typeof error === 'object'
      && 'code' in error && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
      && 'message' in error && typeof error.message === 'string' && error.message.startsWith('stdout ')
      && 'stdout' in error && typeof error.stdout === 'string' && error.stdout.length > 0
      ? error.stdout : null),
  )
}

// Local `svn info|status --xml --non-interactive` (no `-u`, so no network and
// no ahead/behind counts). Past 4 MiB of status output, counts are those of
// the complete entries read, a lower bound.
export async function readSvn(cwd: string, timeout = SVN_TIMEOUT_MS): Promise<VcsValues> {
  const out = initialVcs()
  if (!cwd) return out
  const [infoRun, statusXml] = await Promise.all([
    runSvn(cwd, ['info', '--xml'], timeout).catch(() => null),
    runSvnStatus(cwd, timeout),
  ])
  if (!infoRun && statusXml === null) return out
  out.kind = 'svn'
  if (infoRun) {
    const parsed = parseSvnInfoXml(infoRun.stdout)
    out.repo = parsed.project
    out.branch = parsed.branch
  }
  if (statusXml !== null) out.counts = parseSvnStatusXml(statusXml)
  return out
}
