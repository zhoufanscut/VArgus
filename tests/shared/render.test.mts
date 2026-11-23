import { staleLine } from '../../src/render/freshness.ts'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import type { Fragment, FragmentInput, Values } from '../../src/core/types.ts'
import { resolveLabels } from '../../src/i18n/index.ts'
import { en } from '../../src/i18n/en.ts'
import { DEFAULTS, resolveOptions, type Options } from '../../src/options.ts'
import { ORDER, render } from '../../src/render/index.ts'
import { limits } from '../../src/render/fragments/limits.ts'
import { initialSession } from '../../src/core/session.ts'
import { displaySession, shortModelName } from '../../src/render/session.ts'
import { initialVcs } from '../../src/core/vcs.ts'
import { makeTheme } from '../../src/theme/index.ts'

// The composer (DESIGN, "When the line is written", "Fragments", "Config").

function input(columns?: number, o: Partial<Options> = {}): FragmentInput {
  const v: Values = {
    core: { cwd: '/home/u/proj/x', home: '/home/u', columns, isWsl: false },
    session: initialSession(),
    limits: [],
    vcs: initialVcs(),
  }
  return { v, display: displaySession(v.session, shortModelName), o: { ...DEFAULTS, ...o }, l: en, t: makeTheme('graphite', true), now: 0 }
}

const text = (s: string): Fragment => () => s

describe('render', () => {
  test('VantageHUD order, each behind its option', () => {
    assert.deepEqual(ORDER.map(([option]) => option), [
      'folder', 'model', 'rateLimits', 'context', 'tokens', 'session', 'callCounts', 'repo', 'branch', 'status',
    ])
    assert.equal(render(input(), [['folder', text('a')], ['model', text('b')]]), 'a | b')
    assert.equal(render(input(undefined, { model: false }), [['folder', text('a')], ['model', text('b')]]), 'a')
  })

  test('a fragment that throws or returns null is left out, not the line', () => {
    const boom: Fragment = () => {
      throw new Error('x')
    }
    assert.equal(render(input(), [['folder', text('a')], ['model', boom], ['context', () => null], ['tokens', text('d')]]), 'a | d')
  })

  test('too narrow: whole fragments dropped from the end; no width: nothing dropped', () => {
    const order = [['folder', text('aaaa')], ['model', text('bbbb')], ['context', text('cccc')]] as const
    assert.equal(render(input(undefined), order), 'aaaa | bbbb | cccc')
    assert.equal(render(input(18), order), 'aaaa | bbbb | cccc')
    assert.equal(render(input(17), order), 'aaaa | bbbb')
    assert.equal(render(input(2), order), 'aaaa')
  })

  test('the stub-free fragments run: folder', () => {
    assert.equal(render(input(), [['folder', ORDER[0]![1]]]), '~/proj/x')
  })

  test('folder folds after home shortening only when it omits an ancestor and shortens the label', () => {
    function label(cwd: string, width = 24, home = '/home/u') {
      const f = input(undefined, { folderFoldThreshold: width })
      Object.assign(f.v.core, { cwd, home })
      return render(f, [ORDER[0]!])
    }
    assert.equal(label('/home/u/abcdefghijklmnopqrst/x'), '~/abcdefghijklmnopqrst/x')
    assert.equal(label('/home/u/work/company/platform/services/payments/api/'), '.../payments/api')
    assert.equal(label('/home/u/projects/payments/api'), '~/projects/payments/api')
    assert.equal(label('/home/u/projects/payments/api', 16), '.../payments/api')
    assert.equal(label('/work/company/enterprise-payments/api-server'), '.../enterprise-payments/api-server')
    assert.equal(label('/abcdefghijklmnop', 8), '/abcdefghijklmnop')
    assert.equal(label('/a/very-long-second-part', 8), '/a/very-long-second-part')
    assert.equal(label('///a///b///', 2), '///a///b///')
    assert.equal(label('/ab/b/c', 2), '/ab/b/c')
    assert.equal(label('/abc/b/c', 2), '.../b/c')
    assert.equal(label('C:\\', 1), 'C:\\')
    assert.equal(label('/var/work/company/platform/services/billing/api'), '.../billing/api')
    assert.equal(label('/work/company/services/payments/api-server'), '.../payments/api-server')
    assert.equal(label('C:\\Users\\u\\company\\platform\\payments\\api', 16, 'C:\\Users\\u'), '.../payments/api')
    assert.equal(label('\\\\server\\shared\\platform\\payments\\api', 16), '.../payments/api')
    assert.equal(label('/a/long/directory/a\\b/api', 16), '.../a\\b/api')
    assert.equal(label('/work/company/abcdefghijklmnop/api', 16), '.../abcdefghijklmnop/api')
    assert.equal(label('/work/company/p/abcdefghijklmnop', 16), '.../p/abcdefghijklmnop')
    assert.equal(label('/home/u/abcdefghijklmnop', 16), '~/abcdefghijklmnop')
    assert.equal(label('/company/projects/界界界界界/api', 16), '.../界界界界界/api')
    assert.equal(label('/home/u/界界界界界/api', 11), '~/界界界界界/api')
    assert.equal(label('/home/u/work/界界界界界/api', 11), '.../界界界界界/api')
    assert.equal(label('/company/projects/p/' + 'e\u0301'.repeat(20), 8), '.../p/' + 'e\u0301'.repeat(20))
  })
})

