import type { SessionRateLimit } from 'claude-code'

import { MAX_STALE_MS } from '../collect/limits'
import { MAIN, OTHERS, type AgentsValues } from '../collect/agents'
import type { VcsFileKind } from '../collect/vcs'
import type { FragmentInput, Rgb, Theme, TokenName } from '../core/types'
import type { Labels } from '../i18n'
import { formatDuration } from '../render/format'
import { COMPACT, CRITICAL, WARNING } from '../render/fragments/context'
import { effortColor, shortModelName } from '../render/fragments/model'
import { formatTokenCount } from '../render/fragments/tokens'
import { cleanText, shortenHome } from '../render/text'
import { stringWidth } from '../render/width'
import type { VargusAgent } from '../../types'

// The detail view's content (DESIGN, "The detail view"): pure, values in,
// cards of coloured runs out; src/view/pane.tsx turns them into elements. Every
// word comes from the labels, every colour from the theme (none with NO_COLOR),
// and outside text goes through cleanText, as on the line.

// One run of text. `color` is a `#rrggbb` the surface converts for the
// terminal; absent with NO_COLOR.
export type Seg = { text: string; color?: string; bold?: boolean }
export type Row = Seg[]
// `width`: the card's columns, frame included; absent, the whole row.
export type Card = { title: Row; rows: Row[]; width?: number }
// `border`: the cards' frame colour, absent with NO_COLOR.
export type ViewModel = { header: Row; cards: Card[][]; footer: Row; border?: string }

export type ViewInput = FragmentInput & { agents: AgentsValues; columns: number }

// From this many body columns, Context and Tokens sit side by side: Tokens
// at least TOKENS_SIDE wide (its four columns fit), Context the rest, 34 or more.
export const SIDE_BY_SIDE = 100
const TOKENS_SIDE = 66
// The rows the tokens card lists before `+n more`.
export const MAX_AGENT_ROWS = 6
// A card's frame and padding: two border columns and one space each side.
const FRAME = 4

const FILL = '━'
const TRACK = '─'

function hex(t: Theme, color: TokenName | Rgb): string | undefined {
  if (t.noColor) return undefined
  const [r, g, b] = typeof color === 'string' ? t.rgb[color] : color
  return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('')
}

function seg(t: Theme, text: string, color?: TokenName | Rgb, bold = false): Seg {
  const out: Seg = { text }
  const c = color === undefined ? undefined : hex(t, color)
  if (c) out.color = c
  if (bold) out.bold = true
  return out
}

function width(row: Row): number {
  return row.reduce((n, s) => n + stringWidth(s.text), 0)
}

// Padded with spaces to `n` columns, on the right (left-aligned) or the left.
function pad(text: string, n: number, alignRight = false): string {
  const room = Math.max(0, n - stringWidth(text))
  return alignRight ? ' '.repeat(room) + text : text + ' '.repeat(room)
}

// At most `n` columns: the start kept and `…` at the end, or with `fromEnd`
// the end kept and `…` first (a path's file name is the part to keep).
export function cut(text: string, n: number, fromEnd = false): string {
  if (stringWidth(text) <= n) return text
  if (n <= 1) return n === 1 ? '…' : ''
  const chars = [...text]
  if (fromEnd) chars.reverse()
  let out = ''
  for (const c of chars) {
    const next = fromEnd ? c + out : out + c
    if (stringWidth(next) > n - 1) break
    out = next
  }
  return fromEnd ? '…' + out : out + '…'
}

// A row cut to `n` columns: the run that crosses the edge is cut with `…`,
// the runs after it dropped. Every row passes it, so none relies on the
// surface's own truncation.
export function fitRow(row: Row, n: number): Row {
  const out: Row = []
  let used = 0
  for (const s of row) {
    const w = stringWidth(s.text)
    if (used + w <= n) {
      out.push(s)
      used += w
      continue
    }
    const text = cut(s.text, n - used)
    if (text) out.push({ ...s, text })
    break
  }
  return out
}

// A gauge `n` cells wide: the used part in its tier colour, the rest as track.
// `zones` colour the track from a percent on, so a threshold shows before the
// fill reaches it.
// `zones` are [from percent, colour], in rising order.
function gauge(t: Theme, percent: number, n: number, color: Rgb, zones: [number, Rgb][] = []): Row {
  const p = Math.min(100, Math.max(0, percent))
  const filled = Math.min(n, Math.round((p / 100) * n))
  const trackColor = (cell: number): Rgb => {
    let c = t.rgb.sep
    for (const [from, zone] of zones) if ((cell / n) * 100 >= from) c = zone
    return c
  }
  // one run per colour: the fill, then each stretch of track of one colour
  const runs: [string, Rgb][] = filled > 0 ? [[FILL.repeat(filled), color]] : []
  for (let cell = filled; cell < n; cell++) {
    const c = trackColor(cell)
    const last = runs[runs.length - 1]
    if (last && last[1] === c && cell > filled) last[0] += TRACK
    else runs.push([TRACK, c])
  }
  return runs.map(([text, c]) => seg(t, text, c))
}

