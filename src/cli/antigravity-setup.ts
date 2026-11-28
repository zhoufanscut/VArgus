import { lstat } from 'node:fs/promises'
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

function readStatusLine(current: unknown, file: string): Record<string, unknown> & { type?: 'command'; command?: string } {
  const statusLine = current === undefined || typeof current === 'boolean' ? {} : current
  if (!isObject(statusLine)
    || (statusLine.type !== undefined && statusLine.type !== 'command')
    || (statusLine.command !== undefined && typeof statusLine.command !== 'string')) {
    throw new Error(`Expected a statusLine command object in ${file}.`)
  }
  return statusLine as Record<string, unknown> & { type?: 'command'; command?: string }
}

async function installStatusLine(file: string): Promise<boolean> {
  const { previous, settings } = await readSettings(file)

  // agy also accepts a boolean for the built-in status line.
  const statusLine = readStatusLine(settings.statusLine, file)
  if (statusLine.command?.trim()) {
    if (isVargusStatusLine(statusLine.command)) return false
    throw new Error(`A different statusLine command is configured in ${file}. Use /statusline in Antigravity CLI to change it.`)
  }

  settings.statusLine = { ...statusLine, type: 'command', command: 'vargus statusline', enabled: true }
  await writeSettings(file, previous, settings)
  return true
}

async function removeStatusLine(file: string): Promise<boolean> {
  const { previous, settings } = await readSettings(file)
  if (previous === undefined) return false

  const current = settings.statusLine
  if (current === undefined || typeof current === 'boolean') return false
  const statusLine = readStatusLine(current, file)
  if (typeof statusLine.command !== 'string' || !statusLine.command.trim()) return false
  if (!isVargusStatusLine(statusLine.command)) {
    throw new Error(`A different statusLine command is configured in ${file}. Use /statusline in Antigravity CLI to change it.`)
  }

  const next = { ...settings }
  delete next.statusLine
  await writeSettings(file, previous, next)
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

export async function removeAntigravity(path = join(homedir(), '.gemini', 'antigravity-cli', 'settings.json')): Promise<number> {
  const info = await lstat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  })
  if (!info) {
    console.log(`VArgus status line is not configured in ${path}.`)
    return 0
  }
  const removed = await withSettingsLock(path, removeStatusLine,
    'Another VArgus setup is editing these Antigravity CLI settings. Run the command again.')
  console.log(removed
    ? `VArgus status line removed from ${path}. Reopen Antigravity CLI to apply.`
    : `VArgus status line is not configured in ${path}.`)
  return 0
}
