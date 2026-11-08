import { randomBytes } from 'node:crypto'
import { mkdir, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const busy = () => new Error('Another VArgus control is pending in this pane; wait for it to finish.')

async function release(directory: string, owner: string): Promise<void> {
  try { await unlink(join(directory, owner)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  try { await rmdir(directory) } catch (error) {
    // A contender may already have replaced the empty directory. Its nonempty
    // owner record protects it from removal by this departing caller.
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
  }
}

// Publish a prepared, nonempty directory so cancellation cannot leave an
// ownerless admission lock. Reaping uses the same PID-liveness rule as tmux owners.
export async function withControlLock<T>(lock: string, action: () => Promise<T>): Promise<T> {
  const owner = `${process.pid}-${randomBytes(16).toString('hex')}`, candidate = lock + '.' + owner
  await mkdir(candidate, { mode: 0o700 })
  try {
    await writeFile(join(candidate, owner), '', { mode: 0o600 })
    for (;;) {
      try { await rename(candidate, lock); break } catch (error) {
        if (!['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      }
      let owners: string[]
      try { owners = await readdir(lock) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      if (owners.length !== 1 || !/^\d+-[a-f0-9]{32}$/.test(owners[0]!)) throw busy()
      const previous = owners[0]!
      if (alive(Number(previous.split('-')[0]))) throw busy()
      await release(lock, previous)
    }
    try { return await action() } finally { await release(lock, owner) }
  } finally { await rm(candidate, { recursive: true, force: true }) }
}
