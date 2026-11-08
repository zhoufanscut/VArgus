

// The line file (DESIGN, "The line file"): <data>/<session id>/line, replaced
// whole by a temp file and `mv`, so the reader's `cat` sees a whole line. The
// session's folder is removed when the session ends. On Windows `move` and
// `rmdir` through cmd.exe stand in for `mv` and `rm` (see moveArgv).

// The plugin's data folder name: plugin `vargus` from marketplace `vargus`.
export const DATA_FOLDER = 'vargus-vargus'


export const DRIVE_PATH = /^[A-Za-z]:[\\/]/


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
