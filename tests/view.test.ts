import { describe, expect, test } from 'claude-code/testing'

import { initialAgents, MAIN, OTHERS, type AgentsValues } from '../src/collect/agents'
import { initialLimits } from '../src/collect/limits'
import { initialSession } from '../src/collect/session'
import { initialVcs, MAX_FILES, parseGitFiles, parseSvnFiles } from '../src/collect/vcs'
import type { Values } from '../src/core/types'
import { en, type Labels } from '../src/i18n/en'
import { DEFAULTS } from '../src/options'
import { makeTheme } from '../src/theme'
import { clockTime, cut, SIDE_BY_SIDE, viewModel, type Card, type Row, type ViewInput } from '../src/view/model'
import { stringWidth } from '../src/render/width'
import type { VargusAgent } from '../types'

// The detail view's content (DESIGN, "The detail view"), pure: values in,
// cards of runs out. Times are built from local date parts, so the expected
// clock times do not come from the code under test.

const NOW = new Date(2026, 9, 16, 9, 0).getTime() // a Friday, 09:00 local
const at = (day: number, h: number, m: number) => new Date(2026, 9, day, h, m).getTime()
const iso = (ms: number) => new Date(ms).toISOString()

function agent(id: string, name: string, input: number, output: number, extra: Partial<VargusAgent> = {}): VargusAgent {
  return { id, kind: id === MAIN ? 'main' : 'subagent', name, detail: '', input, output, cacheRead: 0, cacheWrite: 0, requests: 1, ...extra }
}

function input(over: {
  session?: Partial<Values['session']>; limits?: Partial<Values['limits']>; vcs?: Partial<Values['vcs']>
  agents?: AgentsValues; columns?: number; noColor?: boolean; labels?: Labels
} = {}): ViewInput {
  const v: Values = {
    core: { cwd: '/home/u/proj', home: '/home/u', columns: undefined, isWsl: false },
    session: { ...initialSession(), ...over.session },
    limits: { ...initialLimits(), ...over.limits },
    vcs: { ...initialVcs(), ...over.vcs },
  }
  return {
    v, o: { ...DEFAULTS, detailView: true }, l: over.labels ?? en, t: makeTheme('graphite', over.noColor ?? false),
    now: NOW, agents: over.agents ?? initialAgents(), columns: over.columns ?? 76,
  }
}

const text = (row: Row) => row.map(s => s.text).join('')
const card = (cards: Card[][], title: string) => cards.flat().find(c => text(c.title).startsWith(title))!

// every window the engine and the API give
const FULL_LIMITS: Partial<Values['limits']> = {
  engine: [
    { kind: 'five_hour', percentUsed: 31, resetsAt: iso(at(16, 14, 20)) },
    { kind: 'seven_day', percentUsed: 48, resetsAt: iso(at(17, 21, 0)) },
    { kind: 'spend_limit', percentUsed: 104, resetsAt: iso(at(30, 0, 0)) },
  ],
  api: {
    sonnet: { percent: 12, resetsAt: at(17, 21, 0) },
    opus: { percent: 90, resetsAt: at(17, 21, 0) },
    others: [{ label: 'fb', percent: 5, resetsAt: at(17, 21, 0) }],
    extra: { percent: 40, resetsAt: at(30, 0, 0), spentUsd: 20, limitUsd: 50 },
  },
  lastSuccessAt: NOW - 60_000,
  error: null,
}

