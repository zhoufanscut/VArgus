import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { DATA_FOLDER, dataDir, homeDir } from '../hosts/claude/paths.ts'
import { isObject, readSettings, withSettingsLock, writeSettings } from './settings.ts'

const MARKETPLACE = 'vargus'
const PLUGIN = `vargus@${MARKETPLACE}`
const LINE = '/$CLAUDE_CODE_SESSION_ID/line'
const CHECKOUT = resolve(import.meta.dirname, '../..')
const LOCK_BUSY = 'Another VArgus setup is editing these Claude Code settings. Run the command again.'
const exec = promisify(execFile)

function reader(path: string): string {
  return `f="${path}"; if [ -s "$f" ] && { IFS= read -r d && [ "$(date +%s)" -ge "$d" ] && IFS= read -r row; } 2>/dev/null < "$f.live"; then printf %s "$row"; else cat "$f" 2>/dev/null; fi`
}

// Recognize the old generated commands so reinstall can replace them in place.
function legacyReader(path: string, legacyBlank: boolean): string {
  const keep = legacyBlank ? '[ -f "$f.blank" ] && [ ! -s "$f.blank" ]' : '[ ! -s "$f.blank" ]'
  return `f="${path}"; { ${keep} || [ -n "$(find "$f" -mmin -2 2>/dev/null)" ]; } && cat "$f" 2>/dev/null`
}

function isVargusReader(command: string): boolean {
  const path = /^(?:cat |f=)"((?:\\.|[^"\\\r\n])+)"/.exec(command)?.[1]
  if (!path?.endsWith(`/${DATA_FOLDER}${LINE}`)) return false
  return command === reader(path) || command === legacyReader(path, false) || command === legacyReader(path, true)
    || command === `cat "${path}" 2>/dev/null`
    || command === `f="${path}"; [ -n "$(find "$f" -mmin -2 2>/dev/null)" ] && cat "$f"`
}

function isVargusStatusLine(current: unknown): current is Record<string, unknown> & { command: string } {
  return isObject(current) && current.type === 'command' && typeof current.command === 'string' && isVargusReader(current.command.trim())
}

