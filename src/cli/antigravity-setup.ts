import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { withControlLock } from './lock.ts'

const COMMAND_WORD = String.raw`(?:"(?:\\.|[^"\\\r\n])*"|'[^'\r\n]*'|[^\s"';&|<>()]+)`
const INVOCATION = new RegExp(String.raw`^(${COMMAND_WORD})[ \t]+statusline(?:[ \t]+--(?:config|theme)[ \t]+${COMMAND_WORD})*$`)

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isVargusStatusLine(command: string): boolean {
  const invocation = INVOCATION.exec(command.trim())
  const launcher = invocation?.[1]?.replace(/^["']|["']$/g, '').split(/[\\/]/).at(-1)?.toLowerCase()
  return launcher === 'vargus' || launcher === 'vargus.cmd'
}

function allowMissing(error: NodeJS.ErrnoException): undefined {
  if (error.code !== 'ENOENT') throw error
}

async function installStatusLine(file: string): Promise<boolean> {
  const previous = await readFile(file, 'utf8').catch(allowMissing)
  let settings: unknown = {}
  if (previous !== undefined) {
    try { settings = JSON.parse(previous) }
    catch (error) { throw new Error(`Could not parse JSON in ${file}.`, { cause: error }) }
  }
  if (!isObject(settings)) throw new Error(`Expected a JSON settings object in ${file}.`)

  // agy also accepts a boolean for the built-in status line.
  const current = settings.statusLine
  const statusLine = current === undefined || typeof current === 'boolean' ? {} : current
  if (!isObject(statusLine)
    || (statusLine.type !== undefined && statusLine.type !== 'command')
    || (statusLine.command !== undefined && typeof statusLine.command !== 'string')) {
    throw new Error(`Expected a statusLine command object in ${file}.`)
  }
  if (statusLine.command?.trim()) {
    if (isVargusStatusLine(statusLine.command)) return false
    throw new Error(`A different statusLine command is configured in ${file}. Use /statusline in Antigravity CLI to change it.`)
  }

  settings.statusLine = { ...statusLine, type: 'command', command: 'vargus statusline', enabled: true }
  const temporary = `${file}.${randomUUID()}.tmp`
  const mode = previous === undefined ? 0o600 : (await stat(file)).mode & 0o777
  try {
    await writeFile(temporary, JSON.stringify(settings, null, 2) + '\n', { flag: 'wx', mode })
    if (await readFile(file, 'utf8').catch(allowMissing) !== previous) {
      throw new Error(`${file} changed during setup. Run the command again.`)
    }
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
  return true
}

export async function installAntigravity(path = join(homedir(), '.gemini', 'antigravity-cli', 'settings.json')): Promise<number> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const info = await lstat(path).catch(allowMissing)
  const file = info?.isSymbolicLink() ? await realpath(path) : path
  const installed = await withControlLock(file + '.vargus.lock', () => installStatusLine(file),
    'Another VArgus setup is editing these Antigravity CLI settings. Run the command again.')
  console.log(installed
    ? `VArgus status line installed in ${path}. Open or reopen Antigravity CLI to load it.`
    : `VArgus status line is already configured in ${path}.`)
  return 0
}
