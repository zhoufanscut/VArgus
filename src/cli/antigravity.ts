import { homedir } from 'node:os'
import { staleLine, staleParts } from '../render/freshness.ts'
import { cachePath, defaultCacheDir, readCache, writeCache } from '../hosts/antigravity/cache.ts'
import { collectAntigravityPayload, type AntigravityPayload } from '../hosts/antigravity/collect.ts'
import { antigravityDisplay } from '../hosts/antigravity/display.ts'
import { updateAntigravityRate } from '../hosts/antigravity/rate.ts'
import { collectAntigravitySubagentCounts } from '../hosts/antigravity/subagents.ts'
import { collectDeclaredSkillRoots, readTranscriptState, resolveConversationId, resolveTranscriptPath } from '../hosts/antigravity/transcript.ts'
import { readCachedVcs } from '../hosts/antigravity/vcs.ts'
import { resolveLabels } from '../i18n/index.ts'
import { readCheckoutOptionsSafe, readOptionsFile } from '../node/options.ts'
import { detectWsl } from '../node/wsl.ts'
import { mergeOptionLayers, resolveOptions } from '../options.ts'
import { configErrorLine, joinParts, renderParts } from '../render/index.ts'
import { makeTheme } from '../theme/index.ts'

export const ANTIGRAVITY_THEME = 'agy-tokyonight'
export const STATUSLINE_PADDING = '  '

type CachedRow = { version: 2; parts: string[] }

function isCachedRow(value: unknown): value is CachedRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (value as { version?: unknown }).version === 2
    && Array.isArray((value as { parts?: unknown }).parts)
    && (value as { parts: unknown[] }).parts.every(part => typeof part === 'string')
}

function sameParts(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((part, i) => part === b[i])
}

export type StatuslineRuntime = {
  givenOptions?: Record<string, unknown>
  configError?: unknown
  home?: string
  appDataDir?: string
  isWsl?: boolean
  noColor?: boolean
  cacheDir?: string
  now?: number
  observedAt?: number
  fallbackCwd?: string
}

export async function renderAntigravityStatusLine(
  payload: AntigravityPayload,
  runtime: StatuslineRuntime = {},
): Promise<string> {
  if (runtime.configError !== undefined) {
    const noColor = runtime.noColor ?? Boolean(process.env.NO_COLOR)
    const options = resolveOptions(runtime.givenOptions ?? {})
    const theme = makeTheme(options.theme, noColor, ANTIGRAVITY_THEME, options.customTheme)
    const width = payload.terminal_width
    const columns = width && width > 0 ? Math.max(0, width - STATUSLINE_PADDING.length) : undefined
    const errLine = configErrorLine(runtime.configError, { t: theme, l: resolveLabels('en'), columns })
    return errLine ? `${STATUSLINE_PADDING}${errLine}` : ''
  }
  const id = resolveConversationId(payload)
  if (!id) return (await collectLine(payload, runtime)).line
  const dir = runtime.cacheDir ?? defaultCacheDir()
  const isWsl = runtime.isWsl ?? detectWsl()
  const noColor = runtime.noColor ?? Boolean(process.env.NO_COLOR)
  const options = resolveOptions(runtime.givenOptions ?? {})
  const key = JSON.stringify([runtime.appDataDir ?? process.env.ANTIGRAVITY_APP_DATA_DIR, runtime.home ?? homedir(),
    id, payload.workspace?.current_dir ?? payload.cwd ?? runtime.fallbackCwd ?? process.cwd(),
    options, noColor, isWsl])
  const file = cachePath(dir, 'row', key)
  const previous = await readCache<CachedRow | string>(file)
  let current: { parts: string[]; line: string }
  try {
    current = await collectLine(payload, runtime)
  } catch (error) {
    const width = payload.terminal_width
    const columns = width && width > 0 ? Math.max(0, width - STATUSLINE_PADDING.length) : undefined
    const style = { t: makeTheme(options.theme, noColor, ANTIGRAVITY_THEME, options.customTheme), l: resolveLabels('en'), isWsl }
    if (isCachedRow(previous)) {
      const stale = staleParts(previous.parts, columns, style)
      if (stale) return STATUSLINE_PADDING + stale
    } else if (typeof previous === 'string' && previous.length > 0) {
      const body = previous.startsWith(STATUSLINE_PADDING) ? previous.slice(STATUSLINE_PADDING.length) : previous
      const stale = staleLine(body, columns, style)
      if (stale) return STATUSLINE_PADDING + stale
    }
    throw error
  }
  if (!isCachedRow(previous) || !sameParts(previous.parts, current.parts)) {
    await writeCache(dir, file, { version: 2, parts: current.parts } satisfies CachedRow).catch(() => {})
  }
  return current.line
}