function nextStatusLine(settings: Record<string, unknown>, file: string, data: string) {
  const current = settings.statusLine
  if (current !== undefined && !isVargusStatusLine(current)) {
    throw new Error(`A different statusLine is configured in ${file}. Back it up and remove that entry before retrying.`)
  }
  const path = data.replace(/["\\$`]/g, '\\$&') + LINE
  const command = reader(path)
  if (current?.command === command) return undefined
  return { ...current, type: 'command', command, refreshInterval: 1 }
}

function resolveClaudePaths(): { config: string; data: string; path: string } {
  const env = process.env
  const home = homeDir(env.HOME, env.USERPROFILE)
  const config = env.CLAUDE_CONFIG_DIR || (home && join(home, '.claude'))
  const data = dataDir(config, home)
  if (!config || !isAbsolute(config) || !data) throw new Error('Set CLAUDE_CONFIG_DIR to an absolute path and retry.')
  return { config, data, path: join(config, 'settings.json') }
}

async function samePath(a: string, b: string): Promise<boolean> {
  const [ra, rb] = await Promise.all([realpath(a).catch(() => resolve(a)), realpath(b).catch(() => resolve(b))])
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb
}

async function claudePlugin(args: string[], cwd?: string): Promise<string> {
  const executable = process.platform === 'win32' ? 'claude.exe' : 'claude'
  try {
    // Claude can run npm ci when it caches the plugin. VArgus's lockfile is for development tools.
    const { stdout } = await exec(executable, ['plugin', ...args], {
      cwd, env: { ...process.env, NPM_CONFIG_OMIT: 'dev' }, timeout: 60000, windowsHide: true,
    })
    return stdout
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string }
    if (failure.code === 'ENOENT') throw new Error(`Claude Code was not found on PATH. Install ${executable} first.`)
    throw new Error(failure.stderr?.trim() || failure.message, { cause: error })
  }
}

async function claudePluginJson(args: string[], what: string): Promise<unknown[]> {
  const parsed: unknown = JSON.parse(await claudePlugin(args))
  if (!Array.isArray(parsed)) throw new Error(`Expected ${what} list from Claude Code.`)
  return parsed
}

export async function installClaude(): Promise<number> {
  const { data, path } = resolveClaudePaths()

  const { changed, existing } = await withSettingsLock(path, async file => {
    // Check for a custom reader before Claude changes the marketplace or plugin.
    nextStatusLine((await readSettings(file)).settings, path, data)
    const marketplaces = await claudePluginJson(['marketplace', 'list', '--json'], 'marketplace')
    const existing = marketplaces.some(marketplace => isObject(marketplace) && marketplace.name === MARKETPLACE)
    const source = existing ? [PLUGIN] : ['vargus', '--marketplace', CHECKOUT]
    await claudePlugin(['install', ...source, '--scope', 'user', '--json'])

    // The plugin command saves its own keys in settings.json.
    const { previous, settings } = await readSettings(file)
    const statusLine = nextStatusLine(settings, path, data)
    if (statusLine) await writeSettings(file, previous, { ...settings, statusLine })
    return { changed: !!statusLine, existing }
  }, LOCK_BUSY)

  if (existing) console.log('Used the existing vargus marketplace.')
  console.log(`VArgus status line ${changed ? 'configured' : 'already configured'} in ${path}. Run /reload-plugins or start a new Claude Code session.`)
  return 0
}

export async function removeClaude(): Promise<number> {
  const { config, path } = resolveClaudePaths()
  const configInfo = await lstat(config).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  })
  if (!configInfo) {
    console.log(`VArgus is not configured in ${path}.`)
    return 0
  }

  const { pluginRemoved, marketplace, statusLine } = await withSettingsLock(path, async file => {
    await readSettings(file)

    const plugins = await claudePluginJson(['list', '--json'], 'plugin')
    const userInstalled = plugins.some(entry => isObject(entry) && entry.id === PLUGIN && entry.scope === 'user')
    const otherMarketplacePlugins = plugins.some(entry =>
      isObject(entry) && typeof entry.id === 'string' && entry.id.endsWith(`@${MARKETPLACE}`)
      && !(entry.id === PLUGIN && entry.scope === 'user'))

    if (userInstalled) await claudePlugin(['uninstall', PLUGIN, '--scope', 'user', '--json'])

    const marketplaces = await claudePluginJson(['marketplace', 'list', '--json'], 'marketplace')
    const entry = marketplaces.find(item => isObject(item) && item.name === MARKETPLACE)
    const marketplacePath = isObject(entry) && typeof entry.path === 'string' && entry.path
      ? entry.path
      : isObject(entry) && typeof entry.installLocation === 'string' && entry.installLocation ? entry.installLocation : undefined
    const isCheckoutMarketplace = isObject(entry) && entry.source === 'directory'
      && Boolean(marketplacePath) && await samePath(marketplacePath!, CHECKOUT)

    let marketplace: 'absent' | 'removed' | 'kept-different' | 'kept-other-scope'
    if (!entry) marketplace = 'absent'
    else if (!isCheckoutMarketplace) marketplace = 'kept-different'
    else if (otherMarketplacePlugins) marketplace = 'kept-other-scope'
    else {
      // Omit --scope so Claude removes both known_marketplaces.json and user settings.json;
      // run from config so Claude does not touch an unrelated repo's .claude/settings.json.
      await claudePlugin(['marketplace', 'remove', MARKETPLACE, '--json'], config)
      marketplace = 'removed'
    }

    const { previous, settings } = await readSettings(file)
    let statusLine: 'absent' | 'removed' | 'kept-other'
    if (settings.statusLine === undefined) statusLine = 'absent'
    else if (isVargusStatusLine(settings.statusLine)) {
      const next = { ...settings }
      delete next.statusLine
      await writeSettings(file, previous, next)
      statusLine = 'removed'
    } else {
      statusLine = 'kept-other'
    }

    return { pluginRemoved: userInstalled, marketplace, statusLine }
  }, LOCK_BUSY)

  if (marketplace === 'kept-other-scope') {
    console.log('Kept the vargus marketplace because another scope still uses it.')
  } else if (marketplace === 'kept-different') {
    console.log('Kept the existing vargus marketplace (not registered from this checkout). Run `claude plugin marketplace remove vargus` to remove it.')
  }
  if (statusLine === 'kept-other') {
    console.log(`Left the existing non-VArgus statusLine in ${path} untouched.`)
  }
  console.log(pluginRemoved || marketplace === 'removed' || statusLine === 'removed'
    ? `VArgus removed from user scope in ${path}. Run /reload-plugins or start a new Claude Code session.`
    : `VArgus is not configured at user scope in ${path}.`)
  return 0
}
