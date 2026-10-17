// Control characters (C0, DEL, C1), ESC included, become `?` before colour
// codes go on: only the theme adds escapes (DESIGN, "Colours").
export function cleanText(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, '?')
}

// `~` for a `home` prefix of `cwd`; a home of `/` (or empty) never shortens.
// In a Windows drive path (`C:\...`) `\` separates too; the rest of the path
// keeps its own.
export function shortenHome(cwd: string, home: string | undefined): string {
  const drive = /^[A-Za-z]:/.test(home ?? '')
  const root = (home ?? '').replace(drive ? /[\\/]+$/ : /\/+$/, '')
  if (root === '') return cwd
  const next = cwd[root.length]
  return cwd.startsWith(root) && (next === undefined || next === '/' || (drive && next === '\\'))
    ? '~' + cwd.slice(root.length)
    : cwd
}
