import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, unlink, rmdir, readdir, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { PaneInput } from './input.ts'
import { tmuxLine, TMUX_PADDING } from './format.ts'

const exec = promisify(execFile)
type Owner = { pid: number; pane: string; token: string; priorLine?: string }
type State = { owners: Owner[]; backup: string; applied: string }
const ROW = '#{@vargus_line}'

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

// Session options are shared, but content belongs to the active pane. A short
// filesystem lock serializes launches/exits from separate VArgus processes.
export class TmuxOutput {
  private session = ''
  private directory = ''
  private owner: Owner
  private attached = false

  private socket: string
  private pane: string
  private stateRoot: string
  constructor(socket: string, pane: string, stateRoot = join(tmpdir(), `vargus-tmux-${process.getuid?.() ?? 'user'}`)) {
    this.socket = socket; this.pane = pane; this.stateRoot = stateRoot
    if (!/^%\d+$/.test(pane)) throw new Error('VArgus needs a tmux pane (TMUX_PANE).')
    this.owner = { pid: process.pid, pane, token: randomUUID() }
  }

  static environment(): TmuxOutput {
    const socket = process.env.TMUX?.split(',')[0]
    if (!socket || !process.env.TMUX_PANE) throw new Error('Run VArgus inside tmux.')
    return new TmuxOutput(socket, process.env.TMUX_PANE)
  }

  async command(...args: string[]): Promise<string> {
    const { stdout } = await exec('tmux', ['-S', this.socket, ...args], { timeout: 5000, maxBuffer: 1024 * 1024 })
    return stdout.replace(/\n$/, '')
  }

  async redraw(): Promise<void> {
    for (const client of (await this.command('list-clients', '-t', this.pane, '-F', '#{client_name}')).split('\n').filter(Boolean)) {
      await this.command('refresh-client', '-t', client)
    }
  }

  private async initialize(): Promise<void> {
    if (this.directory) return
    this.session = await this.command('display-message', '-p', '-t', this.pane, '#{session_id}')
    const key = createHash('sha256').update(this.socket + '\0' + this.session).digest('hex').slice(0, 24)
    this.directory = join(this.stateRoot, key)
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
  }