describe('view: limits', () => {
  test('every window, in the line order, the line thresholds aside (sn under 80 % shown)', () => {
    const rows = card(viewModel(input({ limits: FULL_LIMITS })).cards, 'Limits').rows.map(text)
    expect(rows.map(r => r.split(' ')[0])).toEqual(['5h', '7d', 'sn', 'op', 'fb', 'extra', 'spend'])
    expect(rows[0]).toContain(' 31% ')
    // the spend limit is not clamped, as on the line
    expect(rows[6]).toContain(' 104% ')
    expect(rows[5]).toContain('$20.00/$50.00')
  })

  test('the reset: today as HH:MM, within a week with the weekday, with the countdown', () => {
    const rows = card(viewModel(input({ limits: FULL_LIMITS, columns: 100 })).cards, 'Limits').rows.map(text)
    expect(rows[0]).toContain('resets 14:20 · 5h20m')
    expect(rows[1]).toContain('resets Sat 21:00 · 1d12h')
  })

  test('narrow: the reset column drops the word, then the clock, before the gauge goes below 12', () => {
    const wide = text(card(viewModel(input({ limits: FULL_LIMITS, columns: 100 })).cards, 'Limits').rows[0]!)
    const narrow = text(card(viewModel(input({ limits: FULL_LIMITS, columns: 40 })).cards, 'Limits').rows[0]!)
    expect(wide).toContain('resets')
    expect(narrow).not.toContain('resets')
    expect(narrow).not.toContain('14:20')
    expect(narrow.endsWith('5h20m')).toBe(true)
  })

  test('a window past its reset is left out; nothing at all reads as waiting', () => {
    const past = { engine: [{ kind: 'five_hour', percentUsed: 99, resetsAt: iso(NOW - 1) }] }
    expect(card(viewModel(input({ limits: past })).cards, 'Limits').rows.map(text)).toEqual(['waiting for the first reading'])
  })

  test('a failed read: the numbers stale-marked and a note with the age; past 15 min the error', () => {
    const stale = { ...FULL_LIMITS, error: 'network' as const, lastSuccessAt: NOW - 3 * 60_000 }
    const rows = card(viewModel(input({ limits: stale })).cards, 'Limits').rows.map(text)
    expect(rows[2]).toContain('%*')
    expect(rows.at(-1)).toBe('* last read 3m ago')
    const old = { ...stale, lastSuccessAt: NOW - 16 * 60_000 }
    expect(card(viewModel(input({ limits: old })).cards, 'Limits').rows.map(text).at(-1)).toBe('[API err]')
  })
})

describe('view: context', () => {
  test('the gauge, the tokens of the window, the thresholds', () => {
    const rows = card(viewModel(input({ session: { contextPercent: 42, contextTokens: 84_000, contextWindow: 200_000 } })).cards, 'Context').rows.map(text)
    expect(rows[0]!.endsWith(' 42%')).toBe(true)
    expect(rows[1]).toBe('84.0k / 200.0k tokens')
    expect(rows[2]).toBe('COMPRESS? 80%  ·  CRITICAL 85%')
  })

  test('from 80 % the word the line shows, before the first reading waiting', () => {
    const rows = card(viewModel(input({ session: { contextPercent: 86 } })).cards, 'Context').rows.map(text)
    expect(rows.at(-1)).toBe('CRITICAL')
    expect(card(viewModel(input()).cards, 'Context').rows.map(text)).toEqual(['waiting for the first reading'])
  })

  test('before the first response, the window alone: 0 % and 0 tokens, as the line shows ctx:0%', () => {
    const rows = card(viewModel(input({ session: { contextWindow: 1_000_000 } })).cards, 'Context').rows.map(text)
    expect(rows[0]!.endsWith(' 0%')).toBe(true)
    expect(rows[1]).toBe('0 / 1.00M tokens')
  })

  test('the fill is the percent of the gauge, the track coloured from 80 % and 85 %', () => {
    const m = viewModel(input({ session: { contextPercent: 50 }, columns: 76 }))
    const gauge = card(m.cards, 'Context').rows[0]!.slice(0, -1)
    const cells = gauge.reduce((n, s) => n + s.text.length, 0)
    expect(cells).toBe(76 - 4 - 6)
    expect(gauge[0]!.text).toBe('━'.repeat(Math.round(cells / 2)))
    // fill, plain track, the 80 % zone, the 85 % zone
    expect(new Set(gauge.map(s => s.color)).size).toBe(4)
  })
})

describe('view: tokens by agent', () => {
  const list = [
    agent('a1', 'Explore', 100, 50, { detail: 'find labels' }),
    agent(MAIN, '', 1000, 300),
    agent('a2', 'reviewer', 5000, 900),
  ]

  test('the main loop first, then by tokens, a total row summing them', () => {
    const rows = card(viewModel(input({ agents: { list } })).cards, 'Tokens').rows.map(text)
    expect(rows.slice(1, 4).map(r => r.split(/\s+/)[0])).toEqual(['main', 'reviewer', 'Explore'])
    expect(rows[3]).toContain('find labels')
    const total = rows.at(-1)!.split(/\s+/)
    // in 100 + 1000 + 5000, out 50 + 300 + 900
    expect(total.slice(0, 3)).toEqual(['total', '6.1k', '1.3k'])
  })

  test('all four columns when they fit, in and out alone when narrow', () => {
    expect(text(card(viewModel(input({ agents: { list }, columns: 76 })).cards, 'Tokens').rows[0]!)).toContain('cache write')
    expect(text(card(viewModel(input({ agents: { list }, columns: 40 })).cards, 'Tokens').rows[0]!)).not.toContain('cache')
  })

  test('past six rows `+n more`; the others row last; none yet says so', () => {
    const many = [agent(MAIN, '', 1, 1), ...Array.from({ length: 8 }, (_, i) => agent(`a${i}`, `t${i}`, 10 + i, 0)),
      { ...agent(OTHERS, '', 1, 1), kind: 'others' as const }]
    const rows = card(viewModel(input({ agents: { list: many } })).cards, 'Tokens').rows.map(text)
    expect(rows.filter(r => /^\+\d+ more$/.test(r))).toEqual(['+4 more'])
    expect(card(viewModel(input()).cards, 'Tokens').rows.map(text)).toEqual(['no requests yet'])
  })
})

