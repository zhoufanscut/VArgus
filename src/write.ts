import type { EngineInterface } from 'claude-code'

// The line file (DESIGN, "The line file"): <data>/<session id>/line, replaced
// whole by a temp file and `mv`, so the reader's `cat` sees a whole line. The
// session's folder is removed when the session ends. On Windows `move` and
// `rmdir` through cmd.exe stand in for `mv` and `rm` (see moveArgv).

// The plugin's data folder name: plugin `vargus` from marketplace `vargus`.
export const DATA_FOLDER = 'vargus-vargus'

export type Writer = {
  // <data>, absolute, with `/` separators; null when the config folder is
  // not an absolute path (CLAUDE_CONFIG_DIR relative, or it, HOME and
  // USERPROFILE unset), so nothing is written outside the data folder.
  // Absolute is `/...`, or `C:\...` / `C:/...` on Windows (on Linux and
  // macOS a drive path comes only from a CLAUDE_CONFIG_DIR or HOME set to
  // one, or a drive-path USERPROFILE with HOME unset or not a `/` path).
  dir: string | null
  // how the line is moved into place and folders removed: `mv` and `rm`, or
  // on Windows (a drive-letter data folder) cmd.exe
  tools: 'posix' | 'cmd'
  // line.<t>.tmp: one temp file per loaded copy of the mod.
  tmpName: string
  last: { id: string; text: string; at: number } | null
  // with blankStopped: rewrite an unchanged line this often, so the reader
  // can tell a stopped mod by the file's age; null: only on a change
  heartbeatMs: number | null
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

const DRIVE_PATH = /^[A-Za-z]:[\\/]/

// The home folder Claude Code keeps `.claude` in. On Windows that is
// USERPROFILE whatever HOME says (measured with HOME set to another folder:
// Claude Code read C:\Users\<name>\.claude, while a mod that took HOME wrote
// where no reader looked). Windows here: USERPROFILE a drive path and HOME
// not a `/` path, since WSL can pass the Windows USERPROFILE through
// unchanged (WSLENV) beside its own HOME. Else HOME, then USERPROFILE.
export function homeDir(home: string | undefined, profile: string | undefined): string | undefined {
  const windows = !!profile && DRIVE_PATH.test(profile) && !home?.startsWith('/')
  return (windows ? profile : home || profile) || undefined
}

// The data folder from CLAUDE_CONFIG_DIR, else <home>/.claude (Writer.dir).
export function dataDir(config: string | undefined, home: string | undefined): string | null {
  const base = config || (home ? `${DRIVE_PATH.test(home) ? home.replace(/[\\/]+$/, '') : home}/.claude` : '')
  const drive = DRIVE_PATH.test(base)
  if (!base.startsWith('/') && !drive) return null
  return `${(drive ? base.replace(/\\/g, '/') : base).replace(/\/+$/, '')}/plugins/data/${DATA_FOLDER}`
}

export async function createWriter($: EngineInterface): Promise<Writer> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  const dir = dataDir(config, homeDir(await $.env.get('HOME'), await $.env.get('USERPROFILE')))
  return {
    dir,
    tools: dir !== null && DRIVE_PATH.test(dir) ? 'cmd' : 'posix',
    tmpName: `line.${await $.clock.now()}.tmp`,
    last: null,
    heartbeatMs: null,
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
  const argv = removeArgv(w, `${w.dir}/${id}`)
  if (argv) await $.process.run(argv)
  if (w.last?.id === id) w.last = null
}

// A folder whose newest file is older than this was left by a session that
// ended without session.end (a crash, kill -9): VantageHUD's age.
export const PRUNE_AFTER_MS = 14 * 24 * 3_600_000

// At session.start: remove such folders. Only folders named like a session id,
// never the current session's, never through a link. Idle by the newest file
// in the folder (the line or a temp file), else the folder's own time. A
// session still open whose line has not changed for 14 days loses its file
// until its text next changes.
export async function pruneOld($: EngineInterface, w: Writer, now: number): Promise<void> {
  if (!w.dir) return
  const current = await $.session.id()
  const entries = await $.fs.list(w.dir).catch(() => [])
  for (const e of entries) {
    if (e.kind !== 'dir' || e.isLink || !SAFE_ID.test(e.name) || e.name === current) continue
    const folder = `${w.dir}/${e.name}`
    const files = await $.fs.list(folder).catch(() => null)
    if (!files) continue
    const newest = Math.max(0, ...files.filter(f => f.kind === 'file').map(f => f.mtimeMs))
    const at = newest || (await $.fs.stat(folder).catch(() => null))?.mtimeMs
    if (at === undefined || now - at < PRUNE_AFTER_MS) continue
    const argv = removeArgv(w, folder)
    if (argv) await $.process.run(argv).catch(() => {})
  }
}

// On Windows `mv` and `rm` are found only when Git's usr\bin is on the PATH
// Claude Code started with: from Git Bash it is, from PowerShell it is not
// (measured on Windows 11, Git 2.56.0: the line written in place, a .tmp left,
// folders kept). cmd.exe is always there; `/d` skips its AutoRun commands, and
// it takes `\` separators (about 20 ms a move, measured). cmd is never given
// a path with a character it acts on: the runtime quotes only arguments with
// a space, so cmd splits at `&` (measured: `a&b.tmp` ran `b.tmp` as a command)
// and `rmdir /s /q D:\R&D\...` would remove D:\R; `,` `;` `=` separate its
// arguments, `^` escapes, `%` and `!` expand. For such a path there is no
// command (null): the line is written in place, nothing is removed.
const CMD_UNSAFE = /[&^%!,;=()"<>|]/

export function moveArgv(w: Pick<Writer, 'tools'>, from: string, to: string): string[] | null {
  if (w.tools === 'posix') return ['mv', '-f', from, to]
  return CMD_UNSAFE.test(from + to) ? null : ['cmd', '/d', '/c', 'move', '/y', backslash(from), backslash(to)]
}

export function removeArgv(w: Pick<Writer, 'tools'>, folder: string): string[] | null {
  if (w.tools === 'posix') return ['rm', '-rf', '--', folder]
  return CMD_UNSAFE.test(folder) ? null : ['cmd', '/d', '/c', 'rmdir', '/s', '/q', backslash(folder)]
}

function backslash(path: string): string {
  return path.replace(/\//g, '\\')
}

async function drain($: EngineInterface, w: Writer): Promise<void> {
  while (w.pending !== null) {
    const next = w.pending
    w.pending = null
    const id = await $.session.id()
    if (!w.dir || !id || id === w.ended) continue
    const now = w.heartbeatMs === null ? 0 : await $.clock.now()
    const same = w.last?.id === id && w.last.text === next
    if (same && (w.heartbeatMs === null || now - w.last!.at < w.heartbeatMs)) continue
    const folder = `${w.dir}/${id}`
    const line = `${folder}/line`
    const tmp = `${folder}/${w.tmpName}`
    const argv = moveArgv(w, tmp, line)
    let moved = false
    // no command to move with: no temp file either
    if (argv) {
      await $.fs.write(tmp, next)
      try {
        moved = (await $.process.run(argv)).exitCode === 0
      } catch {
        // refused (an organization hook, say): fall back below
      }
    }
    // Not atomic: a read can catch a half-written line for one run.
    if (!moved) await $.fs.write(line, next)
    w.last = { id, text: next, at: now }
  }
}
