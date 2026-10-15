import type { EngineInterface, Register, Timer } from 'claude-code'

import { render, type Values } from '../src/render'
import { createWriter, writeLine, type Writer } from '../src/write'

// Wiring only. Module values start over on a hot reload, which runs
// register and session.start again (DESIGN, "The host").
let writer: Writer | null = null
let tick: Timer | null = null
const values: Values = { cwd: '', home: undefined }

async function refresh($: EngineInterface): Promise<void> {
  if (!writer) return
  values.cwd = await $.session.cwd()
  await writeLine($, writer, render(values))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Only an interactive session shows a status line (DESIGN, "When the line is written").
    if (e.isInteractive) {
      writer = await createWriter($)
      values.home = await $.env.get('HOME')
      tick?.cancel()
      tick = $.clock.every(1000, () => {
        refresh($).catch(() => {})
      })
      // Not awaited: the first session.start is awaited before the first
      // prompt, and a slow or refused write must not hold it.
      refresh($).catch(() => {})
    }
    return next(e)
  })
}
