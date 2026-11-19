import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

export type ModelDefault = (model: string, cwd: string) => Promise<string | undefined>

// The saved config supplies an explicit catalog path, null for the home cache,
// or undefined before that workspace's config has been read.
export function cachedModelDefault(home: string, catalogFor: (cwd: string) => string | null | undefined): ModelDefault {
  const homeCache = join(home, 'models_cache.json')
  const snapshots = new Map<string, { stamp: string; efforts: Map<string, string> }>()
  return async (model, cwd) => {
    const catalog = catalogFor(cwd)
    if (catalog === undefined) return undefined
    const file = catalog ?? homeCache
    try {
      const info = await stat(file)
      const stamp = `${info.mtimeMs}:${info.ctimeMs}:${info.size}`
      let snapshot = snapshots.get(file)
      if (snapshot?.stamp !== stamp) {
        const { models } = JSON.parse(await readFile(file, 'utf8'))
        const efforts = new Map<string, string>()
        if (Array.isArray(models)) {
          for (const entry of models) {
            if (typeof entry?.slug === 'string' && typeof entry.default_reasoning_level === 'string') {
              efforts.set(entry.slug, entry.default_reasoning_level)
            }
          }
        }
        snapshot = { stamp, efforts }
        snapshots.set(file, snapshot)
      }
      return snapshot.efforts.get(model)
    } catch {
      snapshots.delete(file)
      return undefined
    }
  }
}
