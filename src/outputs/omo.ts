import { ansiRuns } from './ansi.ts'
import { stringWidth } from '../render/width.ts'

type Component = {
  render(width: number): string[]
  invalidate(): void
}

export type OmoUi = {
  setWidget(key: string, factory: ((tui: { requestRender(): void }) => Component) | undefined,
    options?: { placement: 'belowEditor' }): void
  setFooter(factory: (() => Component) | undefined): void
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

// The composer drops whole fragments, but its last fragment can still exceed
// the viewport. Clip only at this display boundary, retaining complete glyphs.
export function clipOmoLine(line: string, columns: number): string {
  if (columns <= 0) return ''
  if (stringWidth(line) <= columns) return line
  let out = ''
  let used = 0
  for (const run of ansiRuns(line)) {
    let text = ''
    let clipped = false
    for (const { segment } of graphemes.segment(run.text)) {
      const width = stringWidth(segment)
      if (used + width > columns) { clipped = true; break }
      used += width
      text += segment
    }
    if (text) {
      if (run.bold) out += '\x1b[1m'
      if (run.color) {
        const color = run.color
        const rgb = [1, 3, 5].map(at => Number.parseInt(color.slice(at, at + 2), 16))
        out += `\x1b[38;2;${rgb.join(';')}m`
      }
      out += text
      if (run.bold || run.color) out += '\x1b[0m'
    }
    if (clipped) break
  }
  return out
}

export function mountOmo(ui: OmoUi, line: (width: number) => string): {
  refresh(): void
  dispose(): void
} {
  let requestRender = () => {}
  let disposed = false
  ui.setFooter(() => ({ render: () => [], invalidate() {} }))
  ui.setWidget('vargus', tui => {
    requestRender = () => tui.requestRender()
    return {
      invalidate() {},
      render(width) {
        if (disposed) return []
        const columns = Math.max(0, width - 2)
        const text = clipOmoLine(line(columns), columns)
        return [text ? '  ' + text : '']
      },
    }
  }, { placement: 'belowEditor' })
  return {
    refresh() { if (!disposed) requestRender() },
    dispose() {
      if (disposed) return
      disposed = true
      ui.setWidget('vargus', undefined)
      ui.setFooter(undefined)
    },
  }
}
