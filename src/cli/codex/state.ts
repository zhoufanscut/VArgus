import { createHash } from 'node:crypto'
import { readFile, writeFile, readdir, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Target } from '../../outputs/tmux/target.ts'
import type { FooterSelection } from '../../hosts/codex/footer.ts'
import type { SavedOptions } from '../../hosts/codex/options.ts'

export type Running = { pid: number; thread: string; transcript?: string; target: Target; token: string; version?: number;
  mode?: 'on' | 'restore'; selected?: string; pending?: number; error?: string;
  paused?: { thread: string; label: string };
  reload?: { version: 1; home: string } & SavedOptions }
export type FooterBackup = { thread: string; target: Target; selection: FooterSelection }
export type Spec = SavedOptions & { target: Target; thread: string; transcript: string; home: string;
  token: string; mode: 'on' | 'restore' }
export const workerVersion = 7
export const controlRoot = () => join(tmpdir(), `vargus-control-${process.getuid?.() ?? 'user'}`)
export const running = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
export const recordPath = (target: Target) => join(controlRoot(), createHash('sha256').update(target.socket + '\0' + target.pane).digest('hex') + '.json')
export const footerRoot = () => join(controlRoot(), 'footers')
export const footerPath = (target: Target, thread: string) => join(footerRoot(), createHash('sha256').update(JSON.stringify([target.socket, target.pane, target.pid, thread])).digest('hex') + '.json')
export const requestPath = (r: { token: string }) => join(controlRoot(), r.token + '.request')
export const replyPath = (id: string) => join(controlRoot(), id + '.reply')
export const sameTarget = (a: Target, b: Target) => a.socket === b.socket && a.pane === b.pane && a.pid === b.pid
export async function json<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
}
export async function save(file: string, value: unknown): Promise<void> {
  const temporary = file + '.' + process.pid + '.tmp'
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
  await rename(temporary, file)
}
export async function backups(target: Target): Promise<FooterBackup[]> {
  const result: FooterBackup[] = []
  for (const name of await readdir(footerRoot())) {
    if (!name.endsWith('.json')) continue
    const b = await json<FooterBackup>(join(footerRoot(), name))
    if (b && sameTarget(b.target, target)) result.push(b)
  }
  return result
}
