import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import type { Target } from './target.ts'
import { applicationName, tmuxFields, splitTmuxFields } from './process.ts'

const exec = promisify(execFile)
export type PaneSnapshot = { lines: string[]; x: number; y: number; width: number; visible: boolean; command: string }
type NativeLayout = { type: string; id?: number; children?: NativeLayout[]; cursor_col?: number; cursor_row?: number;
  cols?: number; hide_cursor?: boolean; copy_mode?: boolean; view_offset?: number;
  rows_v2?: { runs: { text: string; flags: number }[] }[] }

function nativePane(tree: NativeLayout, id: number): NativeLayout | undefined {
  if (tree.type === 'leaf' && tree.id === id) return tree
  for (const child of tree.children ?? []) { const found = nativePane(child, id); if (found) return found }
}

// The host supplies its composer recognition. Never erase input, and recheck the
// complete inserted command before submitting: a changed draft must not be sent.
export class PaneInput {
  private target: Pick<Target, 'socket' | 'pane' | 'command'>
  constructor(target: Pick<Target, 'socket' | 'pane' | 'command'>) { this.target = target }
  private async tmux(...args: string[]) {
    return (await exec('tmux', ['-S', this.target.socket, ...args], { windowsHide: true, timeout: 5000 })).stdout
  }
  async snapshot(): Promise<PaneSnapshot> {
    if (process.platform === 'win32') {
      // psmux 3.4.0 hard-codes #{cursor_flag} to 0. Its window layout carries
      // the real cursor visibility, copy mode and styled cells atomically.
      const tree = (JSON.parse(await this.tmux('dump-state')) as { layout: NativeLayout }).layout
      const pane = nativePane(tree, Number(this.target.pane.slice(1)))
      // dump-state covers the active window. An inactive window must wait
      // for a visit before footer commands can be observed or delivered.
      if (!pane?.rows_v2) return { lines: [], x: 0, y: 0, width: 0, visible: false, command: 'unknown' }
      const lines = pane.rows_v2.map(row => row.runs.map(run => {
        const modifiers = [0, ...(run.flags & 1 ? [2] : []), ...(run.flags & 2 ? [1] : []), ...(run.flags & 16 ? [7] : [])]
        return `\x1b[${modifiers.join(';')}m${run.text}`
      }).join('').replace(/ +(?=(?:\x1b\[[0-9;]*m)*$)/g, '') + '\x1b[0m')
      return { lines, x: pane.cursor_col!, y: pane.cursor_row!, width: pane.cols!,
        visible: pane.hide_cursor === false && !pane.copy_mode && !pane.view_offset, command: this.target.command ?? 'unknown' }
    }
    const text = await this.tmux('capture-pane', '-p', '-e', '-t', this.target.pane, ';',
      'display-message', '-p', '-t', this.target.pane, tmuxFields('#{cursor_x}\t#{cursor_y}\t#{pane_width}\t#{cursor_flag}\t#{pane_current_command}'))
    const lines = text.trimEnd().split('\n')
    const [x, y, width, visible, command] = splitTmuxFields(lines.pop()!)
    return { lines, x: Number(x), y: Number(y), width: Number(width), visible: visible === '1', command: this.target.command ?? applicationName(command!) }
  }
  async submit(text: string, recognizes: (screen: PaneSnapshot, text: string) => boolean): Promise<PaneSnapshot> {
    let screen = await this.snapshot()
    if (!recognizes(screen, '')) throw new Error('Footer automation paused: Codex composer is not recognizably empty. Leave it empty and retry.')
    // Let a pending redraw settle before inserting anything.
    await delay(80)
    if (!recognizes(await this.snapshot(), '')) throw new Error('Footer automation paused: the composer changed. Leave it empty and retry.')
    if (text.length + 2 >= screen.width) throw new Error('Footer automation needs a wider pane for the saved layout. Widen it and retry.')
    await this.tmux('send-keys', '-l', '-t', this.target.pane, text)
    const until = Date.now() + 2000
    do {
      await delay(50)
      screen = await this.snapshot()
      if (recognizes(screen, text)) break
    } while (Date.now() < until)
    if (!recognizes(screen, text)) throw new Error('Footer automation paused: the composer changed after insertion. Inspect the draft; nothing was submitted.')
    await this.tmux('send-keys', '-t', this.target.pane, 'Enter')
    do {
      await delay(50)
      screen = await this.snapshot()
      if (recognizes(screen, '')) return screen
    } while (Date.now() < until)
    throw new Error('Footer command completion was not observed. Inspect Codex and retry with an empty composer.')
  }
}
