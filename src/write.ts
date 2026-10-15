import type { EngineInterface } from 'claude-code'

// The line file (DESIGN, "The line file"): <data>/<session id>/line, replaced
// whole by a temp file and `mv`, so the reader's `cat` sees a whole line.

// The plugin's data folder name: plugin `vargus` from marketplace `vargus`.
export const DATA_FOLDER = 'vargus-vargus'

export type Writer = {
  // <data>, absolute; null when the config folder is not an absolute path
  // (CLAUDE_CONFIG_DIR relative, or it and HOME unset), so nothing is
  // written outside the data folder.
  dir: string | null
  // line.<t>.tmp: one temp file per loaded copy of the mod.
  tmpName: string
  last: { id: string; text: string } | null
  busy: boolean
  pending: string | null
}

export async function createWriter($: EngineInterface): Promise<Writer> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = await $.env.get('HOME')
  const base = config || (home ? `${home}/.claude` : '')
  return {
    dir: base.startsWith('/') ? `${base}/plugins/data/${DATA_FOLDER}` : null,
    tmpName: `line.${await $.clock.now()}.tmp`,
    last: null,
    busy: false,
    pending: null,
  }
}

// Writes `text` unless it and the session id match the last write. One write
// runs at a time; a newer text waiting replaces an older one. The id is read
// on every write: /clear and a resume change it with no session.start.
export async function writeLine($: EngineInterface, w: Writer, text: string): Promise<void> {
  w.pending = text
  if (w.busy) return
  w.busy = true
  try {
    while (w.pending !== null) {
      const next = w.pending
      w.pending = null
      const id = await $.session.id()
      if (!w.dir || !id || (w.last?.id === id && w.last.text === next)) continue
      const folder = `${w.dir}/${id}`
      const line = `${folder}/line`
      const tmp = `${folder}/${w.tmpName}`
      await $.fs.write(tmp, next)
      let moved = false
      try {
        moved = (await $.process.run(['mv', '-f', tmp, line])).exitCode === 0
      } catch {
        // refused (an organization hook, say): fall back below
      }
      // Not atomic: a read can catch a half-written line for one run.
      if (!moved) await $.fs.write(line, next)
      w.last = { id, text: next }
    }
  } finally {
    w.busy = false
  }
}