describe('options and labels', () => {
  test('defaults as VantageHUD, theme graphite; wrong types keep the default', () => {
    assert.deepEqual(resolveOptions({}), DEFAULTS)
    assert.deepEqual(resolveOptions({ effort: false, theme: 'ember', folder: 'no' }), {
      ...DEFAULTS, effort: false, theme: 'ember',
    })
    assert.equal(Object.hasOwn(resolveOptions({ spendLimit: true }), 'spendLimit'), false)
    assert.equal(resolveOptions({ folderFoldThreshold: 16 }).folderFoldThreshold, 16)
    for (const width of [0, -1, 16.5, Infinity, '16']) {
      assert.equal(resolveOptions({ folderFoldThreshold: width }).folderFoldThreshold, 24)
    }
    assert.equal(Object.hasOwn(resolveOptions({ workflowRuns: true }), 'workflowRuns'), false)
  })

  test('an unknown language tag, constructor included, falls back to English', () => {
    assert.equal(resolveLabels('en'), en)
    assert.equal(resolveLabels('constructor'), en)
    assert.equal(resolveLabels('xx'), en)
  })
})

test('quota windows retain labels, clamp percents, format reset times, and paint all API badges in alert', () => {
  const f = input()
  f.v.limits = [
    { label: 'account-a/5h', percent: 10, resetsAt: null },
    { label: 'account-b/5h', percent: 120, resetsAt: 3600000 },
    { label: 'provider/day\n', percent: 30, resetsAt: null },
    { label: 'expired', percent: 99, resetsAt: 0 },
  ]
  assert.equal(limits(f), 'account-a/5h:10% account-b/5h:100%(1h0m) provider/day?:30%')

  const styled = input()
  styled.t = makeTheme('graphite', false)
  styled.v.limits = ['rate_limited', 'auth', 'network']
  assert.equal(
    limits(styled),
    [
      styled.t.paint('alert', '[API 429]'),
      styled.t.paint('alert', '[API auth]'),
      styled.t.paint('alert', '[API err]'),
    ].join(' '),
  )
})