  private async locked<T>(action: () => Promise<T>): Promise<T> {
    await this.initialize()
    const lock = join(this.directory, 'lock')
    const holder = `${process.pid}-${randomUUID()}`
    const candidate = join(this.directory, `lock-${randomUUID()}`)
    await mkdir(candidate)
    await writeFile(join(candidate, holder), '')
    let acquired = false
    const until = Date.now() + 10000
    // A prepared nonempty directory is published atomically. Contenders never
    // inspect a lock between its creation and the writing of its owner record.
    const release = async (directory: string, name: string) => {
      try { await unlink(join(directory, name)) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      try { await rmdir(directory) } catch (error) {
        // Another contender may already have replaced the now-empty directory.
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      }
    }
    try {
      while (!acquired) {
        try {
          await rename(candidate, lock)
          acquired = true
        } catch (error) {
          if (!['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
          let holders: string[] | undefined
          try { holders = await readdir(lock) } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
          if (holders?.length === 1 && /^\d+-[0-9a-f-]+$/.test(holders[0]!)) {
            const owner = holders[0]!
            if (!alive(Number(owner.split('-')[0]))) await release(lock, owner)
          }
          if (Date.now() > until) throw new Error('Timed out waiting for the VArgus tmux lock.')
          await delay(25)
        }
      }
      return await action()
    } finally {
      await release(acquired ? lock : candidate, holder)
    }
  }

  private async local(): Promise<string> {
    return (await this.command('show-options', '-t', this.session)).split('\n')
      .filter(line => line.startsWith('status ') || line.startsWith('status-format[')).join('\n')
  }

  private async state(): Promise<State | undefined> {
    try { return JSON.parse(await readFile(join(this.directory, 'state.json'), 'utf8')) as State }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }

  private save(state: State): Promise<void> {
    return writeFile(join(this.directory, 'state.json'), JSON.stringify(state), { mode: 0o600 })
  }

  private async clearOwner(owner: Owner): Promise<void> {
    try {
      if (await this.command('show-options', '-p', '-v', '-t', owner.pane, '@vargus_owner') !== owner.token) return
      if (owner.priorLine === undefined) await this.command('set-option', '-p', '-u', '-t', owner.pane, '@vargus_line')
      else await this.command('set-option', '-p', '-t', owner.pane, '@vargus_line', owner.priorLine)
      await this.command('set-option', '-p', '-u', '-t', owner.pane, '@vargus_owner')
    } catch { /* the pane may already have been closed */ }
  }

  private async prune(state: State): Promise<void> {
    for (const owner of state.owners) if (!alive(owner.pid)) await this.clearOwner(owner)
    state.owners = state.owners.filter(owner => alive(owner.pid))
  }

  private async restore(state: State): Promise<void> {
    if (await this.local() === state.applied) {
      // source-file reads the server's own quoted option values. It never gets
      // line content, paths from the repository, or shell-expanded strings.
      const script = [
        `set-option -u -t '${this.session}' status-format`,
        `set-option -u -t '${this.session}' status`,
        ...state.backup.split('\n').filter(Boolean).map(line => `set-option -t '${this.session}' ${line}`),
      ].join('\n') + '\n'
      const file = join(this.directory, 'restore.tmux')
      await writeFile(file, script, { mode: 0o600 })
      await this.command('source-file', file)
      await unlink(file)
    } else {
      console.error('VArgus: tmux status options changed while running; kept your newer settings.')
    }
    await unlink(join(this.directory, 'state.json'))
  }

  async attach(): Promise<void> {
    await this.locked(async () => {
      let state = await this.state()
      if (state) {
        await this.prune(state)
        if (!state.owners.length) { await this.restore(state); state = undefined }
      }
      if (state?.owners.some(owner => owner.pane === this.pane)) throw new Error('VArgus is already running in this pane.')
      if (!state) {
        const status = await this.command('show-options', '-A', '-v', '-t', this.session, 'status')
        const rows = status === 'off' ? 0 : status === 'on' ? 1 : Number(status)
        if (rows >= 5) throw new Error('tmux already uses its maximum status rows; VArgus did not change them.')
        const originals: string[] = []
        for (let i = 0; i < rows; i++) originals.push(await this.command('show-options', '-A', '-v', '-t', this.session, `status-format[${i}]`))
        const backup = await this.local()
        state = { owners: [], backup, applied: '' }
        try {
          for (let i = 0; i < originals.length; i++) await this.command('set-option', '-t', this.session, `status-format[${i + 1}]`, originals[i]!)
          await this.command('set-option', '-t', this.session, 'status-format[0]', ROW)
          await this.command('set-option', '-t', this.session, 'status', rows === 0 ? 'on' : String(rows + 1))
          state.applied = await this.local()
          await this.save(state)
        } catch (error) {
          state.applied = await this.local()
          await this.save(state)
          await this.restore(state)
          throw error
        }
      }
      try { this.owner.priorLine = await this.command('show-options', '-p', '-v', '-t', this.pane, '@vargus_line') } catch { /* unset */ }
      state.owners.push(this.owner)
      await this.save(state)
      this.attached = true
      await this.command('set-option', '-p', '-t', this.pane, '@vargus_owner', this.owner.token)
    })
  }

  snapshot() {
    return new PaneInput({ socket: this.socket, pane: this.pane }).snapshot()
  }

  async width(): Promise<number> {
    return Math.max(0, Number(await this.command('display-message', '-p', '-t', this.pane, '#{window_width}')) - TMUX_PADDING.length)
  }

  async update(ansi: string): Promise<void> {
    await this.command('set-option', '-p', '-t', this.pane, '@vargus_line', tmuxLine(ansi))
    const clients = await this.command('list-clients', '-t', this.session, '-F', '#{client_name}')
    for (const client of clients.split('\n').filter(Boolean)) await this.command('refresh-client', '-S', '-t', client)
  }

  async detach(): Promise<void> {
    if (!this.attached) return
    await this.locked(async () => {
      const state = await this.state()
      if (!state) return
      await this.clearOwner(this.owner)
      state.owners = state.owners.filter(owner => owner.token !== this.owner.token)
      await this.prune(state)
      if (state.owners.length) await this.save(state)
      else await this.restore(state)
    })
    this.attached = false
  }

  async cleanupAbandoned(): Promise<void> {
    await this.locked(async () => {
      const state = await this.state()
      if (!state) return
      await this.prune(state)
      if (state.owners.length) await this.save(state)
      else await this.restore(state)
    })
  }

  async reset(): Promise<void> {
    await this.locked(async () => {
      const state = await this.state()
      if (!state) return
      await this.prune(state)
      if (state.owners.length) throw new Error('VArgus is still running; exit its wrapped sessions before resetting the row.')
      await this.restore(state)
    })
  }
}
