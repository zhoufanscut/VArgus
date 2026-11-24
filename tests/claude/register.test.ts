import { describe, expect, mock, test, type Engine, type MockClock } from 'claude-code/testing'
import type { ConfigRow, On, TurnStepInput } from 'claude-code'
import { makeTheme } from '../../src/theme'

// src/hosts/claude/register.ts, the wiring: each hook passes the event on and returns
// what the hooks beneath it answered, untouched; the width from the
// PromptHint viewport; NO_COLOR, the theme option and WSL as the line shows
// them; the model re-read on each tick.

type World = { lines: string[]; model: string; stepUsage: typeof SENTINEL.step.usage }

// The bottoms answer with sentinels: values no mod would make up, so a hook
// that rebuilt or replaced the answer is seen.
const SENTINEL = {
  start: { cwd: '/sentinel/start' },
  measure: { changed: ['rateLimits'] },
  // turnId and index are the step's own (the kit checks them)
  step: {
    answer: 'sentinel answer', toolUses: [], stopReason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, model: 'm' },
  },
  tool: { result: 'sentinel output' },
  compact: { messages: [{ role: 'user', text: 'sentinel summary', toolUses: [] }] },
  end: { sessionId: 'sentinel-session' },
}

function world(on: On, clock: MockClock, env: Record<string, string> = { HOME: '/home/u', NO_COLOR: '1' }, mockProcess = true): World {
  const w: World = { lines: [], model: 'claude-opus-5-5[1m]', stepUsage: SENTINEL.step.usage }
  mock.env(on, env)
  on('session.start', async () => SENTINEL.start)
  on('session.id', async () => ({ value: 'S1' }))
  on('session.cwd', async () => ({ value: '/home/u/x' }))
  on('session.model', async () => ({ value: w.model }))
  on('session.usage', async () => ({
    value: { startedAt: 0, context: { window: 200000, percent: 20 }, rateLimits: [] },
  }))
  on('fs.write', async ($, e) => {
    if (!e.path.endsWith('.live')) w.lines.push(e.text)
    return { value: undefined }
  })
  if (mockProcess) on('process.run', async () => ({
    value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('turn.step', async function* ($, e) {
    return { ...SENTINEL.step, usage: w.stepUsage, turnId: e.turnId, index: e.index } as never
  })
  on('ui.render', async () => ({ type: 'Text', children: ['sentinel hint'] }) as never)
  on('tool.call', async () => SENTINEL.tool as never)
  on('session.measure', async () => SENTINEL.measure as never)
  on('session.compact', async () => SENTINEL.compact as never)
  on('session.end', async () => SENTINEL.end)
  void clock
  return w
}

const start = { cwd: '/home/u/x', surface: 'terminal', isInteractive: true } as const

async function step($: Engine, e: Partial<TurnStepInput> = {}) {
  const s = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1, ...e })
  let r = await s.next()
  while (!r.done) r = await s.next()
  return r.value
}

// The line after the next tick.
async function line(clock: MockClock, w: World): Promise<string | undefined> {
  await clock.advance(1000)
  return w.lines.at(-1)
}

// No vcs fragments: the world answers no git.
const NO_VCS = { options: { repo: false, branch: false, status: false } }

function sharedPicker($: Engine, on: On, profile = '/home/u/.claude') {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on, clock, { HOME: '/home/u', CLAUDE_CONFIG_DIR: profile, NO_COLOR: '' }, false)
  mock.store(on)
  const provider = { plugin: 'vargus@vargus', tier: 'user' } as const
  const rows: ConfigRow[] = [
    { key: 'vargus.model', label: 'Model', kind: 'boolean', value: true, provider, isLocked: false },
    { key: 'vargus.theme', label: 'Theme', kind: 'choice', value: 'graphite', provider, isLocked: false },
    { key: 'vargus.folder', label: 'Folder', kind: 'boolean', value: true, provider, isLocked: true },
  ]
  const edits: string[] = []
  const state: { file?: string; backup?: string; rewrite: boolean } = { rewrite: false }
  const read = (path: string) => {
    if (path.endsWith('/vargus.jsonc')) return state.file
    if (path.endsWith('/picker-backups.json')) return state.backup
  }
  on('fs.exists', async ($, e) => ({ value: read(e.path) !== undefined }))
  on('fs.read', async ($, e) => {
    const text = read(e.path)
    if (text !== undefined) return { value: text }
    throw new Error('ENOENT')
  })
  on('config.list', async () => ({ value: rows }))
  on('config.set', async ($, e) => {
    const row = rows.find(item => item.key === e.key)!
    row.value = state.rewrite && e.key === 'vargus.theme' && e.value === 'ember' ? 'daylight' : e.value
    edits.push(row.key)
    return { value: row.value }
  })
  on('process.run', async ($, e) => {
    const save = e.argv.indexOf('save')
    if (save >= 0) {
      expect(e.argv[save + 1]).toBe(profile + '/plugins/data/vargus-vargus/picker-backups.json')
      const input = e.init?.stdin ?? ''
      const before = state.backup ?? ''
      expect(input.startsWith(before)).toBe(true)
      state.backup = input.slice(before.length)
    }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.run', async () => ({ text: 'opened' }))
  const command = (name: string) => $.command.run({
    command: name, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 },
  })
  return { clock, w, rows, edits, state, command }
}

describe('register: each hook returns what the hooks beneath it answered', () => {
  test('session.start, session.measure, session.compact, turn.step (the result whole), tool.call, session.end', NO_VCS, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    world(on, clock)
    expect(await $.session.start(start)).toEqual(SENTINEL.start)
    expect(await $.session.measure({ context: { window: 200000, percent: 30 }, rateLimits: [], changed: ['context'] }))
      .toEqual(SENTINEL.measure)
    expect(await $.session.compact({
      trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }],
    } as never)).toEqual(SENTINEL.compact)
    expect(await step($)).toEqual({ ...SENTINEL.step, turnId: 't1', index: 0 })
    expect(await $.tool.call({ tool: 'Bash', tool_use_id: 'u1', command: 'ls' } as never)).toEqual(SENTINEL.tool)
    expect(await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } })).toEqual(SENTINEL.end)
  })
})