test('stale rows style the separator and marker, fit complete readings, handle WSL and leave empty rows empty', () => {
  const row = 'sol | ctx:7% | token:3.2k'
  assert.equal(staleLine(row), row + ' | ⌛stale')
  assert.equal(staleLine(row, 22), 'sol | ctx:7% | ⌛stale')
  assert.equal(staleLine(row, 8), '⌛stale')
  assert.equal(staleLine(''), '')
  const t = makeTheme('graphite', false)
  const sep = t.paint('sep', ' | ')
  assert.equal(
    staleLine('sol' + sep + 'ctx:7%' + sep + 'token:3.2k', 22, { t }),
    'sol' + sep + 'ctx:7%' + sep + '⌛' + t.paint('label', 'stale'),
  )
  assert.equal(
    staleLine('sol' + sep + 'ctx:7%' + sep + 'token:3.2k', 8, { t }),
    '⌛' + t.paint('label', 'stale'),
  )
  assert.equal(
    staleLine('sol' + sep + 'ctx:7%' + sep + 'token:3.2k', 22, { t, isWsl: true }),
    'sol' + sep + 'ctx:7%' + sep + t.paint('label', '!:stale'),
  )
  assert.equal(staleLine(row, 8, { isWsl: true }), '!:stale')

  // Coloured trimming matches only rendered sep tokens, never literal ` | ` inside names.
  const folderPipe = input()
  folderPipe.t = t
  folderPipe.v.core.cwd = '/home/u/a | b'
  folderPipe.v.session.model = 'claude-opus-5-5'
  folderPipe.v.session.effort = 'high'
  folderPipe.display = displaySession(folderPipe.v.session, shortModelName)
  const folderRow = render(folderPipe)
  assert.equal(staleLine(folderRow, 15, { t }), '⌛' + t.paint('label', 'stale'))

  const repoPipe = input()
  repoPipe.t = t
  repoPipe.v.core.cwd = '/home/u/x'
  repoPipe.v.session.model = 'claude-opus-5-5'
  repoPipe.v.session.effort = 'high'
  repoPipe.display = displaySession(repoPipe.v.session, shortModelName)
  repoPipe.v.vcs = { ...initialVcs(), kind: 'git', repo: ' | foo', branch: 'main' }
  const repoRow = render(repoPipe)
  const expectedPrefix = render({ ...repoPipe, o: { ...DEFAULTS, repo: false, branch: false } })
  assert.equal(staleLine(repoRow, 43, { t }), expectedPrefix + sep + '⌛' + t.paint('label', 'stale'))

  const wtPipe = input()
  wtPipe.t = t
  wtPipe.v.core.cwd = '/home/u/x'
  wtPipe.v.session.model = 'claude-opus-5-5'
  wtPipe.v.session.effort = 'high'
  wtPipe.display = displaySession(wtPipe.v.session, shortModelName)
  wtPipe.v.vcs = { ...initialVcs(), kind: 'git', repo: 'R', branch: 'main', worktree: 'wt | 2' }
  const wtRow = render(wtPipe)
  const beforeBranch = render({ ...wtPipe, o: { ...DEFAULTS, branch: false } })
  assert.equal(staleLine(wtRow, 64, { t }), beforeBranch + sep + '⌛' + t.paint('label', 'stale'))

  // Idempotent on rows that already end with the stale marker (including narrower refits).
  assert.equal(staleLine(staleLine(row)), row + ' | ⌛stale')
  assert.equal(staleLine(staleLine(row), 22), 'sol | ctx:7% | ⌛stale')
  assert.equal(staleLine('⌛stale', 20), '⌛stale')
  assert.equal(staleLine(' | ⌛stale', 20), '⌛stale')
  const styledStale = staleLine('sol' + sep + 'ctx:7%' + sep + 'token:3.2k', 22, { t })
  assert.equal(staleLine(styledStale, 22, { t }), styledStale)
  assert.equal(staleLine('⌛' + t.paint('label', 'stale'), 20, { t }), '⌛' + t.paint('label', 'stale'))
  const wslStale = staleLine('sol' + sep + 'ctx:7%' + sep + 'token:3.2k', 22, { t, isWsl: true })
  assert.equal(staleLine(wslStale, 22, { t, isWsl: true }), wslStale)
})
