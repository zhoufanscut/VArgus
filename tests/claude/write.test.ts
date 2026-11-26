import { describe, expect, mock, test, type MockClock } from 'claude-code/testing'
import type { EngineInterface, On } from 'claude-code'

import { dataDir, homeDir, moveArgv, removeArgv, writeLine, type Writer } from '../../src/hosts/claude/write'
import { makeTheme } from '../../src/theme'
import { fixtureFsPath } from './fixture-path'

// The line file (DESIGN, "The line file"), driven through the mod's own hooks.

const DATA = '/home/u/.claude/plugins/data/vargus-vargus'

// The folder alone, uncoloured, so the line's text is known; the fragments
// have tests of their own.
const FOLDER_ONLY = {
  options: {
    model: false, rateLimits: false, context: false, tokens: false, session: false,
    callCounts: false, repo: false, branch: false, status: false,
  },
}

type World = {
  checkIns: string[]
  writes: { path: string; text: string }[]
  runs: string[][]
  id: string
  // mv's exit code, or 'throw' for a refused process
  mv: number | 'throw'
  // fs.write of a temp file throws
  tmpFails: boolean
  // a cwd function, to change the text between ticks
  cwd: () => string
  // hold each fs.write, each rm and each fs.list this long on the mock clock
  holdMs: number
  rmHoldMs: number
  listHoldMs: number
  inFlight: number
  maxInFlight: number
  started: unknown[]
  // the data folder as fs.list and fs.stat see it: entries by folder path,
  // and a folder's own time
  tree: Record<string, { name: string; kind: 'file' | 'dir' | 'other'; mtimeMs: number; isLink?: boolean }[]>
  dirTimes: Record<string, number>
}

