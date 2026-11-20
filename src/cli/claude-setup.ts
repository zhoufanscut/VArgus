import { execFile } from 'node:child_process'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { DATA_FOLDER, dataDir, homeDir } from '../hosts/claude/paths.ts'
import { isObject, readSettings, withSettingsLock, writeSettings } from './settings.ts'

const MARKETPLACE = 'vargus'
const PLUGIN = `vargus@${MARKETPLACE}`
const LINE = '/$CLAUDE_CODE_SESSION_ID/line'
const exec = promisify(execFile)

function reader(path: string, legacyBlank: boolean): string {
  const keep = legacyBlank ? '[ -f "$f.blank" ] && [ ! -s "$f.blank" ]' : '[ ! -s "$f.blank" ]'
  return `f="${path}"; { ${keep} || [ -n "$(find "$f" -mmin -2 2>/dev/null)" ]; } && cat "$f" 2>/dev/null`
}

function isVargusReader(command: string): boolean {
  const path = /^(?:cat |f=)"((?:\\.|[^"\\\r\n])+)"/.exec(command)?.[1]
  if (!path?.endsWith(`/${DATA_FOLDER}${LINE}`)) return false
  return command === reader(path, false) || command === reader(path, true)
    || command === `cat "${path}" 2>/dev/null`
    || command === `f="${path}"; [ -n "$(find "$f" -mmin -2 2>/dev/null)" ] && cat "$f"`
}

function nextStatusLine(settings: Record<string, unknown>, file: string, data: string) {
  const current = settings.statusLine
  if (current !== undefined && (!isObject(current) || current.type !== 'command'
    || typeof current.command !== 'string' || !isVargusReader(current.command.trim()))) {
    throw new Error(`A different statusLine is configured in ${file}. Back it up and remove that entry before retrying.`)
  }
  const plugins = settings.pluginConfigs as Record<string, { options?: { blankStopped?: boolean } }> | undefined
  const blank = plugins?.[PLUGIN]?.options?.blankStopped === true
  const command = reader(data.replace(/["\\$`]/g, '\\$&') + LINE, blank)
  if (current?.command === command) return undefined
  return { ...current, type: 'command', command, refreshInterval: 1 }
}

async function claudePlugin(args: string[]): Promise<string> {
  const executable = process.platform === 'win32' ? 'claude.exe' : 'claude'
  try {
    // Claude can run npm ci when it caches the plugin. VArgus's lockfile is for development tools.
    const { stdout } = await exec(executable, ['plugin', ...args], {
      env: { ...process.env, NPM_CONFIG_OMIT: 'dev' }, timeout: 60000, windowsHide: true,
    })
    return stdout
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string }
    if (failure.code === 'ENOENT') throw new Error(`Claude Code was not found on PATH. Install ${executable} first.`)
    throw new Error(failure.stderr?.trim() || failure.message, { cause: error })
  }
}

export async function installClaude(): Promise<number> {
  const env = process.env
  const home = homeDir(env.HOME, env.USERPROFILE)
  const config = env.CLAUDE_CONFIG_DIR || (home && join(home, '.claude'))
  const data = dataDir(config, home)
  if (!config || !isAbsolute(config) || !data) throw new Error('Set CLAUDE_CONFIG_DIR to an absolute path and retry.')
  const path = join(config, 'settings.json')

  const { changed, existing } = await withSettingsLock(path, async file => {
    // Check for a custom reader before Claude changes the marketplace or plugin.
    nextStatusLine((await readSettings(file)).settings, path, data)
    const marketplaces: { name: string }[] = JSON.parse(await claudePlugin(['marketplace', 'list', '--json']))
    const existing = marketplaces.some(marketplace => marketplace.name === MARKETPLACE)
    const source = existing ? [PLUGIN] : ['vargus', '--marketplace', resolve(import.meta.dirname, '../..')]
    await claudePlugin(['install', ...source, '--scope', 'user', '--json'])

    // The plugin command saves its own keys in settings.json.
    const { previous, settings } = await readSettings(file)
    const statusLine = nextStatusLine(settings, path, data)
    if (statusLine) await writeSettings(file, previous, { ...settings, statusLine })
    return { changed: !!statusLine, existing }
  }, 'Another VArgus setup is editing these Claude Code settings. Run the command again.')

  if (existing) console.log('Used the existing vargus marketplace.')
  console.log(`VArgus status line ${changed ? 'configured' : 'already configured'} in ${path}. Run /reload-plugins or start a new Claude Code session.`)
  return 0
}
