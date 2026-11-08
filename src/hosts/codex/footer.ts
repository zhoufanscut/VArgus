import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export type FooterSelection = string[] | null
// Codex c2bd770ca7, chatwidget.rs DEFAULT_STATUS_LINE_ITEMS; live-tested on 0.167.0.
const DEFAULT_ITEMS = ['model-with-reasoning', 'current-dir', 'thread-name']
export const clearFooter = '/statusline --clear'
export function restoreFooter(items: FooterSelection): string {
  const selection = items ?? DEFAULT_ITEMS
  if (!selection.every(item => /^[a-z][a-z0-9-]*$/.test(item))) throw new Error('Saved Codex footer contains unsupported item names; restore it through /statusline.')
  return selection.length ? '/statusline ' + selection.join(' ') : clearFooter
}

// Read effective saved layers through Codex's own parser. No config write, thread
// creation, model request, or dependence on a second TOML parser.
export async function savedFooter(cwd: string): Promise<FooterSelection> {
  const child = spawn('codex', ['app-server', '--stdio'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = createInterface({ input: child.stdout })
  let errors = ''
  child.stderr.on('data', data => { errors = (errors + String(data)).slice(-1000) })
  try {
    return await new Promise<FooterSelection>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Reading saved Codex footer timed out.')), 8000)
      const fail = (error: Error) => { clearTimeout(timer); reject(error) }
      child.once('error', fail)
      child.once('exit', () => fail(new Error('Could not read saved Codex footer. ' + errors)))
      const send = (id: number, method: string, params: unknown) => child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
      child.stdin.on('error', fail)
      lines.on('line', line => {
        let reply: any
        try { reply = JSON.parse(line) } catch { return }
        if (reply.error) return fail(new Error(`Codex footer config read: ${reply.error.message}`))
        if (reply.id === 1) send(2, 'config/read', { includeLayers: false, cwd })
        if (reply.id === 2) {
          const items = reply.result?.config?.tui?.status_line ?? null
          if (items !== null && (!Array.isArray(items) || !items.every(item => typeof item === 'string'))) return fail(new Error('Codex returned an unsupported footer configuration.'))
          clearTimeout(timer); resolve(items)
        }
      })
      send(1, 'initialize', { clientInfo: { name: 'vargus-footer', version: '0.1.0' } })
    })
  } finally {
    lines.close()
    child.kill('SIGTERM')
  }
}

const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, '')
// Deliberately version-specific and fail-closed. Cursor position plus dimmed
// placeholder distinguishes an empty composer from a draft containing its words.
export function codexComposer(screen: { lines: string[]; x: number; y: number; visible: boolean; command: string }, text: string): boolean {
  if (!screen.visible || screen.command !== 'codex' || screen.x !== 2 + text.length) return false
  const line = screen.lines[screen.y] ?? ''
  const content = plain(line)
  if (text) return content.slice(2) === text && content.length === text.length + 2
  return content.slice(2) === 'Ask Codex to do anything' && /\x1b\[(?:[0-9]+;)*2mAsk Codex to do anything/.test(line)
    && !screen.lines.slice(Math.max(0, screen.y - 3), screen.y).some(line => /Image #\d|\[Pasted Content/.test(plain(line)))
}

export function footerCommandError(lines: string[]): boolean {
  return lines.some(line => /Unknown status-line item|Cannot combine --clear|Unrecognized.*statusline/.test(plain(line)))
}