describe('view: git and svn', () => {
  const files = [{ kinds: ['staged' as const, 'modified' as const], path: 'src/a.ts' }, { kinds: ['untracked' as const], path: 'notes.md' }]

  test('branch, counts in words, the first paths with their marks, `+n more`', () => {
    const vcs = {
      kind: 'git' as const, repo: 'VArgus', branch: 'main', worktree: 'wt1',
      counts: { staged: 1, modified: 1, untracked: 3, conflicted: 0, ahead: 2, behind: 0 }, files, fileCount: 4,
    }
    const c = card(viewModel(input({ vcs })).cards, 'Git')
    expect(text(c.title)).toBe('Git  ·  VArgus')
    expect(c.rows.map(text)).toEqual([
      'main (wt:wt1)  ⇡2', '+1 staged   !1 modified   ?3 untracked', '  +! src/a.ts', '  ?  notes.md', '  +2 more',
    ])
  })

  test('clean; svn with its revision; no repository, no card', () => {
    const clean = { kind: 'git' as const, branch: 'main', counts: { staged: 0, modified: 0, untracked: 0, conflicted: 0, ahead: 0, behind: 0 } }
    expect(card(viewModel(input({ vcs: clean })).cards, 'Git').rows.map(text)).toEqual(['main', 'clean'])
    const svn = { kind: 'svn' as const, branch: 'trunk', revision: '12', counts: clean.counts }
    expect(text(card(viewModel(input({ vcs: svn })).cards, 'SVN').rows[0]!)).toBe('trunk@12')
    expect(viewModel(input()).cards.flat().map(c => text(c.title))).toEqual(['Limits', 'Context', 'Tokens'])
  })

  test('a long path keeps its end', () => {
    expect(cut('src/render/fragments/limits.ts', 12, true)).toBe('…s/limits.ts')
    expect(cut('abcdef', 4)).toBe('abc…')
  })
})

describe('view: layout and colour', () => {
  test(`side by side from ${SIDE_BY_SIDE} columns, the two widths making the row`, () => {
    expect(viewModel(input({ columns: SIDE_BY_SIDE - 1 })).cards.map(r => r.length)).toEqual([1, 1, 1])
    const wide = viewModel(input({ columns: 121 })).cards
    expect(wide.map(r => r.length)).toEqual([1, 2])
    expect(wide[1]!.map(c => c.width)).toEqual([60, 61])
  })

  test('every row fits its card at 40, 76 and 140 columns', () => {
    const agents = { list: [agent(MAIN, '', 123_456, 7_890), agent('a1', 'a-very-long-agent-type-name', 1, 1, { detail: 'a long description of the task' })] }
    const vcs = { kind: 'git' as const, branch: 'main', counts: { staged: 1, modified: 0, untracked: 0, conflicted: 0, ahead: 0, behind: 0 },
      files: [{ kinds: ['staged' as const], path: 'a/very/long/path/that/does/not/fit/in/forty/columns.ts' }], fileCount: 1 }
    for (const columns of [40, 76, 140]) {
      const m = viewModel(input({ limits: FULL_LIMITS, session: { contextPercent: 50, contextTokens: 1, contextWindow: 2 }, agents, vcs, columns }))
      for (const row of m.cards) {
        for (const c of row) {
          const inner = (c.width ?? columns) - 4
          for (const r of c.rows) expect([columns, text(r), stringWidth(text(r)) <= inner]).toEqual([columns, text(r), true])
        }
      }
    }
  })

  test('NO_COLOR: no colour on any run, no border colour', () => {
    const m = viewModel(input({ limits: FULL_LIMITS, session: { contextPercent: 50 }, noColor: true }))
    const runs = [m.header, m.footer, ...m.cards.flat().flatMap(c => [c.title, ...c.rows])].flat()
    expect(runs.filter(s => s.color !== undefined)).toEqual([])
    expect(m.border).toBeUndefined()
    expect(viewModel(input()).border).toBe('#3f3f3f')
  })

  test('the clock: today, this week, beyond', () => {
    expect(clockTime(en, at(16, 23, 5), NOW)).toBe('23:05')
    expect(clockTime(en, at(20, 7, 0), NOW)).toBe('Tue 07:00')
    expect(clockTime(en, at(30, 0, 0), NOW)).toBe('10-30 00:00')
  })
})

