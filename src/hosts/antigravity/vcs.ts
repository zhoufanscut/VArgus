import { initialVcs, type VcsValues } from '../../core/vcs.ts'
import { readGit } from '../../node/git.ts'
import { cachePath, readCache, writeCache } from './cache.ts'

export { readGit } from '../../node/git.ts'

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
