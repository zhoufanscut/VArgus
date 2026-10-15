import type { EngineInterface } from 'claude-code'

// The line file (DESIGN, "The line file"): <data>/<session id>/line, replaced
// whole by a temp file and `mv`, so the reader's `cat` sees a whole line. The
// session's folder is removed when the session ends.

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
  // the write loop while it runs
  running: Promise<void> | null
  pending: string | null
  // the id of the session that ended, written no more while $.session.id()
  // still gives it (0.75 s after the one resume measured), until another
  // session ends in this process; a resume back to it ends the session in
  // between, which takes its place here
  ended: string | null
}

// A session id as a folder name: no `/`, `.` or `..`.
const SAFE_ID = /^[A-Za-z0-9_-]+$/

export async function createWriter($: EngineInterface): Promise<Writer> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = await $.env.get('HOME')
  const base = config || (home ? `${home}/.claude` : '')
  return {
    dir: base.startsWith('/') ? `${base}/plugins/data/${DATA_FOLDER}` : null,
    tmpName: `line.${await $.clock.now()}.tmp`,
    last: null,
    running: null,
    pending: null,
    ended: null,
  }
}

// Writes `text` unless it and the session id match the last write, or the id
// is the ended session's. One write runs at a time; a newer text waiting
// replaces an older one. The id is read on every write: /clear and a resume
// change it with no session.start.
export function writeLine($: EngineInterface, w: Writer, text: string): Promise<void> {
  w.pending = text
  if (!w.running) {
    w.running = drain($, w).finally(() => {
      w.running = null
      // a text still waiting when the loop ended: it came in after the last
      // check, or its write failed (tried once more)
      if (w.pending !== null) writeLine($, w, w.pending).catch(() => {})
    })
  }
  return w.running
}

// At session.end: stop writing for `id`, let a write in flight finish, then
// remove the session's folder (`$.fs` has no delete). Another process on the
// same session (a resume in a second window) loses its line until its text
// next changes.
export async function endSession($: EngineInterface, w: Writer, id: string): Promise<void> {
  w.ended = id
  await w.running?.catch(() => {})
  if (!w.dir || !SAFE_ID.test(id)) return
  await $.process.run(['rm', '-rf', '--', `${w.dir}/${id}`])
  if (w.last?.id === id) w.last = null
}

async function drain($: EngineInterface, w: Writer): Promise<void> {
  while (w.pending !== null) {
    const next = w.pending
    w.pending = null
    const id = await $.session.id()
    if (!w.dir || !id || id === w.ended || (w.last?.id === id && w.last.text === next)) continue
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
}
