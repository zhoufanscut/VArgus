import { readFile } from 'node:fs/promises'

export async function processIsRunning(pid: number): Promise<boolean> {
  if (process.platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      // A zombie still has a PID. The state follows the closing parenthesis of comm.
      if (stat[stat.lastIndexOf(')') + 2] === 'Z') return false
    } catch { /* fall back to the signal check without procfs */ }
  }
  try { process.kill(pid, 0); return true } catch { return false }
}
