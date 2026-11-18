import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withControlLock } from './lock.ts'
import { startupDirectory } from './startup.ts'

type Callback = { type: string; command?: string; commandWindows?: string; command_windows?: string }
type Group = { hooks?: Callback[]; matcher?: string }
type HookFile = { hooks?: Record<string, Group[]> }

const HELP = `Usage:
  vargus install codex [--home CODEX_HOME]
  vargus remove codex [--home CODEX_HOME]`
const EVENTS = [
  { name: 'SessionStart', hook: 'session-start', matcher: '^(startup|resume|clear|fork)$' },
  { name: 'UserPromptSubmit', hook: 'prompt', matcher: undefined },
] as const

// Match the installed command and the direct launcher forms in older guides,
// including options after the hook name. Shell wrappers can be edited by hand.
const WORD = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^\s"';&|<>()]+)`
const INVOCATION = new RegExp(String.raw`^\s*(?:&\s+)?(${WORD})\s+hook\s+(session-start|prompt)(?:\s+--(?:config|socket|pane|theme)\s+${WORD})*\s*$`)

function isVargus(callback: Callback, hook: string): boolean {
  if (callback.type !== 'command' || typeof callback.command !== 'string') return false
  const commands = [callback.command, callback.commandWindows ?? callback.command_windows]
  return commands.every(command => {
    if (command === undefined) return true
    const match = INVOCATION.exec(command)
    const launcher = match?.[1]?.replace(/^['"]|['"]$/g, '').split(/[\\/]/).at(-1)?.toLowerCase()
    return match?.[2] === hook && (launcher === 'vargus' || launcher === 'vargus.cmd')
  })
}

function hookCommand(hook: string): string {
  const windows = process.platform === 'win32'
  const entry = fileURLToPath(new URL(windows ? '../../bin/vargus.cmd' : '../../bin/vargus', import.meta.url))
  const launcher = windows ? `& '${entry.replaceAll("'", "''")}'` : `"${entry.replace(/["\\$`]/g, '\\$&')}"`
  return `${launcher} hook ${hook}`
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

async function readHooks(file: string): Promise<string | undefined> {
  try { return await readFile(file, 'utf8') } catch (error) { if (!isMissing(error)) throw error }
}

async function changeHooks(file: string, install: boolean): Promise<void> {
  const previous = await readHooks(file)
  if (previous === undefined && !install) return
  const document: HookFile = previous === undefined ? {} : JSON.parse(previous)
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`Expected a hooks object in ${file}.`)
  }
  const hooks = document.hooks === undefined ? {} : document.hooks
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) throw new Error(`Expected a hooks object in ${file}.`)
  let changed = false
  for (const { name, hook, matcher } of EVENTS) {
    const groups = hooks[name] ?? []
    if (install) {
      if (groups.some(group => group.hooks?.some(callback => isVargus(callback, hook)))) continue
      const callback = { type: 'command', command: hookCommand(hook), async: true, timeout: 30 }
      hooks[name] = [...groups, { matcher, hooks: [callback] }]
      changed = true
    } else {
      const remaining = groups.flatMap((group, index) => {
        const callbacks = group.hooks
        if (!callbacks) return [group]
        const kept = callbacks.filter(callback => !isVargus(callback, hook))
        if (kept.length === callbacks.length) return [group]
        if (kept.some((callback, position) => callback !== callbacks[position])) {
          throw new Error(`Removing VArgus from ${name} in ${file} would move other callbacks. Remove its callback manually and review that group in Codex's /hooks.`)
        }
        changed = true
        // Following groups keep their indices in Codex's hook trust keys.
        return kept.length || index < groups.length - 1 ? [{ ...group, hooks: kept }] : []
      })
      if (remaining.length) hooks[name] = remaining
      else if (groups.length) delete hooks[name]
    }
  }
  if (!changed) return
  const temporary = file + '.' + randomUUID() + '.tmp'
  const mode = previous === undefined ? 0o600 : (await stat(file)).mode & 0o777
  try {
    await writeFile(temporary, JSON.stringify({ ...document, hooks }, null, 2) + '\n', { flag: 'wx', mode })
    if (await readHooks(file) !== previous) throw new Error(`${file} changed during setup. Run the command again.`)
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function codexSetup(argv: string[]): Promise<number> {
  const [action, flag, directory] = argv
  if ((action !== 'install' && action !== 'remove')
    || (argv.length !== 1 && !(argv.length === 3 && flag === '--home' && directory))) {
    throw new Error(HELP)
  }
  const home = resolve(directory ?? (process.env.CODEX_HOME || join(homedir(), '.codex')))
  const install = action === 'install'
  if (install) await mkdir(home, { recursive: true, mode: 0o700 })
  const path = join(home, 'hooks.json')
  const info = await lstat(path).catch(error => {
    if (!isMissing(error)) throw error
  })
  if (install || info) {
    const file = info?.isSymbolicLink() ? await realpath(path) : path
    await withControlLock(file + '.vargus.lock', async () => {
      if (install) await mkdir(startupDirectory(home), { recursive: true, mode: 0o700 })
      await changeHooks(file, install)
    }, 'Another VArgus setup is editing these Codex hooks. Run the command again.')
  }
  console.log(install
    ? `VArgus startup hooks are set up in ${path}. Select Thread ID in Codex and review the callbacks in /hooks.`
    : `VArgus startup hooks removed from ${path}. Run !vargus off in affected sessions and close them to reload hooks.`)
  return 0
}
