import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename } from 'node:path'
const exec = promisify(execFile)
export type Target = { socket: string; pane: string; pid: number }

// Resolve a foreground application, never an arbitrary inherited TMUX_PANE.
// A daemon may have inherited another terminal's environment (DESIGN, Hosts and outputs).
async function discoverTargets(command: string, socket?: string, pane?: string) {
  const env = { ...process.env, TMUX: '' }
  const args = [...(socket ? ['-S', socket] : []), 'list-panes', '-a', '-F', '#{socket_path}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}']
  const { stdout } = await exec('tmux', args, { env, timeout: 5000 })
  const table = (await exec('ps', ['-ww', '-axo', 'pid=,ppid=,comm='], { timeout: 5000 })).stdout
    .split('\n').flatMap(line => {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
      return m ? [{ pid: Number(m[1]), parent: Number(m[2]), command: basename(m[3]!) }] : []
    })
  const descends = (pid: number, root: number) => {
    const seen = new Set<number>()
    while (pid && !seen.has(pid)) {
      if (pid === root) return true
      seen.add(pid)
      pid = table.find(p => p.pid === pid)?.parent ?? 0
    }
    return false
  }
  const targets = stdout.trim().split('\n').flatMap(line => {
    const [path, id, root, foreground] = line.split('\t')
    if (foreground !== command || (pane && id !== pane)) return []
    const candidates = table.filter(p => p.command === command && descends(p.pid, Number(root)))
    // The frontend is the outermost matching process; an embedded server may be
    // its child. Prompt text is not a reliable process-role discriminator.
    const processes = candidates.filter(p => !candidates.some(parent => parent.pid !== p.pid && descends(p.pid, parent.pid)))
    return processes.length === 1 ? [{ socket: path!, pane: id!, pid: processes[0]!.pid }] : []
  })
  return { targets, descends }
}

export async function applicationTargets(command: string, socket?: string): Promise<Target[]> {
  return (await discoverTargets(command, socket)).targets
}

export async function applicationTarget(command: string, socket?: string, pane?: string): Promise<Target> {
  const { targets, descends } = await discoverTargets(command, socket, pane)
  const ancestry = targets.filter(t => descends(process.pid, t.pid))
  if (ancestry.length === 1) return ancestry[0]!
  if (targets.length !== 1) throw new Error(`Select one ${command} pane with --pane %ID${socket ? '' : ' (and --socket PATH for a custom tmux server)'}. Matching panes: ${targets.map(t => t.pane).join(', ') || 'none'}.`)
  return targets[0]!
}