describe('register: the line as the host sets it up', () => {
  test('a PromptHint viewport 20 columns wide drops whole fragments from the end', NO_VCS, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    await $.session.start(start)
    expect(await line(clock, w)).toBe('~/x | opus | ctx:20% | session:0m')
    const drawn = await $.ui.render({
      surface: 'terminal', component: 'PromptHint', requestId: 'r1',
      viewport: { columns: 20, rows: 40 }, props: { isDraft: false, isWorking: false, hint: '' },
    } as never)
    // the row it draws is the one beneath it (the kit stamps its `part`)
    expect((drawn as { children?: unknown }).children).toEqual(['sentinel hint'])
    expect(await line(clock, w)).toBe('~/x | opus | ctx:20%')
  })

  test('without NO_COLOR the line carries colour codes, graphite by default', NO_VCS, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock, { HOME: '/home/u' })
    await $.session.start(start)
    // graphite's sep #4a4a4a
    expect(await line(clock, w)).toContain('\x1b[38;2;74;74;74m | \x1b[0m')
  })

  test('effort colour follows the main step model default or high cutoff', NO_VCS, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock, { HOME: '/home/u' })
    const theme = makeTheme('graphite', false)
    await $.session.start(start)
    await step($, { model: 'claude-opus-5-5[1m]', effort: 'medium' })
    expect(await line(clock, w)).toContain(theme.paint('calm', 'medium'))
    await step($, { model: 'claude-opus-4-7', effort: 'high', agentId: 'a1' })
    expect(await line(clock, w)).toContain(theme.paint('calm', 'medium'))
    w.model = 'claude-opus-4-7'
    await step($, { model: w.model, effort: 'high' })
    expect(await line(clock, w)).toContain(theme.paint('alert', 'high'))
    w.model = 'unknown-model'
    await step($, { model: w.model, effort: 'max' })
    expect(await line(clock, w)).toContain(theme.paint('calm', 'max'))
    await step($, { model: w.model, effort: 'medium' })
    expect(await line(clock, w)).toContain(theme.paint('alert', 'medium'))
  })

  test('startup requests closure of the old detail pane and applies the saved theme',
    { options: { ...NO_VCS.options, theme: 'ember', detailView: true } }, async ($, on) => {
      const clock = mock.clock(on, { now: 0 })
      const w = world(on, clock, { HOME: '/home/u' })
      const commands: string[] = []
      const closedPanes: string[] = []
      on('command.register', async ($, e, next) => {
        commands.push(e.name)
        return next(e)
      })
      on('ui.close', async ($, e) => {
        closedPanes.push(e.id)
        return { value: undefined }
      })
      await $.session.start(start)
      // ember's sep #544b44
      expect(await line(clock, w)).toContain('\x1b[38;2;84;75;68m | \x1b[0m')
      expect(closedPanes).toEqual(['vargus'])
      expect(commands).not.toContain('vargus')
    })

  test('WSLENV set: call counts as text', NO_VCS, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock, { HOME: '/home/u', NO_COLOR: '1', WSLENV: 'WT_SESSION' })
    await $.session.start(start)
    await $.tool.call({ tool: 'Bash', tool_use_id: 'u1', command: 'ls' } as never)
    expect(await line(clock, w)).toContain('| T:1')
  })

  test('a model switch shows on the next tick, with no session.measure', NO_VCS, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    await $.session.start(start)
    expect(await line(clock, w)).toContain('| opus |')
    w.model = 'claude-sonnet-5'
    expect(await line(clock, w)).toContain('| sonnet |')
  })

  test('a picker choice equal to the native default updates the shared file and running row', NO_VCS, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    mock.store(on)
    const w = world(on, clock, undefined, false)
    const row: ConfigRow = { key: 'vargus.model', label: 'Model', kind: 'boolean', value: true,
      provider: { plugin: 'vargus@vargus', tier: 'user' }, isLocked: false }
    let file = '{ /* shared */ "model": false, "codexAutoStart": false }\n'
    let staged = ''
    const operations: string[] = []
    on('fs.exists', async ($, e) => ({ value: e.path.endsWith('/vargus.jsonc') }))
    on('fs.read', async ($, e) => {
      if (e.path.endsWith('/vargus.jsonc')) return { value: file }
      throw new Error('ENOENT')
    })
    on('fs.stat', async ($, e) => ({ value: { kind: 'file', isLink: false, realPath: e.path, size: file.length, mtimeMs: 0 } }))
    on('config.list', async () => ({ value: [row] }))
    on('config.set', async ($, e) => ({ value: e.value }))
    on('process.run', async ($, e) => {
      const index = e.argv.findIndex(arg => arg.endsWith('/replace-config.sh'))
      if (index >= 0) {
        const op = e.argv[index + 1]!
        operations.push(op)
        if (op === 'prepare') staged = e.init?.stdin?.slice(file.length) ?? ''
        if (op === 'commit') file = staged
      }
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    await $.session.start(start)
    expect(await line(clock, w)).not.toContain('opus')
    const set = { key: row.key, previous: false, value: true, provider: row.provider, origin: { kind: 'composer' } } as const
    expect(await $.config.set(set)).toEqual({ value: true })
    expect(file).toBe('{ /* shared */ "model": true, "codexAutoStart": false }\n')
    expect(await line(clock, w)).toContain('opus')
    expect(operations).toEqual(['prepare', 'commit'])
    row.isLocked = true
    file = '{"model":false}'
    await $.session.start(start)
    expect(await line(clock, w)).toContain('opus')
    file = '{invalid'
    expect((await $.config.set(set)).deny).toContain('vargus.jsonc')
    expect(file).toBe('{invalid')
  })

  test('opening the picker imports canonical values and restores omitted native choices', NO_VCS, async ($, on) => {
    const { clock, w, rows, edits, state, command } = sharedPicker($, on)
    state.file = '{"model":false,"theme":" EmBeR ","folder":false}'
    await $.session.start(start)
    expect(await line(clock, w)).not.toContain('opus')
    expect(w.lines.at(-1)).toContain('~/x')
    await command('config')
    expect(rows.map(row => row.value)).toEqual([false, 'ember', true])
    expect(edits).toEqual(['vargus.model', 'vargus.theme'])
    state.file = '{}'
    await command('reload-plugins')
    expect(await line(clock, w)).toContain('opus')
    await command('config')
    expect(rows.map(row => row.value)).toEqual([true, 'graphite', true])
  })

  test('a clean install cannot restore a choice remembered by the previous installation', NO_VCS, async ($, on) => {
    const { rows, edits, state, command } = sharedPicker($, on, '/home/u/profile\\west')
    rows[1]!.value = 'ember'
    state.file = '{"theme":"graphite"}'
    await $.session.start(start)
    await command('config')
    expect(rows[1]!.value).toBe('graphite')
    expect(edits).toEqual(['vargus.theme'])

    // Marketplace removal clears native options and plugin data. The plugin store survives.
    state.backup = undefined
    state.file = undefined
    await $.session.start(start)
    await command('config')
    expect(rows[1]!.value).toBe('graphite')
    expect(edits).toEqual(['vargus.theme'])
    expect(state.backup).toBeUndefined()
  })

  test('the renderer follows an accepted picker rewrite until the shared request changes', NO_VCS, async ($, on) => {
    const { clock, w, rows, edits, state, command } = sharedPicker($, on)
    const sep = (theme: string) => makeTheme(theme, false).paint('sep', ' | ')
    state.file = '{"theme":"ember"}'
    state.rewrite = true
    await $.session.start(start)
    expect(await line(clock, w)).toContain(sep('ember'))
    await command('config')
    expect(rows[1]!.value).toBe('daylight')
    expect(await line(clock, w)).toContain(sep('daylight'))
    await command('reload-plugins')
    await command('config')
    expect(await line(clock, w)).toContain(sep('daylight'))
    expect(edits).toEqual(['vargus.theme'])
    expect(state.file).toBe('{"theme":"ember"}')

    state.file = '{"theme":"nebula"}'
    await command('reload-plugins')
    expect(await line(clock, w)).toContain(sep('nebula'))
    state.rewrite = false
    state.file = '{"theme":"ember"}'
    await command('config')
    expect(rows[1]!.value).toBe('ember')
    expect(await line(clock, w)).toContain(sep('ember'))
  })

  test('includeSubagents syncs between vargus.jsonc and the picker and toggles the running row', NO_VCS, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    mock.store(on)
    const profile = '/home/u/.claude'
    const w = world(on, clock, { HOME: '/home/u', CLAUDE_CONFIG_DIR: profile, NO_COLOR: '1' }, false)
    const provider = { plugin: 'vargus@vargus', tier: 'user' } as const
    const row: ConfigRow = {
      key: 'vargus.includeSubagents', label: 'Include subagents', kind: 'boolean', value: false,
      provider, isLocked: false,
    }
    let file = '{"includeSubagents":true}\n'
    let staged = ''
    let backup: string | undefined
    const edits: string[] = []
    const operations: string[] = []
    on('fs.exists', async ($, e) => ({
      value: e.path.endsWith('/vargus.jsonc') || (e.path.endsWith('/picker-backups.json') && backup !== undefined),
    }))
    on('fs.read', async ($, e) => {
      if (e.path.endsWith('/vargus.jsonc')) return { value: file }
      if (e.path.endsWith('/picker-backups.json') && backup !== undefined) return { value: backup }
      throw new Error('ENOENT')
    })
    on('fs.stat', async ($, e) => ({
      value: { kind: 'file', isLink: false, realPath: e.path, size: file.length, mtimeMs: 0 },
    }))
    on('config.list', async () => ({ value: [row] }))
    on('config.set', async ($, e) => {
      row.value = e.value
      edits.push(`${e.key}=${String(e.value)}`)
      return { value: row.value }
    })
    on('process.run', async ($, e) => {
      const index = e.argv.findIndex(arg => arg.endsWith('/replace-config.sh'))
      if (index >= 0) {
        const op = e.argv[index + 1]!
        if (op === 'save') {
          const input = e.init?.stdin ?? ''
          const before = backup ?? ''
          backup = input.slice(before.length)
        } else {
          operations.push(op)
          if (op === 'prepare') staged = e.init?.stdin?.slice(file.length) ?? ''
          if (op === 'commit') file = staged
        }
      }
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('command.run', async () => ({ text: 'opened' }))
    const command = (name: string) => $.command.run({
      command: name, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 },
    })

    await $.session.start(start)
    await step($)
    await step($, { agentId: 'a1' })
    await $.tool.call({ tool: 'Bash', tool_use_id: 'u1', command: 'ls', agentId: 'a1' } as never)
    expect(await line(clock, w)).toContain('token:6(37.5%) | session:0m | 🔧1')

    // Opening /config copies the shared true choice into the picker.
    await command('config')
    expect(row.value).toBe(true)
    expect(edits).toEqual(['vargus.includeSubagents=true'])

    // Setting false in the picker (matching given default false) updates vargus.jsonc and the running row.
    const setFalse = {
      key: row.key, previous: true, value: false, provider: row.provider, origin: { kind: 'composer' },
    } as const
    expect(await $.config.set(setFalse)).toEqual({ value: false })
    expect(file).toBe('{"includeSubagents":false}\n')
    expect(operations).toEqual(['prepare', 'commit'])
    const afterFalse = await line(clock, w)
    expect(afterFalse).toContain('token:3(37.5%) | session:0m')
    expect(afterFalse).not.toContain('🔧')

    // Removing the key from vargus.jsonc and reloading/opening /config keeps the saved native false.
    file = '{}\n'
    await command('reload-plugins')
    await command('config')
    expect(row.value).toBe(false)
  })

  test('token alert threshold flips from 1M to 4M when includeSubagents is enabled', NO_VCS, async ($, on) => {
    const { clock, w, rows, state, command } = sharedPicker($, on)
    const provider = { plugin: 'vargus@vargus', tier: 'user' } as const
    rows.push({
      key: 'vargus.includeSubagents', label: 'Include subagents', kind: 'boolean', value: false,
      provider, isLocked: false,
    })
    const theme = makeTheme('graphite', false)
    const tokenText = (tone: 'calm' | 'alert', value: string) =>
      theme.paint('label', 'token:') + theme.paint(tone, value)

    await $.session.start(start)
    w.stepUsage = { input_tokens: 1_500_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' }
    await step($)
    expect(await line(clock, w)).toContain(tokenText('alert', '1.50M'))

    // Enabling includeSubagents expands the alert threshold to 4.00M (3,995,000) immediately.
    state.file = '{"includeSubagents":true}\n'
    await command('reload-plugins')
    expect(await line(clock, w)).toContain(tokenText('calm', '1.50M'))

    w.stepUsage = { input_tokens: 2_494_999, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' }
    await step($, { agentId: 'a1' })
    expect(await line(clock, w)).toContain(tokenText('calm', '3.99M'))

    w.stepUsage = { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' }
    await step($, { agentId: 'a1' })
    expect(await line(clock, w)).toContain(tokenText('alert', '4.00M'))

    // Disabling includeSubagents returns to main-only counts and the 1.00M alert threshold.
    state.file = '{"includeSubagents":false}\n'
    await command('reload-plugins')
    expect(await line(clock, w)).toContain(tokenText('alert', '1.50M'))
  })
})
