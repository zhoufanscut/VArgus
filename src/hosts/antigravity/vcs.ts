import { execFile } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  initialVcs,
  parseGitStatus,
  repoNameFromUrl,
  type DetachedHead,
  type Operation,
  type VcsValues,
} from '../../core/vcs.ts'
import { cachePath, readCache, writeCache } from './cache.ts'

const exec = promisify(execFile)

export const POLL_MS = 5000
const HOLD_FACTOR = 10

type VcsCache = {
  version: 1
  cwd: string
  detachedHead: boolean
  lastEnd: number
  lastMs: number
  mutatingBySession: Record<string, number>
  vcs: VcsValues
}

const OPERATIONS: readonly { path: string; label: Operation | 'rebaseOrAm'; progress?: readonly [string, string] }[] = [
  { path: 'rebase-merge', label: 'gitRebase', progress: ['msgnum', 'end'] },
  { path: 'rebase-apply', label: 'rebaseOrAm', progress: ['next', 'last'] },
  { path: 'MERGE_HEAD', label: 'gitMerge' },
  { path: 'CHERRY_PICK_HEAD', label: 'gitCherryPick' },
  { path: 'REVERT_HEAD', label: 'gitRevert' },
  { path: 'BISECT_LOG', label: 'gitBisect' },
]

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const SHORT_SHA = 7
const REFTABLE_HEAD = 'ref: refs/heads/.invalid'
const REF_KINDS = ['tags', 'heads', 'remotes'] as const

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readTrimmed(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch {
    return null
  }
}

// Keep under Antigravity CLI's 5 s statusLine timeout so a stalled git walk
// still exits 0 and records its 10x hold-off rather than counting as a failure.
const GIT_TIMEOUT_MS = 4000

function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return exec('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd,
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  })
}

function checkoutTarget(line: string, sha: string): string | null {
  const tab = line.indexOf('\t')
  if (tab < 0) return null
  const [, newSha] = line.slice(0, tab).split(' ')
  if (newSha !== sha) return null
  const message = line.slice(tab + 1).trim()
  return /^checkout: moving from \S+ to (\S+)$/.exec(message)?.[1] ?? null
}