function world(
  on: On,
  clock: MockClock,
  env: Record<string, string> = { HOME: '/home/u', NO_COLOR: '1' },
  pathStyle: 'posix' | 'drive' = 'posix',
): World {
  const w: World = {
    checkIns: [], writes: [], runs: [], id: 'S1', mv: 0, tmpFails: false, cwd: () => '/home/u/proj/x',
    holdMs: 0, rmHoldMs: 0, listHoldMs: 0, inFlight: 0, maxInFlight: 0, started: [], tree: {}, dirTimes: {},
  }
  mock.env(on, env)
  // Calls on `$` are answered `{ value }`; session.start needs a bottom too.
  on('session.start', async ($, e) => {
    w.started.push(e)
    return { cwd: e.cwd }
  })
  on('session.id', async () => ({ value: w.id }))
  on('session.cwd', async () => ({ value: w.cwd() }))
  on('ui.render', async () => ({ type: 'Text', children: ['sentinel hint'] }) as never)
  on('session.end', async ($, e) => ({ sessionId: e.sessionId }))
  const key = (path: string) => fixtureFsPath(path, pathStyle)
  on('fs.write', async ($, e) => {
    if (e.path.endsWith('/line.live')) {
      w.checkIns.push(e.text)
      return { value: undefined }
    }
    w.inFlight += 1
    w.maxInFlight = Math.max(w.maxInFlight, w.inFlight)
    if (w.holdMs) await clock.sleep(w.holdMs)
    w.inFlight -= 1
    if (w.tmpFails && e.path.endsWith('.tmp')) throw new Error('denied')
    w.writes.push({ path: key(e.path), text: e.text })
    return { value: undefined }
  })
  on('fs.list', async ($, e) => {
    if (w.listHoldMs) await clock.sleep(w.listHoldMs)
    const entries = w.tree[key(e.path ?? '')]
    if (!entries) throw new Error('ENOENT')
    return { value: entries.map(x => ({ size: 0, isLink: false, ...x, mtimeMs: x.kind === 'file' ? x.mtimeMs : 0 })) }
  })
  on('fs.stat', async ($, e) => {
    const t = w.dirTimes[key(e.path)]
    if (t === undefined) throw new Error('ENOENT')
    return { value: { kind: 'dir' as const, size: 0, mtimeMs: t, isLink: false } }
  })
  on('process.run', async ($, e) => {
    w.runs.push([...e.argv])
    if (e.argv[0] === 'rm' && w.rmHoldMs) await clock.sleep(w.rmHoldMs)
    if (w.mv === 'throw') throw new Error('refused')
    return { value: { exitCode: w.mv, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return w
}

const start = { cwd: '/home/u/proj/x', surface: 'terminal', isInteractive: true } as const

describe('line file', () => {
  test('the numeric folder threshold folds the path only when it shortens and keeps both names in full',
    { options: { ...FOLDER_ONLY.options, folderFoldThreshold: 16 } }, async ($, on) => {
      const clock = mock.clock(on, { now: 42 })
      const w = world(on, clock)
      w.cwd = () => '/home/u/work/界界界界界/api-service'
      await $.session.start({ ...start, cwd: w.cwd() })
      await clock.settle()
      expect(w.writes[0]?.text).toBe('.../界界界界界/api-service')
      w.cwd = () => '/home/u/界界界界界/api-service'
      await clock.advance(1000)
      expect(w.writes.at(-1)?.text).toBe('~/界界界界界/api-service')
    })

  test('writes a temp file, then mv puts it in place; session.start passes on unchanged', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 42 })
    const w = world(on, clock)
    await $.session.start(start)
    await clock.settle()
    expect(w.started).toEqual([start])
    expect(w.writes).toEqual([{ path: `${DATA}/S1/line.42.tmp`, text: '~/proj/x' }])
    expect(w.runs).toEqual([['mv', '-f', `${DATA}/S1/line.42.tmp`, `${DATA}/S1/line`]])
  })

  test('an idle line stays untouched even with the retired option saved; a new id writes again',
    { options: { ...FOLDER_ONLY.options, blankStopped: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1 })
    const w = world(on, clock)
    await $.session.start(start)
    await clock.advance(120_000)
    expect(w.writes).toHaveLength(1)
    expect(w.checkIns[0]).toBe('6\n~/proj/x | ⌛stale\n')
    expect(w.checkIns.at(-1)).toBe('126\n~/proj/x | ⌛stale\n')
    w.id = 'S2'
    await clock.advance(1000)
    expect(w.writes.map(x => x.path)).toEqual([`${DATA}/S1/line.1.tmp`, `${DATA}/S2/line.1.tmp`])
  })

  test('when mv fails the line is written directly, and counts as written', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 7 })
    const w = world(on, clock)
    w.mv = 1
    await $.session.start(start)
    await clock.advance(1000)
    expect(w.writes.map(x => x.path)).toEqual([`${DATA}/S1/line.7.tmp`, `${DATA}/S1/line`])
  })

  test('when mv is refused (throws) the line is written directly', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 7 })
    const w = world(on, clock)
    w.mv = 'throw'
    await $.session.start(start)
    await clock.settle()
    expect(w.writes.map(x => x.path)).toEqual([`${DATA}/S1/line.7.tmp`, `${DATA}/S1/line`])
  })

  test('one write at a time; the newest waiting text wins', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock)
    let n = 0
    w.cwd = () => `/home/u/p${n++}`
    w.holdMs = 3500
    await $.session.start(start)
    for (let i = 0; i < 7; i++) await clock.advance(1000)
    const texts = w.writes.map(x => x.text)
    expect(w.maxInFlight).toBe(1)
    expect(texts[0]).toBe('~/p0')
    expect(texts).not.toContain('~/p1')
    expect(texts).not.toContain('~/p2')
    expect(texts).toContain('~/p3')
  })

  test('CLAUDE_CONFIG_DIR picks the data folder and styles line.live with the active theme', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 3 })
    const w = world(on, clock, { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/cfg' })
    const theme = makeTheme('graphite', false)
    await $.session.start(start)
    await clock.settle()
    expect(w.writes[0]?.path).toBe('/cfg/plugins/data/vargus-vargus/S1/line.3.tmp')
    expect(w.checkIns[0]).toBe(
      `6\n${theme.bold(theme.paint('text', '~/proj/x'))}${theme.paint('sep', ' | ')}${theme.paint('label', '⌛stale')}\n`,
    )
    // A stale-style change alone refreshes line.live immediately within the 2s idle window.
    const liveWrites: string[] = []
    const stub = {
      session: { id: async () => 'S1' },
      clock: { now: async () => 3 },
      fs: {
        write: async (path: string, text: string) => {
          if (path.endsWith('/line.live')) liveWrites.push(text)
        },
      },
      process: {
        run: async () => ({ exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }),
      },
    } as unknown as EngineInterface
    const writer: Writer = { dir: '/cfg/data', tools: 'posix', tmpName: 'line.3.tmp', last: null, running: null, pending: null, ended: null }
    await writeLine(stub, writer, '~/proj/x', undefined, { t: theme, isWsl: false })
    await writeLine(stub, writer, '~/proj/x', undefined, { t: theme, isWsl: false })
    expect(liveWrites).toHaveLength(1)
    const ember = makeTheme('ember', false)
    await writeLine(stub, writer, '~/proj/x', undefined, { t: ember, isWsl: true })
    expect(liveWrites).toHaveLength(2)
    expect(liveWrites[1]).toBe(`6\n~/proj/x${ember.paint('sep', ' | ')}${ember.paint('label', '!:stale')}\n`)
  })

  test('NO_COLOR preserves whole fragments containing ` | ` in line.live and across coalesced writeLine retries', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on, clock, { HOME: '/home/u', NO_COLOR: '1' })
    w.cwd = () => '/home/u/a | b'
    await $.session.start(start)
    await clock.settle()
    await $.ui.render({
      surface: 'terminal', component: 'PromptHint', requestId: 'r1',
      viewport: { columns: 15, rows: 40 }, props: { isDraft: false, isWorking: false, hint: '' },
    } as never)
    await clock.advance(1000)
    expect(w.checkIns.at(-1)).toBe('6\n⌛stale\n')

    const plain = makeTheme('graphite', true)
    const liveWrites: string[] = []
    let releaseFirst!: () => void
    const firstWriteBlocked = new Promise<void>(resolve => { releaseFirst = resolve })
    let writesCount = 0
    const stub = {
      session: { id: async () => 'S1' },
      clock: { now: async () => 1000 },
      fs: {
        write: async (path: string, text: string) => {
          if (path.endsWith('/line.live')) liveWrites.push(text)
          else if (++writesCount === 1) {
            await firstWriteBlocked
            throw new Error('transient')
          }
        },
      },
      process: {
        run: async () => ({ exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }),
      },
    } as unknown as EngineInterface
    const writer: Writer = { dir: '/cfg/data', tools: 'posix', tmpName: 'line.1.tmp', last: null, running: null, pending: null, ended: null }
    const first = writeLine(stub, writer, '~/first', undefined, { t: plain, isWsl: false }, ['~/first'])
    const second = writeLine(stub, writer, '~/a | b | ctx:7%', 15, { t: plain, isWsl: false }, ['~/a | b', 'ctx:7%'])
    releaseFirst()
    await expect(Promise.all([first, second])).rejects.toThrow('transient')
    await writer.running
    expect(liveWrites).toEqual(['6\n⌛stale\n'])
  })

  test('a relative CLAUDE_CONFIG_DIR: nothing written', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 3 })
    const w = world(on, clock, { HOME: '/home/u', CLAUDE_CONFIG_DIR: 'rel' })
    await $.session.start(start)
    await clock.advance(1000)
    expect(w.writes).toEqual([])
  })

  test('Windows: HOME unset, the folder shortens to ~ from USERPROFILE', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 3 })
    const w = world(on, clock, { USERPROFILE: 'C:\\Users\\u', NO_COLOR: '1' }, 'drive')
    w.cwd = () => 'C:\\Users\\u\\proj'
    await $.session.start({ ...start, cwd: 'C:\\Users\\u\\proj' })
    await clock.settle()
    expect(w.writes.at(-1)?.text).toBe('~\\proj')
  })

  test('a temp file that cannot be written: no line written in place either', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 3 })
    const w = world(on, clock)
    w.tmpFails = true
    await $.session.start(start)
    await clock.advance(1000)
    expect(w.writes).toEqual([])
    expect(w.runs).toEqual([])
  })

  test('Windows: a data folder with a cmd special character is never given to cmd', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 100 * 24 * 3_600_000 })
    const w = world(on, clock, { USERPROFILE: 'C:\\Users\\u', CLAUDE_CONFIG_DIR: 'D:\\R&D\\claude' }, 'drive')
    // an old folder the prune would remove, given a command
    const data = 'D:/R&D/claude/plugins/data/vargus-vargus'
    w.tree[data] = [{ name: 'old', kind: 'dir', mtimeMs: 0 }]
    w.tree[`${data}/old`] = [{ name: 'line', kind: 'file', mtimeMs: 1 }]
    await $.session.start(start)
    await clock.settle()
    // no move: the line written in place, no temp file
    expect(w.writes.map(x => x.path)).toEqual([`${data}/S1/line`])
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'S1', resume: { id: 'S1' } } as const)
    await clock.advance(3000)
    expect(w.runs).toEqual([])
  })

  test('the move and remove commands: mv/rm, cmd.exe on Windows, none for a path cmd acts on', async () => {
    expect(moveArgv({ tools: 'posix' }, '/d/a.tmp', '/d/line')).toEqual(['mv', '-f', '/d/a.tmp', '/d/line'])
    expect(removeArgv({ tools: 'posix' }, '/d/S1')).toEqual(['rm', '-rf', '--', '/d/S1'])
    expect(moveArgv({ tools: 'cmd' }, 'C:/d/a.tmp', 'C:/d/line')).toEqual(['cmd', '/d', '/c', 'move', '/y', 'C:\\d\\a.tmp', 'C:\\d\\line'])
    expect(removeArgv({ tools: 'cmd' }, 'C:/d/S1')).toEqual(['cmd', '/d', '/c', 'rmdir', '/s', '/q', 'C:\\d\\S1'])
    // the folder or the session id
    expect(moveArgv({ tools: 'cmd' }, 'D:/a,b/a.tmp', 'D:/a,b/line')).toBeNull()
    expect(moveArgv({ tools: 'cmd' }, 'C:/d/a&b/a.tmp', 'C:/d/a&b/line')).toBeNull()
    expect(removeArgv({ tools: 'cmd' }, 'C:/d/a;b')).toBeNull()
    expect(removeArgv({ tools: 'cmd' }, 'C:/d/%x%')).toBeNull()
    // the same characters mean nothing to mv and rm
    expect(moveArgv({ tools: 'posix' }, '/a,b/a.tmp', '/a,b/line')).toEqual(['mv', '-f', '/a,b/a.tmp', '/a,b/line'])
  })

  test('the home: USERPROFILE on Windows over a HOME that is not a / path; elsewhere HOME, then USERPROFILE', async () => {
    expect(homeDir('D:\\h', 'C:\\Users\\u')).toBe('C:\\Users\\u')
    expect(homeDir('C:\\Users\\u', 'C:\\Users\\u')).toBe('C:\\Users\\u')
    // WSL with the Windows USERPROFILE passed through: its own HOME
    expect(homeDir('/home/u', 'C:\\Users\\u')).toBe('/home/u')
    expect(homeDir(undefined, 'C:\\Users\\u')).toBe('C:\\Users\\u')
    expect(homeDir('/home/u', undefined)).toBe('/home/u')
    expect(homeDir('/home/u', '/home/w')).toBe('/home/u')
    expect(homeDir(undefined, '/home/w')).toBe('/home/w')
    expect(homeDir('', '')).toBeUndefined()
  })

  test('WSL: a Windows USERPROFILE passed through leaves HOME in charge', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 3 })
    const w = world(on, clock, { HOME: '/home/u', USERPROFILE: 'C:\\Users\\u', WSL_DISTRO_NAME: 'Ubuntu', WSLENV: 'USERPROFILE', NO_COLOR: '1' })
    await $.session.start(start)
    await clock.settle()
    expect(w.runs).toEqual([['mv', '-f', `${DATA}/S1/line.3.tmp`, `${DATA}/S1/line`]])
    expect(w.checkIns[0]).toBe('6\n~/proj/x | !:stale\n')
  })

  test('Windows: HOME set elsewhere, the folder still shortens against USERPROFILE', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 3 })
    const w = world(on, clock, { HOME: 'D:\\h', USERPROFILE: 'C:\\Users\\u', NO_COLOR: '1' }, 'drive')
    w.cwd = () => 'C:\\Users\\u\\proj'
    await $.session.start({ ...start, cwd: 'C:\\Users\\u\\proj' })
    await clock.settle()
    expect(w.writes.at(-1)?.text).toBe('~\\proj')
  })

  test('Windows: HOME set elsewhere, the line still goes under USERPROFILE', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 3 })
    const w = world(on, clock, { HOME: 'D:\\h', USERPROFILE: 'C:\\Users\\u' }, 'drive')
    await $.session.start(start)
    await clock.settle()
    expect(w.runs[0]?.[5]).toBe('C:\\Users\\u\\.claude\\plugins\\data\\vargus-vargus\\S1\\line.3.tmp')
  })

  test('Windows drive paths are absolute, written with / separators', async () => {
    expect(dataDir(undefined, 'C:\\Users\\u')).toBe('C:/Users/u/.claude/plugins/data/vargus-vargus')
    expect(dataDir('D:\\cfg', 'C:\\Users\\u')).toBe('D:/cfg/plugins/data/vargus-vargus')
    expect(dataDir('D:/cfg', undefined)).toBe('D:/cfg/plugins/data/vargus-vargus')
    expect(dataDir('C:rel', undefined)).toBeNull()
    expect(dataDir('rel', '/home/u')).toBeNull()
    expect(dataDir('C:\\', undefined)).toBe('C:/plugins/data/vargus-vargus')
    expect(dataDir('/cfg/', undefined)).toBe('/cfg/plugins/data/vargus-vargus')
    expect(dataDir(undefined, 'C:\\Users\\u\\')).toBe('C:/Users/u/.claude/plugins/data/vargus-vargus')
  })

  test('Windows: cmd.exe move puts the line in place, with \\ separators', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 3 })
    const w = world(on, clock, { USERPROFILE: 'C:\\Users\\u' }, 'drive')
    await $.session.start(start)
    await clock.settle()
    const data = 'C:\\Users\\u\\.claude\\plugins\\data\\vargus-vargus\\S1'
    expect(w.runs).toEqual([['cmd', '/d', '/c', 'move', '/y', `${data}\\line.3.tmp`, `${data}\\line`]])
  })

  test('nothing is written outside an interactive session', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 3 })
    const w = world(on, clock)
    await $.session.start({ ...start, surface: null, isInteractive: false })
    await clock.advance(2000)
    expect(w.writes).toEqual([])
  })

  test('no HOME and no CLAUDE_CONFIG_DIR: nothing written', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 3 })
    const w = world(on, clock, {})
    await $.session.start(start)
    await clock.advance(1000)
    expect(w.writes).toEqual([])
  })

  test('an empty session id: nothing written', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 3 })
    const w = world(on, clock)
    w.id = ''
    await $.session.start(start)
    await clock.advance(1000)
    expect(w.writes).toEqual([])
  })
})

