export function fixtureFsPath(path: string, style: 'posix' | 'drive' = 'posix'): string {
  const drive = path.search(style === 'posix' ? /^[A-Za-z]:[\\/]/ : /(?<=^|[\\/])[A-Za-z]:[\\/]/)
  if (drive < 0) return path
  return path.slice(drive + (style === 'posix' ? 2 : 0)).replace(/\\/g, '/')
}
