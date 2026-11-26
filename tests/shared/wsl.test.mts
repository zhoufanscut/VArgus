import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { release, tmpdir } from 'node:os'
import { join } from 'node:path'

import { renderAntigravityStatusLine } from '../../src/cli/antigravity.ts'
import { themes } from '../../src/cli/themes.ts'
import { cachePath } from '../../src/hosts/antigravity/cache.ts'
import type { SessionEntry } from '../../src/hosts/omo/contracts.ts'
import vargus, { type OmoApi } from '../../src/hosts/omo/register.ts'
import { detectWsl } from '../../src/node/wsl.ts'

async function withProcessState<T>(
  envOverrides: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  fn: () => Promise<T> | T,
): Promise<T> {
  const savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const savedEnv = new Map<string, { present: boolean; value: string | undefined }>()
  for (const [key, value] of Object.entries(envOverrides)) {
    savedEnv.set(key, { present: Object.hasOwn(process.env, key), value: process.env[key] })
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', savedPlatform)
    for (const [key, entry] of savedEnv) {
      if (entry.present) process.env[key] = entry.value
      else delete process.env[key]
    }
  }
}

test('detectWsl ignores WSLENV on non-Linux platforms and requires Linux WSL signals', () => {
  // Native Windows (including Windows Terminal inheriting WSLENV)
  assert.equal(detectWsl({}, 'win32', '10.0.26100'), false)
  assert.equal(detectWsl({ WSLENV: 'WT_SESSION:WT_PROFILE_ID:' }, 'win32', '10.0.26100'), false)
  assert.equal(
    detectWsl(
      { WSLENV: 'WT_SESSION:WT_PROFILE_ID:', WSL_DISTRO_NAME: 'Ubuntu', WSL_INTEROP: '/run/WSL/123_interop' },
      'win32',
      '10.0.26100',
    ),
    false,
  )
  assert.equal(detectWsl({}, 'win32', '10.0.26100-microsoft'), false)

  // macOS
  assert.equal(
    detectWsl(
      { WSLENV: 'WT_SESSION', WSL_DISTRO_NAME: 'Ubuntu', WSL_INTEROP: '/run/WSL/123_interop' },
      'darwin',
      '24.1.0',
    ),
    false,
  )

  // Native Linux
  assert.equal(detectWsl({}, 'linux', '6.12.107+deb13-amd64'), false)
  assert.equal(detectWsl({ WSLENV: 'WT_SESSION:WT_PROFILE_ID:' }, 'linux', '6.12.107+deb13-amd64'), false)
  assert.equal(
    detectWsl({ WSL_DISTRO_NAME: '', WSL_INTEROP: '', WSLENV: '' }, 'linux', '6.12.107+deb13-amd64'),
    false,
  )

  // Real WSL on Linux
  assert.equal(detectWsl({}, 'linux', '4.4.0-19041-Microsoft'), true)
  assert.equal(detectWsl({}, 'linux', '5.15.167.4-microsoft-standard-WSL2'), true)
  assert.equal(
    detectWsl(
      { WSL_DISTRO_NAME: 'Ubuntu', WSL_INTEROP: '/run/WSL/123_interop', WSLENV: 'WT_SESSION:WT_PROFILE_ID:' },
      'linux',
      '6.6.87.2-microsoft-standard-WSL2',
    ),
    true,
  )
  assert.equal(detectWsl({ WSL_DISTRO_NAME: 'Ubuntu' }, 'linux', '6.6.10-custom'), true)
  assert.equal(detectWsl({ WSL_INTEROP: '/run/WSL/123_interop' }, 'linux', '6.6.10-custom'), true)
})