// ---------------------------------------------------------------------------
// Times. The mod's clock is the machine's local time (measured: the mod's
// Date gave UTC+8 on the dev machine, 2.1.301).

function two(n: number): string {
  return String(n).padStart(2, '0')
}

// `14:20` today, `Sat 14:20` within six days (so a weekday never names a day
// a week out, which would read as today's), `10-23 14:20` beyond.
export function clockTime(l: Labels, at: number, now: number): string {
  const d = new Date(at)
  const today = new Date(now)
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`
  if (d.toDateString() === today.toDateString()) return hm
  if (at - now < 6 * 86_400_000) return `${l.viewWeekdays.split(' ')[d.getDay()] ?? ''} ${hm}`.trim()
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${hm}`
}

// ---------------------------------------------------------------------------
// Header and footer.

// The header for `n` columns: whole parts dropped from the end, as the line
// drops fragments, then the folder cut if it alone is too wide.
function header(f: ViewInput, n: number): Row {
  const { v, o, l, t, now } = f
  const parts: Row[] = []
  if (v.core.cwd) parts.push([seg(t, cleanText(shortenHome(v.core.cwd, v.core.home)), 'text', true)])
  const name = v.session.model === undefined ? null : shortModelName(cleanText(v.session.model))
  if (name) {
    const effort = v.session.effort
    parts.push(effort === undefined || effort === ''
      ? [seg(t, name, effortColor(t, undefined))]
      : [seg(t, `${name}:`, 'label'), seg(t, cleanText(String(effort)).toLowerCase(), effortColor(t, effort))])
  }
  if (v.session.startedAt !== undefined) {
    const minutes = Math.max(0, Math.floor((now - v.session.startedAt) / 60_000))
    parts.push([seg(t, `${l.session} `, 'label'), seg(t, formatDuration(minutes), 'gradLow')])
  }
  const c = v.session.counts
  const calls: [string, string, number][] = [
    ['🔧', l.tool, c.tools], ['🤖', l.agent, c.agents], ['🔀', l.workflow, o.workflowRuns ? c.workflows : 0],
    ['⚡', l.skill, c.skills],
  ]
  const shown = calls.filter(([, , n]) => n > 0)
  if (shown.length) {
    parts.push(shown.flatMap(([icon, mark, n], i) => [
      seg(t, (i ? ' ' : '') + (v.core.isWsl ? `${mark}:` : icon)), seg(t, String(n), 'label'),
    ]))
  }
  const join = (list: Row[]) => list.flatMap((p, i) => (i ? [seg(t, '  ·  ', 'sep'), ...p] : p))
  while (parts.length > 1 && width(join(parts)) > n) parts.pop()
  return fitRow(join(parts), n)
}

// ---------------------------------------------------------------------------
// Limits: every window the engine and the usage API give, the line's
// thresholds aside.

type Window = { label: string; percent: number; resetsAt: number | null; stale?: boolean; unclamped?: boolean; note?: string }

function engineTime(iso: string | undefined): number | null {
  const ms = iso ? Date.parse(iso) : NaN
  return Number.isNaN(ms) ? null : ms
}

