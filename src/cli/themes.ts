import type { Rgb, TokenName, Values } from '../core/types.ts'
import { initialSession } from '../core/session.ts'
import { resolveLabels } from '../i18n/index.ts'
import { detectWsl } from '../node/wsl.ts'
import { DEFAULTS } from '../options.ts'
import { staleParts } from '../render/freshness.ts'
import { render, renderParts } from '../render/index.ts'
import { displaySession, shortModelName } from '../render/session.ts'
import { stringWidth } from '../render/width.ts'
import { AUTO_THEME, lookupPaletteName, makeTheme, resolvePalette } from '../theme/index.ts'
import { PALETTES, PALETTE_POLARITY, type PalettePolarity } from '../theme/palettes.ts'

const TOKEN_ORDER: readonly TokenName[] = [
  'text', 'calm', 'label', 'detail', 'sep', 'alert', 'add', 'del', 'track',
]
const THEME_NAMES = Object.keys(PALETTES)
const AUTO_HOST_LABELS: Record<string, string> = {
  'agy-tokyonight': 'Antigravity',
  'codex-ink': 'Codex',
  'claude-terracotta': 'Claude',
  'omo-violet': 'OmO',
}
const AUTO_THEMES = Object.keys(AUTO_HOST_LABELS)
const AVAILABLE_THEMES = [AUTO_THEME, ...THEME_NAMES]
const POLARITY_ORDER: readonly PalettePolarity[] = ['dark', 'light']
const SECTION_TITLE: Record<PalettePolarity, string> = {
  dark: 'Dark themes',
  light: 'Light themes',
}
const PREVIEW_BG: Record<PalettePolarity, { hex: string; rgb: Rgb }> = {
  dark: { hex: '#181818', rgb: [0x18, 0x18, 0x18] },
  light: { hex: '#ffffff', rgb: [0xff, 0xff, 0xff] },
}
const DARK_THEMES = THEME_NAMES.filter(name => PALETTE_POLARITY[name] === 'dark')
const LIGHT_THEMES = THEME_NAMES.filter(name => PALETTE_POLARITY[name] === 'light')
const RESET = '\x1b[0m'

const USAGE = `Usage:
  vargus themes [NAME]

Preview all bundled themes (or one named theme) on a dark (#181818) or light (#ffffff) background.
Default: ${AUTO_THEME} (uses ${AUTO_THEMES.join(', ')} by host).
Dark themes: ${DARK_THEMES.join(', ')}.
Light themes: ${LIGHT_THEMES.join(', ')}.
Respects NO_COLOR.`

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
        counts: { tokens: 4_200_000, ...baseCounts },
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

function applyBackground(line: string, bg: Rgb, padWidth: number): string {
  const bgSgr = `\x1b[48;2;${bg[0]};${bg[1]};${bg[2]}m`
  const pad = ' '.repeat(Math.max(0, padWidth - stringWidth(line)))
  return `${bgSgr}${line.replaceAll(RESET, `${RESET}${bgSgr}`)}${pad}${RESET}`
}

export function formatThemesPreview(
  names: readonly string[],
  opts: { noColor?: boolean; isWsl?: boolean; columns?: number } = {},
): string {
  if (names.length === 0) return ''
  const l = resolveLabels('en')
  const noColor = opts.noColor ?? false
  const isWsl = opts.isWsl ?? false
  const now = 0
  const samples = sampleValues(isWsl)
  const validCols =
    typeof opts.columns === 'number' && Number.isFinite(opts.columns) && opts.columns > 0
      ? opts.columns
      : undefined

  const expandedNames = names.flatMap(name => (name.trim().toLowerCase() === AUTO_THEME ? AUTO_THEMES : [name]))
  const byPolarity = new Map<PalettePolarity, string[]>(POLARITY_ORDER.map(p => [p, []]))
  for (const name of expandedNames) {
    const palette = resolvePalette(name)
    byPolarity.get(palette.polarity)!.push(palette.name)
  }

  const sections: string[] = []
  for (const polarity of POLARITY_ORDER) {
    const group = byPolarity.get(polarity)!
    if (group.length === 0) continue

    const sectionHeader = noColor
      ? SECTION_TITLE[polarity]
      : `\x1b[1m${SECTION_TITLE[polarity]} (${PREVIEW_BG[polarity].hex})\x1b[22m`
    const bg = PREVIEW_BG[polarity].rgb

    const blocks = group.map(name => {
      const t = makeTheme(name, noColor)
      const hostLabel = AUTO_HOST_LABELS[name]
      const header = hostLabel ? `${name} (auto: ${hostLabel})` : name
      const swatches = TOKEN_ORDER.map(token => t.paint(token, token)).join('  ')
      const calmRow = render({
        v: samples.calm,
        display: displaySession(samples.calm.session, shortModelName),
        o: DEFAULTS,
        l,
        t,
        now,
      })
      const alertRow = staleParts(
        renderParts({
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
      const previewRows = [
        `  ${t.paint('detail', 'tokens')}  ${swatches}`,
        `  ${t.paint('detail', 'calm')}    ${calmRow}`,
        `  ${t.paint('detail', 'alert')}   ${alertRow}`,
      ]
      let styledRows = previewRows
      if (!noColor) {
        const maxWidth = Math.max(...previewRows.map(stringWidth))
        const padToBlock = validCols === undefined || maxWidth + 2 <= validCols
        styledRows = previewRows.map(row =>
          applyBackground(row, bg, padToBlock ? maxWidth + 2 : stringWidth(row) + 2),
        )
      }
      return [header, ...styledRows].join('\n')
    })

    sections.push([sectionHeader, ...blocks].join('\n\n'))
  }

  return sections.join('\n\n\n') + '\n'
}

export function themes(
  args: string[],
  io?: { write?: (chunk: string) => void; noColor?: boolean; isWsl?: boolean; columns?: number },
): number {
  const write = io?.write ?? (chunk => { process.stdout.write(chunk) })
  if (args.length === 1 && args[0] === '--help') {
    write(`${USAGE}\n`)
    return 0
  }
  if (args.some(arg => arg.startsWith('-'))) {
    throw new Error(USAGE)
  }
  let selected: readonly string[]
  if (args.length === 0) {
    selected = THEME_NAMES
  } else if (args.length === 1) {
    const raw = args[0]!
    if (raw.trim().toLowerCase() === AUTO_THEME) {
      selected = AUTO_THEMES
    } else {
      const key = lookupPaletteName(raw)
      if (!key) {
        throw new Error(`Unknown theme: ${raw}. Available themes: ${AVAILABLE_THEMES.join(', ')}.`)
      }
      selected = [key]
    }
  } else {
    const key = args.every(arg => arg.trim() !== '') ? lookupPaletteName(args.join(' ')) : undefined
    if (!key) {
      throw new Error(USAGE)
    }
    selected = [key]
  }
  const noColor = io?.noColor ?? Boolean(process.env.NO_COLOR)
  const isWsl = io?.isWsl ?? detectWsl()
  const columns = io?.columns ?? (process.stdout.isTTY ? process.stdout.columns : undefined)
  write(formatThemesPreview(selected, { noColor, isWsl, columns }))
  return 0
}
