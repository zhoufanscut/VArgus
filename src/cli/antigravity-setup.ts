import { homedir } from 'node:os'
import { join } from 'node:path'
import { isObject, readSettings, withSettingsLock, writeSettings } from './settings.ts'

const COMMAND_WORD = String.raw`(?:"(?:\\.|[^"\\\r\n])*"|'[^'\r\n]*'|[^\s"';&|<>()]+)`
const INVOCATION = new RegExp(String.raw`^(${COMMAND_WORD})[ \t]+statusline(?:[ \t]+--(?:config|theme)[ \t]+${COMMAND_WORD})*$`)

function isVargusStatusLine(command: string): boolean {
  const invocation = INVOCATION.exec(command.trim())
  const launcher = invocation?.[1]?.replace(/^["']|["']$/g, '').split(/[\\/]/).at(-1)?.toLowerCase()
  return launcher === 'vargus' || launcher === 'vargus.cmd'
}

async function installStatusLine(file: string): Promise<boolean> {
  const { previous, settings } = await readSettings(file)

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
  await writeSettings(file, previous, settings)
  return true
}

export async function installAntigravity(path = join(homedir(), '.gemini', 'antigravity-cli', 'settings.json')): Promise<number> {
  const installed = await withSettingsLock(path, installStatusLine,
    'Another VArgus setup is editing these Antigravity CLI settings. Run the command again.')
  console.log(installed
    ? `VArgus status line installed in ${path}. Open or reopen Antigravity CLI to load it.`
    : `VArgus status line is already configured in ${path}.`)
  return 0
}
