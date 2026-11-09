import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import type { Target } from './target'

const exec = promisify(execFile)
export type PaneSnapshot = { lines: string[]; x: number; y: number; width: number; visible: boolean; command: string }

// The host supplies its composer recognition. Never erase input, and recheck the
// complete inserted command before submitting: a changed draft must not be sent.
export class PaneInput {
  constructor(private target: Pick<Target, 'socket' | 'pane'>) {}
  private async tmux(...args: string[]) {
    return (await exec('tmux', ['-S', this.target.socket, ...args], { timeout: 5000 })).stdout
  }
  async snapshot(): Promise<PaneSnapshot> {
    const text = await this.tmux('capture-pane', '-p', '-e', '-t', this.target.pane, ';',
      'display-message', '-p', '-t', this.target.pane, '#{cursor_x}\t#{cursor_y}\t#{pane_width}\t#{cursor_flag}\t#{pane_current_command}')
    const lines = text.trimEnd().split('\n')
    const [x, y, width, visible, command] = lines.pop()!.split('\t')
    return { lines, x: Number(x), y: Number(y), width: Number(width), visible: visible === '1', command: command! }
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