test('themes CLI uses icons on native Windows with WSLENV and text fallback on real WSL', async () => {
  const runPreview = () => {
    let out = ''
    assert.equal(themes(['graphite'], { write: chunk => { out += chunk }, noColor: true }), 0)
    return out
  }

  for (const env of [
    { WSLENV: 'WT_SESSION:WT_PROFILE_ID:', WSL_DISTRO_NAME: undefined, WSL_INTEROP: undefined },
    { WSLENV: 'WT_SESSION:WT_PROFILE_ID:', WSL_DISTRO_NAME: 'Ubuntu', WSL_INTEROP: undefined },
  ]) {
    const out = await withProcessState(env, 'win32', runPreview)
    assert.ok(out.includes('🔧73 🤖2 ⚡1'))
    assert.ok(out.includes('⌛stale'))
    assert.doesNotMatch(out, /T:73|!:stale/)
  }

  for (const env of [
    { WSL_DISTRO_NAME: 'Ubuntu', WSLENV: undefined, WSL_INTEROP: undefined },
    { WSL_INTEROP: '/run/WSL/123_interop', WSLENV: undefined, WSL_DISTRO_NAME: undefined },
  ]) {
    const out = await withProcessState(env, 'linux', runPreview)
    assert.ok(out.includes('T:73 A:2 S:1'))
    assert.ok(out.includes('!:stale'))
    assert.doesNotMatch(out, /[🔧🤖⚡⌛]/)
  }

  if (!/microsoft/i.test(release())) {
    const out = await withProcessState(
      { WSLENV: 'WT_SESSION:WT_PROFILE_ID:', WSL_DISTRO_NAME: undefined, WSL_INTEROP: undefined },
      'linux',
      runPreview,
    )
    assert.ok(out.includes('🔧73 🤖2 ⚡1'))
    assert.ok(out.includes('⌛stale'))
  }
})