describe('the session folder at session.end', () => {
  const end = (reason: 'clear' | 'resume' | 'prompt_input_exit', id = 'S1') =>
    ({ reason, sessionId: id, resume: { id } }) as const
  const rm = (id: string) => ['rm', '-rf', '--', `${DATA}/${id}`]

  test('is removed, and nothing more is written for that id', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 1 })
    const w = world(on, clock)
    let n = 0
    w.cwd = () => `/home/u/p${n++}`
    await $.session.start(start)
    await clock.settle()
    expect(await $.session.end(end('prompt_input_exit'))).toEqual({ sessionId: 'S1' })
    const writes = w.writes.length
    await clock.advance(3000)
    expect(w.runs.at(-1)).toEqual(rm('S1'))
    expect(w.writes).toHaveLength(writes)
  })

  test('after /clear the old folder goes and the new id is written', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 1 })
    const w = world(on, clock)
    await $.session.start(start)
    await clock.settle()
    await $.session.end(end('clear'))
    w.id = 'S2'
    await clock.advance(1000)
    expect(w.runs).toContainEqual(rm('S1'))
    expect(w.writes.map(x => x.path)).toEqual([`${DATA}/S1/line.1.tmp`, `${DATA}/S2/line.1.tmp`])
  })

  test('a write in flight finishes before the folder is removed', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 1 })
    const w = world(on, clock)
    w.holdMs = 500
    await $.session.start(start)
    // the first write is held in fs.write
    await clock.advance(100)
    expect(w.inFlight).toBe(1)
    const ending = $.session.end(end('prompt_input_exit'))
    await clock.advance(400)
    await ending
    expect(w.runs.map(r => r[0])).toEqual(['mv', 'rm'])
  })

  test('an id that is not a plain name is not removed', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 1 })
    const w = world(on, clock)
    await $.session.start(start)
    await clock.settle()
    for (const id of ['..', 'a/b', '']) await $.session.end(end('prompt_input_exit', id))
    expect(w.runs.filter(r => r[0] === 'rm')).toEqual([])
  })

  test('a later resume of the ended session writes its line again', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 1 })
    const w = world(on, clock)
    await $.session.start(start)
    await clock.settle()
    await $.session.end(end('clear'))
    w.id = 'S2'
    await clock.advance(1000)
    await $.session.end(end('resume', 'S2'))
    w.id = 'S1'
    await clock.advance(1000)
    expect(w.writes.map(x => x.path).at(-1)).toBe(`${DATA}/S1/line.1.tmp`)
  })

  test('Windows: removed with cmd.exe rmdir', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 1 })
    const w = world(on, clock, { USERPROFILE: 'C:\\Users\\u' }, 'drive')
    await $.session.start(start)
    await clock.settle()
    await $.session.end(end('prompt_input_exit'))
    await clock.advance(3000)
    expect(w.runs.at(-1)).toEqual(['cmd', '/d', '/c', 'rmdir', '/s', '/q', 'C:\\Users\\u\\.claude\\plugins\\data\\vargus-vargus\\S1'])
  })

  test('nothing is written while the removal runs', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 1 })
    const w = world(on, clock)
    let n = 0
    w.cwd = () => `/home/u/p${n++}`
    w.rmHoldMs = 1500
    await $.session.start(start)
    await clock.settle()
    const writes = w.writes.length
    const ending = $.session.end(end('prompt_input_exit'))
    await clock.advance(2000)
    await ending
    expect(w.runs.at(-1)).toEqual(rm('S1'))
    expect(w.writes).toHaveLength(writes)
  })

  test('a relative CLAUDE_CONFIG_DIR: nothing removed', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 1 })
    const w = world(on, clock, { HOME: '/home/u', CLAUDE_CONFIG_DIR: 'rel' })
    await $.session.start(start)
    await clock.settle()
    await $.session.end(end('prompt_input_exit'))
    expect(w.runs).toEqual([])
  })

  test('outside an interactive session nothing is removed', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: 1 })
    const w = world(on, clock)
    await $.session.start({ ...start, surface: null, isInteractive: false })
    await $.session.end(end('prompt_input_exit'))
    expect(w.runs).toEqual([])
  })
})