function looksLikeRefName(name: string): boolean {
  if (name === 'HEAD' || name === '@') return false
  return !/^[-/]|\.\.|@\{|[\\~^:?*[\s]/.test(name)
}

async function commonGitDir(gitDir: string): Promise<string> {
  const pointer = await readTrimmed(join(gitDir, 'commondir'))
  return pointer ? resolve(gitDir, pointer) : gitDir
}

async function refExists(commonDir: string, name: string): Promise<boolean> {
  for (const kind of REF_KINDS) {
    if (await exists(join(commonDir, 'refs', kind, name))) return true
  }
  const packed = await readTrimmed(join(commonDir, 'packed-refs'))
  if (packed === null) return false
  const wanted = REF_KINDS.map(kind => ` refs/${kind}/${name}`)
  return packed.split(/\r?\n/).some(line => wanted.some(end => line.endsWith(end)))
}

async function readDetachedRefName(gitDir: string, sha: string): Promise<string | null> {
  const log = await readTrimmed(join(gitDir, 'logs', 'HEAD'))
  const name = log === null ? null : checkoutTarget(log.slice(log.lastIndexOf('\n') + 1), sha)
  if (name === null || !looksLikeRefName(name)) return null
  return (await refExists(await commonGitDir(gitDir), name)) ? name : null
}

async function readDetachedHead(cwd: string, gitDir: string): Promise<DetachedHead | null> {
  const head = await readTrimmed(join(gitDir, 'HEAD'))
  if (head?.startsWith('ref: ') && head !== REFTABLE_HEAD) return null
  let operation: Operation | null = null
  let progress = ''
  let branch: string | null = null
  for (const op of OPERATIONS) {
    const path = join(gitDir, op.path)
    if (!(await exists(path))) continue
    operation = op.label === 'rebaseOrAm' ? ((await exists(join(path, 'rebasing'))) ? 'gitRebase' : 'gitAm') : op.label
    if (op.progress) {
      const step = Number(await readTrimmed(join(path, op.progress[0])))
      const total = Number(await readTrimmed(join(path, op.progress[1])))
      if (Number.isInteger(step) && Number.isInteger(total) && step > 0 && total > 0) progress = `${step}/${total}`
      const headName = await readTrimmed(join(path, 'head-name'))
      if (headName?.startsWith('refs/heads/')) branch = headName.slice('refs/heads/'.length)
    }
    break
  }
  if (branch) return { name: branch, onBranch: true, operation, progress }
  let name: string | null = null
  if (head && FULL_SHA.test(head)) {
    name = (!operation && (await readDetachedRefName(gitDir, head))) || head.slice(0, SHORT_SHA)
  } else {
    try {
      name = (await runGit(cwd, ['rev-parse', '--short', 'HEAD'])).stdout.trim() || null
    } catch {
      name = null
    }
  }
  return name ? { name, onBranch: false, operation, progress } : null
}

export async function readGit(cwd: string, detachedHead = false): Promise<VcsValues> {
  const out = initialVcs()
  if (!cwd) return out
  try {
    const [statusRun, dirRun, remoteRun] = await Promise.all([
      runGit(cwd, ['status', '--porcelain=v2', '--branch']),
      runGit(cwd, ['rev-parse', '--absolute-git-dir']).catch(() => null),
      runGit(cwd, ['remote', 'get-url', '--push', 'origin']).catch(() => null),
    ])
    out.kind = 'git'
    out.repo = remoteRun ? repoNameFromUrl(remoteRun.stdout.trim()) : null
    const gitDir = dirRun?.stdout.trim() ?? ''
    if (gitDir && (await exists(join(gitDir, 'commondir')))) {
      out.worktree = basename(gitDir)
    }
    const parsed = parseGitStatus(statusRun.stdout)
    out.counts = parsed.counts
    if (parsed.head === '(detached)') {
      out.detached = gitDir && detachedHead ? await readDetachedHead(cwd, gitDir) : null
    } else {
      out.branch = parsed.head
    }
  } catch {
    // outside a git worktree
  }
  return out
}

export async function readCachedGit(
  cwd: string,
  detachedHead: boolean,
  sessionKey: string,
  mutatingToolsSeen: number,
  cacheDir: string,
  now = Date.now(),
): Promise<VcsValues> {
  if (!cwd) return initialVcs()
  const file = cachePath(cacheDir, 'vcs', `${cwd}\0${detachedHead ? '1' : '0'}`)
  const cached = await readCache<VcsCache>(file)
  const mutatingMap: Record<string, number> = { ...(cached?.mutatingBySession ?? {}) }
  if (cached && cached.version === 1 && cached.cwd === cwd && cached.detachedHead === detachedHead) {
    const hold = HOLD_FACTOR * Math.max(0, cached.lastMs)
    const previous = sessionKey ? cached.mutatingBySession?.[sessionKey] : undefined
    const asked = previous !== undefined && mutatingToolsSeen > previous
    // Treat backward clock steps (`now < cached.lastEnd`) as due so NTP/WSL2
    // clock adjustments never freeze Git readings.
    const due = now < cached.lastEnd
      || (asked ? now >= cached.lastEnd + hold : now >= cached.lastEnd + Math.max(POLL_MS, hold))
    if (!due) {
      if (sessionKey && (previous === undefined || mutatingToolsSeen < previous)) {
        mutatingMap[sessionKey] = mutatingToolsSeen
        await writeCache(cacheDir, file, { ...cached, mutatingBySession: trimSessionMap(mutatingMap) }).catch(() => {})
      }
      return cached.vcs
    }
  }

  const start = Date.now()
  const vcs = await readGit(cwd, detachedHead)
  const end = Date.now()
  if (sessionKey) mutatingMap[sessionKey] = mutatingToolsSeen
  const entry: VcsCache = {
    version: 1,
    cwd,
    detachedHead,
    lastEnd: now + Math.max(0, end - start),
    lastMs: Math.max(0, end - start),
    mutatingBySession: trimSessionMap(mutatingMap),
    vcs,
  }
  await writeCache(cacheDir, file, entry).catch(() => {})
  return vcs
}

function trimSessionMap(map: Record<string, number>): Record<string, number> {
  const entries = Object.entries(map)
  return Object.fromEntries(entries.slice(-16))
}
