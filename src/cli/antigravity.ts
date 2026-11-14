import { readFile } from 'node:fs/promises'
import { homedir, release } from 'node:os'
import { defaultCacheDir } from '../hosts/antigravity/cache.ts'
import { collectAntigravityPayload, type AntigravityPayload } from '../hosts/antigravity/collect.ts'
import { readTranscriptState, resolveTranscriptPath } from '../hosts/antigravity/transcript.ts'
import { readCachedGit } from '../hosts/antigravity/vcs.ts'
import { resolveLabels } from '../i18n/index.ts'
import { resolveOptions } from '../options.ts'
import { render } from '../render/index.ts'
import { makeTheme } from '../theme/index.ts'

export const STATUSLINE_PADDING = '  '

export type StatuslineRuntime = {
  givenOptions?: Record<string, unknown>
  home?: string
  appDataDir?: string
  isWsl?: boolean
  noColor?: boolean
  cacheDir?: string
  now?: number
  fallbackCwd?: string
}

function detectWsl(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.WSL_DISTRO_NAME || env.WSLENV || /microsoft/i.test(release()))
}

export async function renderAntigravityStatusLine(
  payload: AntigravityPayload,
  runtime: StatuslineRuntime = {},
): Promise<string> {
  const now = runtime.now ?? Date.now()
  const home = runtime.home ?? homedir()
  const appDataDir = runtime.appDataDir ?? process.env.ANTIGRAVITY_APP_DATA_DIR
  const isWsl = runtime.isWsl ?? detectWsl(process.env)
  const noColor = runtime.noColor ?? Boolean(process.env.NO_COLOR)
  const cacheDir = runtime.cacheDir ?? defaultCacheDir()
  const options = resolveOptions(runtime.givenOptions ?? {})
  const theme = makeTheme(options.theme, noColor)
  const values = collectAntigravityPayload(payload, {
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
      const transcript = await readTranscriptState(transcriptPath, cacheDir, {
        cwd: values.core.cwd,
        projectDir: payload.workspace?.project_dir,
        home,
        appDataDir,
      })
      if (options.session) values.session.startedAt = transcript.startedAt
      if (options.tokens || options.callCounts) values.session.counts = transcript.counts
      mutatingToolsSeen = transcript.mutatingToolsSeen
    }
  }

  if (collectVcs && values.core.cwd) {
    values.vcs = await readCachedGit(
      values.core.cwd,
      options.detachedHead,
      sessionKey,
      mutatingToolsSeen,
      cacheDir,
      now,
    )
  }

  const rendered = render({
    v: values,
    o: options,
    l: resolveLabels('en'),
    t: theme,
    now,
  })
  return rendered ? `${STATUSLINE_PADDING}${rendered}` : ''
}

export async function statusline(args: string[]): Promise<number> {
  let given: Record<string, unknown> = {}
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!
    const value = args[++i]
    if (value === undefined) throw new Error(`Missing value for ${flag}.`)
    if (flag === '--theme') given.theme = value
    else if (flag === '--config') given = { ...given, ...(JSON.parse(await readFile(value, 'utf8')) as Record<string, unknown>) }
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

  const line = await renderAntigravityStatusLine(payload, { givenOptions: given })
  if (line) process.stdout.write(`${line}\n`)
  return 0
}
