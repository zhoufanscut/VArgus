import { initialVcs, type VcsValues } from '../../core/vcs.ts'
import { readGit } from '../../node/git.ts'

const POLL_MS = 5000
const HOLD_FACTOR = 10

// Each host session owns its readings and refresh lifetime.
export class OmoVcs {
  private vcs = initialVcs()
  private cwd = ''
  private detachedHead = false
  private generation = 0
  private disposed = false
  private pending: { generation: number; done: Promise<void> } | null = null
  private timing: { start: number; end: number; duration: number } | null = null

  get values(): VcsValues {
    return this.vcs
  }

  async refresh(cwd: string, detachedHead: boolean, now = Date.now(), force = false): Promise<VcsValues> {
    if (this.disposed) return this.vcs
    if (cwd !== this.cwd || detachedHead !== this.detachedHead) {
      this.cwd = cwd
      this.detachedHead = detachedHead
      this.generation++
      this.vcs = initialVcs()
      this.timing = null
    }
    const generation = this.generation
    if (!cwd) return this.vcs
    if (this.pending) {
      const pending = this.pending
      await pending.done
      if (generation !== this.generation || this.disposed) return this.vcs
      if (pending.generation === generation) return this.vcs
      return this.refresh(cwd, detachedHead, now, force)
    }
    if (this.timing) {
      const hold = HOLD_FACTOR * this.timing.duration
      const interval = force ? hold : Math.max(POLL_MS, hold)
      // Backward clock steps must not freeze readings; a call at the same
      // start time is still subject to the duration hold after completion.
      if (now >= this.timing.start && now < this.timing.end + interval) return this.vcs
    }
    const start = Date.now()
    const pending = readGit(cwd, detachedHead).then(vcs => {
      if (generation !== this.generation || this.disposed) return
      const duration = Math.max(0, Date.now() - start)
      this.timing = { start: now, end: now + duration, duration }
      this.vcs = vcs
    })
    this.pending = { generation, done: pending }
    try {
      await pending
    } finally {
      if (this.pending?.done === pending) this.pending = null
    }
    return this.vcs
  }

  dispose(): void {
    this.disposed = true
    this.generation++
    this.vcs = initialVcs()
  }
}