function windows(f: ViewInput): { list: Window[]; notes: Row[] } {
  const { v, l, t, now } = f
  const L = v.limits
  const list: Window[] = []
  const engine = (r: SessionRateLimit | undefined, label: string, unclamped = false) => {
    if (r) list.push({ label, percent: r.percentUsed, resetsAt: engineTime(r.resetsAt), unclamped })
  }
  engine(L.engine.find(r => r.kind === 'five_hour'), l.fiveHour)
  engine(L.engine.find(r => r.kind === 'seven_day'), l.sevenDay)
  const notes: Row[] = []
  const api = L.api && L.lastSuccessAt !== null && now - L.lastSuccessAt <= MAX_STALE_MS ? L.api : null
  const stale = L.error !== null
  if (api) {
    if (api.sonnet) list.push({ label: l.sonnetWeekly, ...api.sonnet, stale })
    if (api.opus) list.push({ label: l.opusWeekly, ...api.opus, stale })
    for (const m of api.others) list.push({ ...m, label: cleanText(m.label), stale })
    if (api.extra) {
      const note = `$${api.extra.spentUsd.toFixed(2)}/$${api.extra.limitUsd.toFixed(2)}`
      list.push({ label: l.extra, ...api.extra, stale, note })
    }
    if (stale && L.lastSuccessAt !== null) {
      notes.push([seg(t, `* ${l.viewStale} ${formatDuration((now - L.lastSuccessAt) / 60_000)} ${l.viewAgo}`, 'faint')])
    }
  } else if (L.error === 'rate_limited') {
    notes.push([seg(t, l.apiRateLimited, 'faint')])
  } else if (L.error === 'auth') {
    notes.push([seg(t, l.apiAuth, 'gradMid')])
  } else if (L.error === 'network') {
    notes.push([seg(t, l.apiError, 'gradMid')])
  }
  engine(L.engine.find(r => r.kind === 'spend_limit'), l.spendLimit, true)
  // a window past its reset belongs to the one that just ended (the line's rule)
  return { list: list.filter(w => w.resetsAt === null || w.resetsAt > now), notes }
}

function limitsCard(f: ViewInput, inner: number): Card {
  const { l, t, now } = f
  const { list, notes } = windows(f)
  const title = [seg(t, l.viewLimits, 'track', true)]
  if (list.length === 0) return { title, rows: [[seg(t, l.viewWaiting, 'faint')], ...notes] }
  const labelW = Math.max(2, ...list.map(w => stringWidth(w.label)))
  // The reset column, widest form first, narrowed until the gauge has room.
  const forms = [
    (w: Window, at: number) => `${w.note ? `${w.note} · ` : ''}${l.viewResets} ${clockTime(l, at, now)} · ${formatDuration((at - now) / 60_000)}`,
    (w: Window, at: number) => `${w.note ? `${w.note} · ` : ''}${clockTime(l, at, now)} · ${formatDuration((at - now) / 60_000)}`,
    (_w: Window, at: number) => formatDuration((at - now) / 60_000),
  ]
  const fixed = labelW + 1 + 1 + 5 + 1 + 2
  let form = forms[forms.length - 1]!
  let resetW = 0
  for (const candidate of forms) {
    const w = Math.max(0, ...list.map(x => (x.resetsAt === null ? 0 : stringWidth(candidate(x, x.resetsAt)))))
    form = candidate
    resetW = w
    if (inner - fixed - w >= 12) break
  }
  // under 6 cells no gauge at all, so the percent is never what gets cut
  const room = inner - fixed - resetW
  const g = room >= 6 ? Math.min(60, room) : 0
  const rows = list.map(w => {
    const rounded = Math.max(0, Math.round(w.percent))
    const pct = w.unclamped ? rounded : Math.min(100, rounded)
    const tier = t.gradient(Math.min(100, pct))
    return [
      seg(t, pad(w.label, labelW), 'label'), seg(t, ' '),
      ...(g ? gauge(t, pct, g, tier) : []),
      seg(t, pad(`${pct}%`, 5, true), tier, true),
      seg(t, w.stale ? '*' : ' ', 'faint'),
      seg(t, w.resetsAt === null ? '' : `  ${form(w, w.resetsAt)}`, 'faint'),
    ]
  })
  return { title, rows: [...rows, ...notes] }
}

// ---------------------------------------------------------------------------
// Context: the gauge with the line's thresholds as zones on its track.


function contextCard(f: ViewInput, inner: number): Card {
  const { v, l, t } = f
  const title = [seg(t, l.viewContext, 'track', true)]
  const s = v.session
  // Before the first response the host gives the window alone: 0 %, as the
  // line's ctx:0% (src/render/fragments/context.ts).
  if (s.contextPercent === undefined && s.contextWindow === undefined) return { title, rows: [[seg(t, l.viewWaiting, 'faint')]] }
  const pct = Math.min(100, Math.max(0, Math.round(s.contextPercent ?? 0)))
  const tier = t.gradient(pct, [WARNING, CRITICAL])
  const zones: [number, Rgb][] = [[COMPACT, t.lerp(t.rgb.sep, t.rgb.gradMid, 0.5)], [CRITICAL, t.lerp(t.rgb.sep, t.rgb.gradHigh, 0.6)]]
  const rows: Row[] = [[...gauge(t, pct, Math.max(6, inner - 6), tier, zones), seg(t, pad(`${pct}%`, 6, true), tier, true)]]
  if (s.contextWindow !== undefined) {
    rows.push([
      seg(t, formatTokenCount(s.contextTokens ?? 0), 'text', true),
      seg(t, ` / ${formatTokenCount(s.contextWindow)} ${l.viewTokensUsed}`, 'label'),
    ])
  }
  const word = pct >= CRITICAL ? l.critical : pct >= COMPACT ? l.compress : ''
  rows.push(word
    ? [seg(t, word, tier, true)]
    : [seg(t, `${l.compress} ${COMPACT}%  ·  ${l.critical} ${CRITICAL}%`, 'faint')])
  return { title, rows }
}

