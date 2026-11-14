import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000
const PRUNE_INTERVAL_MS = 60 * 60 * 1000

export function defaultCacheDir(): string {
  return join(tmpdir(), `vargus-antigravity-${process.getuid?.() ?? 'user'}`)
}

export function cachePath(cacheDir: string, kind: string, key: string): string {
  const digest = createHash('sha256').update(key).digest('hex')
  return join(cacheDir, `${kind}-${digest}.json`)
}

export async function readCache<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

export async function writeCache(cacheDir: string, file: string, value: unknown): Promise<void> {
  await mkdir(cacheDir, { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 })
  await rename(temp, file)
  await maybePrune(cacheDir, file).catch(() => {})
}

async function maybePrune(cacheDir: string, keepFile: string): Promise<void> {
  const wallNow = Date.now()
  const marker = join(cacheDir, '.pruned')
  try {
    const info = await stat(marker)
    if (wallNow - info.mtimeMs < PRUNE_INTERVAL_MS) return
  } catch {
    // first prune
  }
  await writeFile(marker, '', { mode: 0o600 }).catch(() => {})
  for (const name of await readdir(cacheDir)) {
    if (name === '.pruned') continue
    const path = join(cacheDir, name)
    if (path === keepFile) continue
    try {
      const info = await stat(path)
      if (wallNow - info.mtimeMs > MAX_CACHE_AGE_MS) await rm(path, { force: true })
    } catch {
      // concurrent removal
    }
  }
}
