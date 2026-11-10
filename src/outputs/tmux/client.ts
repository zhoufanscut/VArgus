import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, unlink, rmdir, readdir, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { tmuxLine, TMUX_PADDING } from './format.ts'
import { ansiRuns } from '../ansi.ts'
import { stringWidth } from '../../render/width.ts'

const exec = promisify(execFile)
type Owner = { pid: number; pane: string; token: string; priorLine?: string; priorHeader?: string; inheritedMark?: string }
type NativeBase = { left: string; leftLength: string; rightLength: string; priorLeftAlias: string; template: string;
  sharedMark?: string; priorSharedLine?: string; priorSharedHeader?: string; priorLayout?: string }
type State = { owners: Owner[]; backup: string; applied: string; native?: { status: string; index: number; base?: NativeBase } }
const ROW = '#{@vargus_line}'
const NATIVE_ROW = ROW + '#{@vargus_row_probe}'
const NATIVE_HEADER = '#{@vargus_header}'
// psmux's terminal columns are u16; this lets the padded header fill a row.
const NATIVE_LEFT_LENGTH = '65535'

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
  private nativeBase: NativeBase | undefined
  private nativePublished = new Map<string, string>()

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
    const { stdout } = await exec('tmux', ['-S', this.socket, ...args], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 })
    return stdout.replace(/\r?\n$/, '')
  }

  async redraw(): Promise<void> {
    if (process.platform === 'win32') {
      // psmux 3.4.0 routes a tty-valued -t as a session, even for
      // refresh-client. Its unqualified refresh updates the selected server.
      await this.command('refresh-client')
      return
    }
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
          if (!['ENOTEMPTY', 'EEXIST', ...(process.platform === 'win32' ? ['EPERM'] : [])].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
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

  private async nativeBarCommands(left: string): Promise<boolean> {
    const options = new Map<string, string>()
    const add = (text: string) => {
      for (const line of text.split('\n')) {
        const at = line.indexOf(' ')
        if (at > 0) options.set(line.slice(0, at), line.slice(at + 1))
      }
    }
    add(await this.command('show-options'))
    options.set('status-left', left)
    const roots = ['status-left', 'status-right', 'window-status-format', 'window-status-current-format',
      'window-status-separator', 'status-left-style', 'status-right-style', 'window-status-style',
      'window-status-current-style', 'window-status-bell-style', 'window-status-activity-style', 'window-status-last-style']
    const pending = roots.map(name => options.get(name) ?? '')
    const windows = await this.command('list-windows', '-F', '#{window_id}')
    for (const window of windows.split('\n').filter(Boolean)) {
      const local = await this.command('show-options', '-w', '-t', window)
      for (const line of local.split('\n')) if (roots.some(name => line.startsWith(name + ' '))) pending.push(line)
    }
    const seen = new Set<string>()
    while (pending.length) {
      const value = pending.pop()!
      if (seen.has(value)) continue
      seen.add(value)
      if (value.includes('#(')) return true
      for (const match of value.matchAll(/#\{(?:[ET]:)?(@[\w-]+|[a-z][\w-]+)\}/g)) {
        // psmux resolves an unprefixed user option through @name too.
        const next = options.get(match[1]!) ?? options.get('@' + match[1]!)
        if (next !== undefined) pending.push(next)
      }
    }
    return false
  }

  private async restoreNativeBase(base: NativeBase): Promise<void> {
    for (const [option, applied, original] of [
      ['status-left', NATIVE_HEADER, base.left],
      ['status-left-length', NATIVE_LEFT_LENGTH, base.leftLength],
      ['status-right-length', '0', base.rightLength],
      ['@vargus_original_left', base.left, base.priorLeftAlias],
      ...(base.sharedMark ? [['@vargus_native_layout', base.sharedMark, base.priorLayout ?? '']] : []),
    ]) if (await this.command('show-options', '-v', option!) === applied) await this.command('set-option', option!, original!)
    if (base.sharedMark) for (const [option, original] of [
      ['@vargus_line', base.priorSharedLine ?? ''], ['@vargus_header', base.priorSharedHeader ?? ''],
    ]) if ((await this.command('show-options', '-v', option!)).endsWith(base.sharedMark)) await this.command('set-option', option!, original!)
  }

  private async nativeAppendFallback(): Promise<void> {
    await this.locked(async () => {
      const state = await this.state()
      if (state?.native?.base) {
        await this.restoreNativeBase(state.native.base)
        delete state.native.base
        await this.save(state)
      }
      this.nativeBase = undefined
      this.nativePublished.clear()
    })
  }

  private async nativePublish(changes: { pane?: string; option: string; value: string }[]): Promise<void> {
    const changed = changes.filter(change => this.nativePublished.get((change.pane ?? '') + '\0' + change.option) !== change.value)
    if (!changed.length) return
    const args: string[] = []
    for (const change of changed) {
      if (args.length) args.push(';')
      args.push('set-option', ...(change.pane ? ['-p', '-t', change.pane] : []), change.option, change.value)
    }
    // Publish one batch of differences. SetOption already requests a psmux
    // redraw; forcing another refresh sends redundant metadata/full frames.
    await this.command(...args)
    for (const change of changed) this.nativePublished.set((change.pane ?? '') + '\0' + change.option, change.value)
  }

  private async nativeSlotOwned(index: number): Promise<boolean> {
    if (await this.command('show-options', '-v', '@vargus_native_row') !== String(index)) return false
    const prior = await this.command('show-options', '-v', '@vargus_row_probe')
    // A style-only witness is observable in dump-state without flashing text
    // in the bar. Never reconstruct or assign an existing raw format.
    const witness = `#[fg=#${randomUUID().replaceAll('-', '').slice(0, 6)}]`
    await this.command('set-option', '@vargus_row_probe', witness)
    try {
      const live = JSON.parse(await this.command('dump-state')) as { status_format: string[] }
      const line = await this.command('display-message', '-p', '#{@vargus_line}')
      return live.status_format[index] === line + witness
    } finally {
      if (prior) await this.command('set-option', '@vargus_row_probe', prior)
      else await this.command('set-option', '-u', '@vargus_row_probe')
    }
  }

  private async clearOwner(owner: Owner): Promise<void> {
    try {
      if (await this.command('show-options', '-p', '-v', '-t', owner.pane, '@vargus_owner') !== owner.token) return
      const inherited = (value: string | undefined) => value === undefined || (process.platform === 'win32'
        && (value === '' || (!!owner.inheritedMark && value.endsWith(owner.inheritedMark))))
      if (inherited(owner.priorLine)) await this.command('set-option', '-p', '-u', '-t', owner.pane, '@vargus_line')
      else await this.command('set-option', '-p', '-t', owner.pane, '@vargus_line', owner.priorLine!)
      if (process.platform === 'win32') {
        if (inherited(owner.priorHeader)) await this.command('set-option', '-p', '-u', '-t', owner.pane, '@vargus_header')
        else await this.command('set-option', '-p', '-t', owner.pane, '@vargus_header', owner.priorHeader!)
      }
      await this.command('set-option', '-p', '-u', '-t', owner.pane, '@vargus_owner')
    } catch { /* the pane may already have been closed */ }
  }

  private async prune(state: State): Promise<void> {
    for (const owner of state.owners) if (!alive(owner.pid)) await this.clearOwner(owner)
    state.owners = state.owners.filter(owner => alive(owner.pid))
  }

  private async restore(state: State): Promise<void> {
    if (state.native) {
      const { status, index, base } = state.native
      if (await this.command('show-options', '-v', 'status') === String(index + 1)
        && await this.nativeSlotOwned(index)) {
        // Keep the raw owned slot hidden for a later activation. Clearing an
        // expanded-empty slot could erase an unrelated user's expression.
        await this.command('set-option', 'status', status)
      } else console.error('VArgus: psmux status options no longer match its attachment; kept them.')
      if (base) await this.restoreNativeBase(base)
      await unlink(join(this.directory, 'state.json'))
      return
    }
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
        this.nativeBase = state.native?.base
        await this.prune(state)
        if (!state.owners.length) { await this.restore(state); state = undefined }
      }
      if (state?.owners.some(owner => owner.pane === this.pane)) throw new Error('VArgus is already running in this pane.')
      if (!state) {
        const status = await this.command('show-options', '-A', '-v', '-t', this.session, 'status')
        const rows = status === 'off' ? 0 : status === 'on' ? 1 : Number(status)
        if (rows >= 5) throw new Error('tmux already uses its maximum status rows; VArgus did not change them.')
        if (process.platform === 'win32') {
          // psmux 3.4.0 renders status-format[] but cannot read its raw values
          // through show-options. Append after the existing rows; do not shift
          // or reconstruct those formats from expanded display text.
          const live = JSON.parse(await this.command('dump-state')) as { status_format: string[] }
          const index = Math.max(1, rows)
          const existing = live.status_format.length > index
          if (existing && !await this.nativeSlotOwned(index)) throw new Error('psmux has an existing inactive status slot; VArgus did not overwrite its raw format.')
          let base: NativeBase | undefined
          if (rows <= 1 && !live.status_format[0]) {
            const left = await this.command('show-options', '-v', 'status-left')
            if (!await this.nativeBarCommands(left)) {
            const leftLength = await this.command('show-options', '-v', 'status-left-length')
            const rightLength = await this.command('show-options', '-v', 'status-right-length')
            const priorLeftAlias = await this.command('show-options', '-v', '@vargus_original_left')
            const flagStyle = '#[#{?window_bell_flag,#{E:window-status-bell-style},#{?window_activity_flag,#{E:window-status-activity-style},#{?window_last_flag,#{E:window-status-last-style},default}}}]'
            const inactive = '#[#{E:window-status-style}]' + flagStyle + '#[range=window|#{window_index}]#{E:window-status-format}#[range=none]#{E:window-status-separator}'
            const active = '#[#{E:window-status-current-style}]#[range=window|#{window_index}]#{E:window-status-current-format}#[range=none]#{E:window-status-separator}'
            const template = `#[align=left]#[#{E:status-left-style}]#{=${leftLength}:#{E:@vargus_original_left}}#[default]#{W:${inactive},${active}}#[align=right]#[#{E:status-right-style}]#{=${rightLength}:#{T:status-right}}#[default]`
            const priorSharedLine = await this.command('show-options', '-v', '@vargus_line')
            const priorSharedHeader = await this.command('show-options', '-v', '@vargus_header')
            const priorLayout = await this.command('show-options', '-v', '@vargus_native_layout')
            const sharedMark = `#[fg=#${randomUUID().replaceAll('-', '').slice(0, 6)}]`
            base = { left, leftLength, rightLength, priorLeftAlias, template, sharedMark, priorSharedLine, priorSharedHeader, priorLayout }
            }
          }
          state = { owners: [], backup: '', applied: '', native: { status, index, base } }
          await this.save(state)
          if (!existing) {
            // Publish ownership before the first assignment. A setup failure
            // can then identify and reuse the reserved slot on its next try.
            await this.command('set-option', '@vargus_native_row', String(index))
            await this.command('set-option', `status-format[${index}]`, NATIVE_ROW)
          }
          if (base) {
            await this.command('set-option', '@vargus_original_left', base.left)
            await this.command('set-option', 'status-left', NATIVE_HEADER)
            await this.command('set-option', 'status-left-length', NATIVE_LEFT_LENGTH)
            await this.command('set-option', 'status-right-length', '0')
            await this.command('set-option', '@vargus_native_layout', base.sharedMark!)
          }
          await this.command('set-option', 'status', String(index + 1))
        } else {
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
      }
      try { this.owner.priorLine = await this.command('show-options', '-p', '-v', '-t', this.pane, '@vargus_line') } catch { /* unset */ }
      if (process.platform === 'win32') try { this.owner.priorHeader = await this.command('show-options', '-p', '-v', '-t', this.pane, '@vargus_header') } catch { /* unset */ }
      this.owner.inheritedMark = state.native?.base?.sharedMark
      state.owners.push(this.owner)
      await this.save(state)
      this.nativeBase = state.native?.base
      this.nativePublished.clear()
      this.attached = true
      await this.command('set-option', '-p', '-t', this.pane, '@vargus_owner', this.owner.token)
    })
  }

  async width(): Promise<number> {
    return Math.max(0, Number(await this.command('display-message', '-p', '-t', this.pane, '#{window_width}')) - TMUX_PADDING.length)
  }

  async update(ansi: string): Promise<void> {
    const changes: { pane?: string; option: string; value: string }[] = []
    // NativeBase is immutable for an attachment and captured under its lock.
    // A render must not read the shared JSON while another owner saves it.
    if (this.nativeBase?.sharedMark && await this.command('show-options', '-v', '@vargus_native_layout') !== this.nativeBase.sharedMark) this.nativeBase = undefined
    if (this.nativeBase && await this.nativeBarCommands(this.nativeBase.left)) await this.nativeAppendFallback()
    if (this.nativeBase) {
      const base = this.nativeBase
      const width = await this.width() + TMUX_PADDING.length
      const text = ansiRuns(ansi).map(run => run.text).join('')
      const line = tmuxLine(ansi) + ' '.repeat(Math.max(0, width - stringWidth(text) - (text ? TMUX_PADDING.length : 0)))
      changes.push({ pane: this.pane, option: '@vargus_header', value: line })
      const original = await this.command('display-message', '-p', base.template)
      changes.push({ pane: this.pane, option: '@vargus_line', value: original })
      if (base.sharedMark) {
        const activeWidth = Number(await this.command('display-message', '-p', '#{window_width}'))
        changes.push({ option: '@vargus_header', value: ' '.repeat(activeWidth) + base.sharedMark })
        changes.push({ option: '@vargus_line', value: original + base.sharedMark })
      }
    } else changes.push({ pane: this.pane, option: '@vargus_line', value: tmuxLine(ansi) })
    if (process.platform === 'win32') {
      await this.nativePublish(changes)
      return
    }
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
