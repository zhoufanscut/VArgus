import { access, mkdir, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { applicationTargets, type Target } from '../outputs/tmux/target'
import { PaneInput } from '../outputs/tmux/input'
import { footerThread, footerCandidates } from '../hosts/codex/hooks'
import { withControlLock } from './lock'

// Broadcast within the selected tmux server. A full current footer ID is the
// binding; neither shared-daemon ancestry nor inherited terminal variables bind it.
async function selectTarget(thread: string, socket: string | undefined, pane: string | undefined, mode: 'whole' | 'first' | 'hint'): Promise<Target | undefined> {
  const targets = await applicationTargets('codex', socket)
  const matches: Target[] = []
  for (const target of targets) {
    const screen = await new PaneInput(target).snapshot()
    if (mode === 'hint' ? footerCandidates(screen).includes(thread) : footerThread(screen, mode === 'first') === thread) matches.push(target)
  }
  if (matches.length === 1 && (!pane || matches[0]!.pane === pane)) return matches[0]
}

export const startupTarget = (thread: string, socket?: string, pane?: string, firstItem = false) =>
  selectTarget(thread, socket, pane, firstItem ? 'first' : 'whole')
export const startupHint = (thread: string, socket?: string, pane?: string) =>
  selectTarget(thread, socket, pane, 'hint')

export const startupDirectory = (home: string) => join(home, 'vargus', 'autostart')

const startupKey = (target: Target) => createHash('sha256').update(JSON.stringify(target)).digest('hex')
const offMarker = (home: string, target: Target, thread: string | undefined) => join(startupDirectory(home), startupKey(target) + '-' + thread + '.off')
export async function startupSuppressed(home: string, target: Target, thread: string): Promise<boolean> {
  try { await access(offMarker(home, target, thread)); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function hasStartupState(home: string): Promise<boolean> {
  try { await access(startupDirectory(home)); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

// Manual off suppresses automatic activation for this thread in this TUI process.
// An explicit on clears it; a new TUI PID or different thread has a separate key.
// The pane lock serializes the final identity check/startup with manual controls.
export async function startupControl(home: string, target: Target, thread: string | undefined,
  action: string, automatic: boolean, perform: () => Promise<number>, firstItem = false): Promise<number> {
  if (action === 'status') return perform()
  const directory = startupDirectory(home)
  if (automatic) await mkdir(directory, { recursive: true, mode: 0o700 })
  else if (!await hasStartupState(home)) return perform()
  const key = startupKey(target)
  const marker = offMarker(home, target, thread)
  return withControlLock(join(directory, key + '.lock'), async () => {
    if (automatic) {
      if (await startupSuppressed(home, target, thread!)) return 0
      const live = await startupTarget(thread!, target.socket, target.pane, firstItem)
      if (!live || live.pid !== target.pid) return 0
    } else if (thread && action === 'off') await writeFile(marker, '', { mode: 0o600 })
    else if (thread && action === 'on') await rm(marker, { force: true })
    return perform()
  })
}