// ---------------------------------------------------------------------------
// Tokens by agent: the main loop first, then the rest by tokens, largest first.

function agentName(l: Labels, a: VargusAgent): string {
  if (a.id === MAIN) return l.viewMain
  if (a.id === OTHERS) return l.viewOthers
  return cleanText(a.name)
}

function tokensCard(f: ViewInput, inner: number): Card {
  const { l, t } = f
  const title = [seg(t, l.viewTokens, 'track', true)]
  const list = f.agents.list
  if (list.length === 0) return { title, rows: [[seg(t, l.viewNoTokens, 'faint')]] }
  const sorted = [
    ...list.filter(a => a.id === MAIN),
    ...list.filter(a => a.id !== MAIN && a.id !== OTHERS).sort((a, b) => b.input + b.output - (a.input + a.output)),
    ...list.filter(a => a.id === OTHERS),
  ]
  const heads = [l.viewIn, l.viewOut, l.viewCacheRead, l.viewCacheWrite]
  const numW = Math.max(7, ...heads.map(h => stringWidth(h) + 2))
  const columns = inner >= 10 + 4 * numW ? 4 : 2
  const nameW = Math.max(4, inner - columns * numW)
  const nums = (a: Pick<VargusAgent, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>) =>
    [a.input, a.output, a.cacheRead, a.cacheWrite].slice(0, columns).map(n => pad(formatTokenCount(n), numW, true))
  const rows: Row[] = [[
    seg(t, pad('', nameW)), ...heads.slice(0, columns).map(h => seg(t, pad(h, numW, true), 'faint')),
  ]]
  // the others row, once there is one, keeps its place at the end
  const others = sorted.filter(a => a.id === OTHERS)
  const named = sorted.filter(a => a.id !== OTHERS)
  const shown = [...named.slice(0, MAX_AGENT_ROWS - others.length), ...others]
  for (const a of shown) {
    const name = agentName(l, a)
    const detail = a.detail && a.id !== MAIN ? ` ${cleanText(a.detail)}` : ''
    const nameText = cut(name, nameW - 1)
    const detailText = cut(detail, Math.max(0, nameW - 1 - stringWidth(nameText)))
    rows.push([
      seg(t, nameText, 'text', a.id === MAIN),
      seg(t, pad(detailText, nameW - stringWidth(nameText)), 'faint'),
      ...nums(a).map(n => seg(t, n, 'gradLow')),
    ])
  }
  const rest = sorted.length - shown.length
  if (rest > 0) rows.push([seg(t, `+${rest} ${l.viewMore}`, 'faint')])
  if (sorted.length > 1) {
    const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    for (const a of sorted) {
      sum.input += a.input
      sum.output += a.output
      sum.cacheRead += a.cacheRead
      sum.cacheWrite += a.cacheWrite
    }
    rows.push([seg(t, pad(l.viewTotal, nameW), 'label', true), ...nums(sum).map(n => seg(t, n, 'text', true))])
  }
  return { title, rows }
}

// ---------------------------------------------------------------------------
// git or svn: the branch, the counts in words, the first changed paths.

const KIND_COLOR: Record<VcsFileKind, TokenName> = {
  conflicted: 'gradHigh', staged: 'add', modified: 'del', untracked: 'track',
}