async function collectLine(payload: AntigravityPayload, runtime: StatuslineRuntime): Promise<{ parts: string[]; line: string }> {
  const now = runtime.now ?? Date.now()
  const home = runtime.home ?? homedir()
  const appDataDir = runtime.appDataDir ?? process.env.ANTIGRAVITY_APP_DATA_DIR
  const isWsl = runtime.isWsl ?? detectWsl()
  const noColor = runtime.noColor ?? Boolean(process.env.NO_COLOR)
  const cacheDir = runtime.cacheDir ?? defaultCacheDir()
  const options = resolveOptions(runtime.givenOptions ?? {})
  const theme = makeTheme(options.theme, noColor, ANTIGRAVITY_THEME, options.customTheme)
  const labels = resolveLabels('en')
  const values = collectAntigravityPayload(payload, {
    labels,
    home,
    isWsl,
    now,
    fallbackCwd: runtime.fallbackCwd ?? process.cwd(),
  })
  if (values.core.columns !== undefined) {
    values.core.columns = Math.max(0, values.core.columns - STATUSLINE_PADDING.length)
  }

  const collectVcs = options.repo || options.branch || options.status
  const needTranscript = options.tokens || options.session || options.callCounts || collectVcs
  let mutatingToolsSeen = 0
  let sessionKey = ''

  if (needTranscript) {
    const transcriptPath = await resolveTranscriptPath(payload, { home, appDataDir })
    if (transcriptPath) {
      sessionKey = transcriptPath
      const baseContext = {
        cwd: values.core.cwd,
        projectDir: payload.workspace?.project_dir,
        home,
        appDataDir,
      }
      let skillRootsPromise: Promise<readonly string[]> | undefined
      const transcriptContext = {
        ...baseContext,
        resolveSkillRoots: () => (skillRootsPromise ??= collectDeclaredSkillRoots(baseContext)),
      }
      const transcript = await readTranscriptState(transcriptPath, cacheDir, transcriptContext)
      if (options.session) values.session.startedAt = transcript.startedAt
      if (options.tokens || options.callCounts) {
        values.session.counts = options.includeSubagents && transcript.subagentIds.length > 0
          ? await collectAntigravitySubagentCounts({
            rootTranscriptPath: transcriptPath,
            rootId: resolveConversationId(payload),
            rootTranscript: transcript,
            cacheDir,
            context: transcriptContext,
          })
          : transcript.counts
      }
      if (options.tokens && transcript.firstLineHash) {
        values.session.tokensPerSecond = await updateAntigravityRate(
          transcriptPath,
          transcript,
          payload,
          cacheDir,
          now,
          runtime.observedAt ?? now,
        )
      }
      mutatingToolsSeen = transcript.mutatingToolsSeen
    }
  }

  if (collectVcs && values.core.cwd) {
    values.vcs = await readCachedVcs(
      values.core.cwd,
      sessionKey,
      mutatingToolsSeen,
      cacheDir,
      now,
    )
  }

  const parts = renderParts({
    v: values,
    display: antigravityDisplay(values.session),
    o: options,
    l: labels,
    t: theme,
    now,
  })
  const rendered = joinParts(parts, theme)
  return { parts, line: rendered ? `${STATUSLINE_PADDING}${rendered}` : '' }
}

export async function statusline(args: string[]): Promise<number> {
  const checkout = readCheckoutOptionsSafe()
  let given = checkout.ok ? checkout.options : {}
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!
    const value = args[++i]
    if (value === undefined) throw new Error(`Missing value for ${flag}.`)
    if (flag === '--theme') given = mergeOptionLayers(given, { theme: value })
    else if (flag === '--config') given = mergeOptionLayers(given, readOptionsFile(value))
    else throw new Error(`Unknown VArgus option: ${flag}.`)
  }

  if (process.stdin.isTTY) {
    throw new Error('vargus statusline reads Antigravity statusLine JSON from stdin. Configure it in ~/.gemini/antigravity-cli/settings.json or with /statusline.')
  }

  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw.trim()) return 0

  let payload: AntigravityPayload
  try {
    payload = JSON.parse(raw) as AntigravityPayload
  } catch {
    return 0
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 0

  const now = Date.now()
  const observedAt = now - Math.round(process.uptime() * 1000)
  const line = await renderAntigravityStatusLine(payload, {
    givenOptions: given,
    configError: checkout.ok ? undefined : checkout.error,
    now,
    observedAt,
  })
  if (line) process.stdout.write(`${line}\n`)
  return 0
}