describe('the age prune at session.start', () => {
  const DAY = 24 * 3_600_000
  const NOW = 100 * DAY
  const removed = (w: World) => w.runs.filter(r => r[0] === 'rm').map(r => r[3])
  const file = (name: string, daysAgo: number) => ({ name, kind: 'file' as const, mtimeMs: NOW - daysAgo * DAY })
  const dir = (name: string, extra: { isLink?: boolean; kind?: 'dir' | 'other' } = {}) =>
    ({ name, kind: 'dir' as const, mtimeMs: 0, ...extra })

  test('removes a folder idle 14 days, keeps a newer one and the current session', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const w = world(on, clock)
    w.tree[DATA] = [dir('old'), dir('new'), dir('S1'), dir('tmpnew')]
    w.tree[`${DATA}/old`] = [file('line', 15)]
    w.tree[`${DATA}/new`] = [file('line', 13)]
    w.tree[`${DATA}/S1`] = [file('line', 30)]
    // an old line beside a newer temp file: idle by the newest
    w.tree[`${DATA}/tmpnew`] = [file('line', 30), file('line.5.tmp', 2)]
    await $.session.start(start)
    await clock.settle()
    expect(removed(w)).toEqual([`${DATA}/old`])
  })

  test('idle exactly 14 days is old enough', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const w = world(on, clock)
    w.tree[DATA] = [dir('edge')]
    w.tree[`${DATA}/edge`] = [file('line', 14)]
    await $.session.start(start)
    await clock.settle()
    expect(removed(w)).toEqual([`${DATA}/edge`])
  })

  test('session.start does not wait for it', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const w = world(on, clock)
    w.tree[DATA] = [dir('old')]
    w.tree[`${DATA}/old`] = [file('line', 30)]
    w.listHoldMs = 5000
    let started = false
    const starting = $.session.start(start).then(() => { started = true })
    await clock.advance(10)
    expect(started).toBe(true)
    await clock.advance(10_000)
    await starting
    expect(removed(w)).toEqual([`${DATA}/old`])
  })

  test('Windows: an old folder is removed with cmd.exe rmdir', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const w = world(on, clock, { USERPROFILE: 'D:\\Users\\u' }, 'drive')
    const data = 'D:/Users/u/.claude/plugins/data/vargus-vargus'
    w.tree[data] = [dir('old'), dir('S1')]
    w.tree[`${data}/old`] = [file('line', 30)]
    w.tree[`${data}/S1`] = [file('line', 30)]
    await $.session.start(start)
    await clock.settle()
    expect(w.runs.filter(r => r[3] === 'rmdir')).toEqual([
      ['cmd', '/d', '/c', 'rmdir', '/s', '/q', 'D:\\Users\\u\\.claude\\plugins\\data\\vargus-vargus\\old'],
    ])
  })

  test('only plain folders named like an id: not a link, a file or another name', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const w = world(on, clock)
    w.tree[DATA] = [
      dir('link', { isLink: true, kind: 'other' }), file('stray', 30), dir('a.b'), dir('ok'),
    ]
    for (const n of ['link', 'a.b', 'ok']) w.tree[`${DATA}/${n}`] = [file('line', 30)]
    await $.session.start(start)
    await clock.settle()
    expect(removed(w)).toEqual([`${DATA}/ok`])
  })

  test('an empty folder goes by its own time', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const w = world(on, clock)
    w.tree[DATA] = [dir('emptyold'), dir('emptynew')]
    w.tree[`${DATA}/emptyold`] = []
    w.tree[`${DATA}/emptynew`] = []
    w.dirTimes[`${DATA}/emptyold`] = NOW - 20 * DAY
    w.dirTimes[`${DATA}/emptynew`] = NOW - 1 * DAY
    await $.session.start(start)
    await clock.settle()
    expect(removed(w)).toEqual([`${DATA}/emptyold`])
  })

  test('a relative CLAUDE_CONFIG_DIR: nothing pruned', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const w = world(on, clock, { HOME: '/home/u', CLAUDE_CONFIG_DIR: 'rel' })
    w.tree['rel/plugins/data/vargus-vargus'] = [dir('old')]
    w.tree['rel/plugins/data/vargus-vargus/old'] = [file('line', 30)]
    await $.session.start(start)
    await clock.settle()
    expect(removed(w)).toEqual([])
  })

  test('no data folder yet: nothing removed', FOLDER_ONLY, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const w = world(on, clock)
    await $.session.start(start)
    await clock.settle()
    expect(removed(w)).toEqual([])
  })
})
