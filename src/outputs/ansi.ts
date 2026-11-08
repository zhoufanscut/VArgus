// The shared renderer emits this small SGR vocabulary. Other displays decode it
// here rather than interpreting terminal escapes or copying fragment logic.
export type Run = { text: string; color?: string; bold: boolean }

export function ansiRuns(line: string): Run[] {
  const runs: Run[] = []
  let color: string | undefined
  let bold = false
  let at = 0
  for (const match of line.matchAll(/\x1b\[([0-9;]*)m/g)) {
    if (match.index > at) runs.push({ text: line.slice(at, match.index), color, bold })
    const codes = match[1]!.split(';').map(Number)
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]
      if (c === 0) { color = undefined; bold = false }
      else if (c === 1) bold = true
      else if (c === 22) bold = false
      else if (c === 39) color = undefined
      else if (c === 38 && codes[i + 1] === 2) {
        color = '#' + codes.slice(i + 2, i + 5).map(n => n.toString(16).padStart(2, '0')).join('')
        i += 4
      }
    }
    at = match.index + match[0].length
  }
  if (at < line.length) runs.push({ text: line.slice(at), color, bold })
  return runs
}
