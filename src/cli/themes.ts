import { release } from 'node:os'
import type { TokenName, Values } from '../core/types.ts'
import { initialSession } from '../core/session.ts'
import { resolveLabels } from '../i18n/index.ts'
import { DEFAULTS } from '../options.ts'
import { staleLine } from '../render/freshness.ts'
import { render } from '../render/index.ts'
import { displaySession, shortModelName } from '../render/session.ts'
import { DEFAULT_THEME, makeTheme } from '../theme/index.ts'
import { PALETTES } from '../theme/palettes.ts'

const TOKEN_ORDER: readonly TokenName[] = [
  'text', 'calm', 'label', 'detail', 'sep', 'alert', 'add', 'del', 'track',
]
const THEME_NAMES = Object.keys(PALETTES)

const USAGE = `Usage:
  vargus themes [NAME]

Preview all bundled themes (or one named theme) in the terminal.
Available themes: ${THEME_NAMES.join(', ')}.
Respects NO_COLOR.`

function detectWsl(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.WSL_DISTRO_NAME || env.WSLENV || /microsoft/i.test(release()))
}

function sampleValues(isWsl: boolean): { calm: Values; alert: Values } {
  const core = { cwd: '/home/u/proj/VArgus', home: '/home/u', columns: undefined, isWsl }
  const baseCounts = { tools: 73, agents: 2, skills: 1 }
  return {
    calm: {
      core,
      session: {
        ...initialSession(),
        model: 'claude-opus-5-5',
        effort: 'high',
        defaultEffort: 'high',
        fast: true,
        contextPercent: 20,
        cacheHitPercent: 99.4,
        tokensPerSecond: 48,
        startedAt: -24 * 60_000,
        counts: { tokens: 69_500, ...baseCounts },
      },
      limits: [
        { label: '5h', percent: 4, resetsAt: (4 * 60 + 37) * 60_000 },
        { label: '7d', percent: 39, resetsAt: (5 * 24 + 6) * 3_600_000 },
      ],
      vcs: {
        kind: 'git',
        repo: 'VArgus',
        branch: 'main',
        detached: null,
        worktree: 'x',
        counts: { conflicted: 0, staged: 2, modified: 3, untracked: 4, ahead: 1, behind: 2 },
      },
    },
    alert: {
      core,
      session: {
        ...initialSession(),
        model: 'claude-opus-5-5',
        effort: 'low',
        defaultEffort: 'high',
        fast: false,
        contextPercent: 85,
        cacheHitPercent: 99.4,
        tokensPerSecond: 48,
        startedAt: -(12 * 60 + 30) * 60_000,
        counts: { tokens: 1_200_000, ...baseCounts },
      },
      limits: [
        'rate_limited',
        { label: '7d', percent: 88, resetsAt: (5 * 24 + 6) * 3_600_000 },
      ],
      vcs: {
        kind: 'git',
        repo: 'VArgus',
        branch: null,
        detached: { name: 'feat', onBranch: true, operation: 'gitRebase', progress: '2/3' },
        worktree: null,
        counts: { conflicted: 1, staged: 0, modified: 3, untracked: 0, ahead: 0, behind: 2 },
      },
    },
  }
}

export function formatThemesPreview(
  names: readonly string[],
  opts: { noColor?: boolean; isWsl?: boolean } = {},
): string {
  if (names.length === 0) return ''
  const l = resolveLabels('en')
  const noColor = opts.noColor ?? false
  const isWsl = opts.isWsl ?? false
  const now = 0
  const samples = sampleValues(isWsl)
  const blocks = names.map(name => {
    const t = makeTheme(name, noColor)
    const header = name === DEFAULT_THEME ? `${name} (default)` : name
    const swatches = TOKEN_ORDER.map(token => t.paint(token, token)).join('  ')
    const calmRow = render({
      v: samples.calm,
      display: displaySession(samples.calm.session, shortModelName),
      o: DEFAULTS,
      l,
      t,
      now,
    })
    const alertRow = staleLine(
      render({
        v: samples.alert,
        display: displaySession(samples.alert.session, shortModelName),
        o: DEFAULTS,
        l,
        t,
        now,
      }),
      undefined,
      { t, l, isWsl },
    )
    return [
      header,
      `  tokens  ${swatches}`,
      `  calm    ${calmRow}`,
      `  alert   ${alertRow}`,
    ].join('\n')
  })
  return blocks.join('\n\n') + '\n'
}

export function themes(
  args: string[],
  io?: { write?: (chunk: string) => void; noColor?: boolean; isWsl?: boolean },
): number {
  const write = io?.write ?? (chunk => { process.stdout.write(chunk) })
  if (args.length === 1 && args[0] === '--help') {
    write(`${USAGE}\n`)
    return 0
  }
  if (args.length > 1 || (args.length === 1 && args[0]!.startsWith('-'))) {
    throw new Error(USAGE)
  }
  let selected: readonly string[]
  if (args.length === 0) {
    selected = THEME_NAMES
  } else {
    const raw = args[0]!
    const key = raw.trim().toLowerCase()
    if (!Object.prototype.hasOwnProperty.call(PALETTES, key)) {
      throw new Error(`Unknown theme: ${raw}. Available themes: ${THEME_NAMES.join(', ')}.`)
    }
    selected = [key]
  }
  const noColor = io?.noColor ?? Boolean(process.env.NO_COLOR)
  const isWsl = io?.isWsl ?? detectWsl(process.env)
  write(formatThemesPreview(selected, { noColor, isWsl }))
  return 0
}
