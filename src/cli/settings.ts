import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withControlLock } from './lock.ts'

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function allowMissing(error: NodeJS.ErrnoException): undefined {
  if (error.code !== 'ENOENT') throw error
}

export async function readSettings(file: string): Promise<{ previous: string | undefined; settings: Record<string, unknown> }> {
  const previous = await readFile(file, 'utf8').catch(allowMissing)
  let settings: unknown = {}
  if (previous !== undefined) {
    try { settings = JSON.parse(previous) }
    catch (error) { throw new Error(`Could not parse JSON in ${file}.`, { cause: error }) }
  }
  if (!isObject(settings)) throw new Error(`Expected a JSON settings object in ${file}.`)
  return { previous, settings }
}

export async function writeSettings(file: string, previous: string | undefined, settings: Record<string, unknown>): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`
  const mode = previous === undefined ? 0o600 : (await stat(file)).mode & 0o777
  try {
    await writeFile(temporary, JSON.stringify(settings, null, 2) + '\n', { flag: 'wx', mode })
    if (await readFile(file, 'utf8').catch(allowMissing) !== previous) {
      throw new Error(`${file} changed during setup. Run the command again.`)
    }
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function withSettingsLock<T>(path: string, edit: (file: string) => Promise<T>, busyMessage: string): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const info = await lstat(path).catch(allowMissing)
  const file = info?.isSymbolicLink() ? await realpath(path) : path
  return withControlLock(file + '.vargus.lock', () => edit(file), busyMessage)
}