// DESIGN, "Languages": with labels `⟦<key>⟧` no letter is left once the
// labels, the data and the numbers with their units are taken out.
describe('view: every word from the labels', () => {
  test('all cards filled', () => {
    const marked = Object.fromEntries(Object.keys(en).map(k => [k, `⟦${k}⟧`])) as Labels
    marked.viewWeekdays = en.viewWeekdays.split(' ').map((_, i) => `⟦day${i}⟧`).join(' ')
    const m = viewModel(input({
      labels: marked, limits: FULL_LIMITS, session: { contextPercent: 50, contextTokens: 1, contextWindow: 2, model: 'claude-opus-5-5', effort: 'high', startedAt: NOW - 60_000 },
      agents: { list: [agent(MAIN, '', 1, 1), agent('a1', 'Explore', 1, 1, { detail: 'find' })] },
      vcs: { kind: 'git', repo: 'VArgus', branch: 'main', counts: { staged: 1, modified: 1, untracked: 1, conflicted: 1, ahead: 1, behind: 1 },
        files: [{ kinds: ['staged'], path: 'a.ts' }], fileCount: 3 },
    }))
    const all = [m.header, m.footer, ...m.cards.flat().flatMap(c => [c.title, ...c.rows])].map(text).join('\n')
    let s = all.replace(/⟦\w+⟧/g, '')
    for (const d of ['~/proj', 'opus', 'high', 'Explore', 'find', 'VArgus', 'main', 'a.ts', 'fb']) s = s.split(d).join('')
    s = s.replace(/(\d+[dhm])+/g, '').replace(/\d+(\.\d+)?[kM]?/g, '')
    expect(s.match(/[A-Za-z]+/g)).toBeNull()
  })
})

describe('parseGitFiles / parseSvnFiles', () => {
  test('git porcelain v2: each entry kind, a rename by its new path, a path with spaces', () => {
    const out = [
      '# branch.oid abc', '# branch.head main',
      '1 M. N... 100644 100644 100644 aaa bbb src/a.ts',
      '1 .M N... 100644 100644 100644 aaa bbb src/b c.ts',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new.ts\told.ts',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.ts',
      '? notes.md',
    ].join('\n')
    expect(parseGitFiles(out)).toEqual({
      files: [
        { kinds: ['staged'], path: 'src/a.ts' }, { kinds: ['modified'], path: 'src/b c.ts' },
        { kinds: ['staged'], path: 'new.ts' }, { kinds: ['conflicted'], path: 'conflict.ts' },
        { kinds: ['untracked'], path: 'notes.md' },
      ],
      fileCount: 5,
    })
  })

  test(`git: the first ${MAX_FILES} kept, all counted`, () => {
    const out = Array.from({ length: 12 }, (_, i) => `? f${i}`).join('\n')
    const r = parseGitFiles(out)
    expect([r.files.length, r.fileCount, r.files.at(-1)!.path]).toEqual([MAX_FILES, 12, `f${MAX_FILES - 1}`])
  })

  test('svn status --xml: changed entries in their bucket, clean ones skipped, entities read', () => {
    const xml = `<?xml version="1.0"?><status><target path=".">
<entry path="a&amp;b.c"><wc-status item="modified" props="none" revision="3"></wc-status></entry>
<entry path="clean.c"><wc-status item="normal" props="none" revision="3"></wc-status></entry>
<entry path="new.c"><wc-status item="unversioned" props="none"></wc-status></entry>
</target></status>`
    expect(parseSvnFiles(xml)).toEqual({
      files: [{ kinds: ['modified'], path: 'a&b.c' }, { kinds: ['untracked'], path: 'new.c' }], fileCount: 2,
    })
  })
})
