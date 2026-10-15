// Control characters (C0, DEL, C1), ESC included, become `?` before colour
// codes go on: only the theme adds escapes (DESIGN, "Colours").
export function cleanText(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, '?')
}

// `~` for a `home` prefix of `cwd`; a home of `/` (or empty) never shortens.
export function shortenHome(cwd: string, home: string | undefined): string {
  const root = (home ?? '').replace(/\/+$/, '')
  if (root === '') return cwd
  return cwd === root || cwd.startsWith(root + '/') ? '~' + cwd.slice(root.length) : cwd
}