function vcsCard(f: ViewInput, inner: number): Card | null {
  const { v, o, l, t } = f
  const vcs = v.vcs
  if (!vcs.kind) return null
  const title: Row = [seg(t, vcs.kind === 'git' ? l.viewGit : l.viewSvn, 'track', true)]
  if (vcs.repo) title.push(seg(t, '  ·  ', 'sep'), seg(t, cleanText(vcs.repo), 'text', true))
  const rows: Row[] = []

  const c = vcs.counts
  // ahead/behind first: a long branch is cut at the row's end, never them
  const head: Row = []
  if (c && c.ahead > 0) head.push(seg(t, `${l.ahead}${c.ahead}  `, 'add'))
  if (c && c.behind > 0) head.push(seg(t, `${l.behind}${c.behind}  `, 'del'))
  if (vcs.branch) head.push(seg(t, cleanText(vcs.branch), 'gradLow', true))
  if (vcs.kind === 'svn' && vcs.revision) head.push(seg(t, l.detachedAt, 'label'), seg(t, cleanText(vcs.revision), 'gradLow'))
  const d = vcs.detached
  if (vcs.kind === 'git' && !vcs.branch && d && o.detachedHead) {
    if (!d.onBranch) head.push(seg(t, l.detachedAt, 'label'))
    head.push(seg(t, cleanText(d.name), 'gradLow', true))
    if (d.operation) head.push(seg(t, ` (${cleanText(l[d.operation])}${d.progress ? ` ${d.progress}` : ''})`, 'gradMid'))
  }
  if (vcs.kind === 'git' && vcs.worktree) head.push(seg(t, ` ${l.worktree}`, 'label'), seg(t, cleanText(vcs.worktree), 'gradLow'), seg(t, ')', 'label'))
  if (head.length) rows.push(head)

  if (!c) {
    rows.push([seg(t, l.viewWaiting, 'faint')])
    return { title, rows }
  }
  const words: [VcsFileKind, string, string, number][] = [
    ['conflicted', l.conflict, l.viewConflicted, c.conflicted], ['staged', l.staged, l.viewStaged, c.staged],
    ['modified', l.modified, l.viewModified, c.modified], ['untracked', l.untracked, l.viewUntracked, c.untracked],
  ]
  const counts = words.filter(([, , , n]) => n > 0)
  if (counts.length === 0) rows.push([seg(t, l.viewClean, 'add')])
  // as many counts to a row as fit, the rest on the next
  let line: Row = []
  for (const [kind, mark, word, n] of counts) {
    const item = [seg(t, `${mark}${n}`, KIND_COLOR[kind], true), seg(t, ` ${word}`, 'faint')]
    const gap = line.length ? [seg(t, '   ')] : []
    if (line.length && width([...line, ...gap, ...item]) > inner) {
      rows.push(line)
      line = []
    }
    line.push(...(line.length ? gap : []), ...item)
  }
  if (line.length) rows.push(line)

  for (const file of vcs.files) {
    const marks = file.kinds.map(k => seg(t, k === 'conflicted' ? l.conflict : l[k], KIND_COLOR[k], true))
    const markW = 3
    rows.push([
      seg(t, '  '), ...marks, seg(t, pad('', markW - width(marks))),
      seg(t, cut(cleanText(file.path), Math.max(4, inner - 2 - markW), true), 'text'),
    ])
  }
  const rest = vcs.fileCount - vcs.files.length
  if (rest > 0) rows.push([seg(t, `  +${rest} ${l.viewMore}`, 'faint')])
  return { title, rows }
}

// ---------------------------------------------------------------------------

// A card that throws is left out, never the view (the line's rule for a
// fragment, DESIGN "When the line is written").
function safe<T>(make: () => T): T | null {
  try {
    return make()
  } catch {
    return null
  }
}

// The whole view for a body `columns` wide.
export function viewModel(f: ViewInput): ViewModel {
  const { l, t } = f
  const columns = Math.max(20, f.columns)
  const full = columns - FRAME
  const left = columns - Math.max(TOKENS_SIDE, Math.ceil(columns / 2))
  const side = columns >= SIDE_BY_SIDE
  const context = safe(() => (side ? { ...contextCard(f, left - FRAME), width: left } : contextCard(f, full)))
  const tokens = safe(() => (side ? { ...tokensCard(f, columns - left - FRAME), width: columns - left } : tokensCard(f, full)))
  const rows: (Card | null)[][] = [
    [safe(() => limitsCard(f, full))], ...(side ? [[context, tokens]] : [[context], [tokens]]), [safe(() => vcsCard(f, full))],
  ]
  const fit = (c: Card): Card => {
    const inner = (c.width ?? columns) - FRAME
    return { ...c, title: fitRow(c.title, inner), rows: c.rows.map(r => fitRow(r, inner)) }
  }
  const cards = rows.map(r => r.filter((c): c is Card => c !== null).map(fit)).filter(r => r.length > 0)
  // the header and footer sit in a Box padded one column each side
  const m: ViewModel = {
    header: safe(() => header(f, columns - 2)) ?? [], cards, footer: fitRow([seg(t, l.viewClose, 'faint')], columns - 2),
  }
  const border = hex(t, 'sep')
  if (border) m.border = border
  return m
}