test('Antigravity statusline uses icons on native Windows with WSLENV and text fallback on real WSL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-wsl-agy-'))
  try {
    const home = join(dir, 'home')
    const cacheDir = join(dir, 'cache')
    const id = 'wsl-regression-id'
    const transcript = join(home, '.gemini', 'antigravity-cli', 'brain', id, '.system_generated', 'logs', 'transcript.jsonl')
    await mkdir(join(transcript, '..'), { recursive: true })
    await writeFile(transcript, JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: '"ls"' } }],
    }) + '\n')

    const payload = { conversation_id: id, model: 'gemini-4-carbon', cwd: '/repo' }
    const runtime = { home, cacheDir, noColor: true, givenOptions: { repo: false, branch: false, status: false } }
    const transcriptCache = cachePath(cacheDir, 'transcript', transcript)

    const winHealthy = await withProcessState(
      { WSLENV: 'WT_SESSION:WT_PROFILE_ID:', WSL_DISTRO_NAME: undefined, WSL_INTEROP: undefined },
      'win32',
      () => renderAntigravityStatusLine(payload, runtime),
    )
    assert.ok(winHealthy.includes('🔧1'))
    assert.doesNotMatch(winHealthy, /T:1/)

    const savedCache = await readFile(transcriptCache, 'utf8')
    await writeFile(transcriptCache, JSON.stringify({ ...JSON.parse(savedCache), seenSkillsInTurn: 42 }))
    await appendFile(transcript, '{}\n')

    const winStale = await withProcessState(
      { WSLENV: 'WT_SESSION:WT_PROFILE_ID:', WSL_DISTRO_NAME: undefined, WSL_INTEROP: undefined },
      'win32',
      () => renderAntigravityStatusLine(payload, runtime),
    )
    assert.ok(winStale.endsWith(' | ⌛stale'))
    assert.doesNotMatch(winStale, /!:stale/)

    await writeFile(transcriptCache, savedCache)
    for (const env of [
      { WSL_DISTRO_NAME: 'Ubuntu', WSLENV: undefined, WSL_INTEROP: undefined },
      { WSL_INTEROP: '/run/WSL/123_interop', WSLENV: undefined, WSL_DISTRO_NAME: undefined },
    ]) {
      const wslHealthy = await withProcessState(env, 'linux', () => renderAntigravityStatusLine(payload, runtime))
      assert.ok(wslHealthy.includes('T:1'))
      assert.doesNotMatch(wslHealthy, /🔧1/)

      const latestCache = await readFile(transcriptCache, 'utf8')
      await writeFile(transcriptCache, JSON.stringify({ ...JSON.parse(latestCache), seenSkillsInTurn: 42 }))
      await appendFile(transcript, '{}\n')

      const wslStale = await withProcessState(env, 'linux', () => renderAntigravityStatusLine(payload, runtime))
      assert.ok(wslStale.endsWith(' | !:stale'))
      assert.doesNotMatch(wslStale, /⌛stale/)

      await writeFile(transcriptCache, latestCache)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('OmO native entry uses icons on native Windows with WSLENV and text fallback on real WSL', async t => {
  let now = 1000
  t.mock.method(Date, 'now', () => now)

  const runOmoCase = (env: Record<string, string | undefined>, platform: NodeJS.Platform) =>
    withProcessState({ ...env, NO_COLOR: '1' }, platform, () => {
      const entries: SessionEntry[] = [
        {
          id: 'settings', type: 'custom', timestamp: '', customType: 'vargus-settings',
          data: { enabled: true, options: { repo: false, branch: false, status: false } },
        },
        {
          id: 'm1', type: 'message', timestamp: '',
          message: {
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'tc1', name: 'bash', arguments: {} }],
            usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
          },
        },
      ]
      const handlers = new Map<string, (event: unknown, ctx: Context) => void>()
      type Context = Parameters<Parameters<OmoApi['on']>[1]>[1]
      let row: { render(width: number): string[]; invalidate(): void } | undefined
      let contextFail = false
      const ctx: Context = {
        modelRegistry: { getProviderAuth: async () => undefined },
        mode: 'tui', cwd: '/repo', model: { id: 'gpt-6.1-sol', provider: 'test' }, thinkingLevel: 'high',
        getContextUsage: () => {
          if (contextFail) throw new Error('collection failed')
          return { tokens: 250, contextWindow: 1000, percent: 25 }
        },
        sessionManager: {
          getSessionId: () => 'wsl-test-session',
          getEntry: id => entries.find(entry => entry.id === id),
          getHeader: () => ({ timestamp: '2026-11-14T00:00:00Z' }),
          reduceHistory: reducer => entries.reduce((state, entry) => reducer.add(state, entry), reducer.initial()),
        },
        ui: {
          setFooter() {},
          setWidget(_key, factory) { row = factory?.({ requestRender() {} }) },
          notify() {},
        },
      }
      const api: OmoApi = {
        on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
        getSubscriptionLimits: () => [],
        onSubscriptionLimits: () => () => {},
        appendEntry(customType, data) {
          entries.push({ id: String(entries.length), type: 'custom', timestamp: '', customType, data })
        },
        registerCommand() {},
      }
      vargus(api, {})
      handlers.get('session_start')?.({}, ctx)
      try {
        const live = row!.render(200)[0]!
        contextFail = true
        handlers.get('message_end')?.({}, ctx)
        now += 6000
        const stale = row!.render(200)[0]!
        return { live, stale }
      } finally {
        handlers.get('session_shutdown')?.({}, ctx)
      }
    })

  const win = await runOmoCase(
    { WSLENV: 'WT_SESSION:WT_PROFILE_ID:', WSL_DISTRO_NAME: undefined, WSL_INTEROP: undefined },
    'win32',
  )
  assert.ok(win.live.includes('🔧1'))
  assert.doesNotMatch(win.live, /T:1/)
  assert.ok(win.stale.endsWith(' | ⌛stale'))
  assert.doesNotMatch(win.stale, /!:stale/)

  for (const env of [
    { WSL_DISTRO_NAME: 'Ubuntu', WSLENV: undefined, WSL_INTEROP: undefined },
    { WSL_INTEROP: '/run/WSL/123_interop', WSLENV: undefined, WSL_DISTRO_NAME: undefined },
  ]) {
    const wsl = await runOmoCase(env, 'linux')
    assert.ok(wsl.live.includes('T:1'))
    assert.doesNotMatch(wsl.live, /🔧1/)
    assert.ok(wsl.stale.endsWith(' | !:stale'))
    assert.doesNotMatch(wsl.stale, /⌛stale/)
  }
})
