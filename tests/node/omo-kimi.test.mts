import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OmoKimi, type ProviderAuth } from '../../src/hosts/omo/kimi.ts'

const auth: ProviderAuth = { auth: { apiKey: 'test-key' }, env: { KIMI_CODE_REGION: 'global' } }
const body = { usages: {
  limit_5h: { used_ratio: '0.25', reset_time: '2026-11-14T20:00:00Z' },
  limit_month_total: { used_ratio: 0.6, reset_time: '2026-12-01T00:00:00Z' },
} }

test('Kimi plan reads five-hour and monthly usage and polls no faster than 90 seconds', async t => {
  const now = Date.parse('2026-11-14T12:00:00Z')
  t.mock.timers.enable({ apis: ['Date'], now })
  const request = t.mock.method(globalThis, 'fetch', async () => Response.json(body))
  const kimi = new OmoKimi(async () => auth)
  try {
    await kimi.refresh('kimi-coding')
    assert.deepEqual(kimi.values.api?.fiveHour, { percent: 25, resetsAt: Date.parse('2026-11-14T20:00:00Z') })
    assert.deepEqual(kimi.values.api?.monthly, { percent: 60, resetsAt: Date.parse('2026-12-01T00:00:00Z') })
    await kimi.refresh('kimi-coding')
    assert.equal(request.mock.callCount(), 1)
    t.mock.timers.setTime(now + 90_000)
    await kimi.refresh('kimi-coding')
    assert.equal(request.mock.callCount(), 2)
  } finally { kimi.dispose() }
})

test('Kimi count windows use remaining counts when aggregate five-hour ratios are unavailable', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ limits: [
    { window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
      detail: { limit: '200', remaining: '50', resetTime: '2026-11-14T20:00:00Z' } },
  ] }))
  const kimi = new OmoKimi(async () => auth)
  try {
    await kimi.refresh('kimi-coding')
    assert.equal(kimi.values.api?.fiveHour?.percent, 75)
    assert.equal(kimi.values.api?.monthly, undefined)
  } finally { kimi.dispose() }
})

test('Kimi retains its last good usage on throttling and honors Retry-After', async t => {
  const now = Date.parse('2026-11-14T12:00:00Z')
  t.mock.timers.enable({ apis: ['Date'], now })
  let throttled = false
  const request = t.mock.method(globalThis, 'fetch', async () => throttled
    ? new Response('', { status: 429, headers: { 'retry-after': '600' } }) : Response.json(body))
  const kimi = new OmoKimi(async () => auth)
  try {
    await kimi.refresh('kimi-coding')
    throttled = true
    t.mock.timers.setTime(now + 90_000)
    await kimi.refresh('kimi-coding')
    assert.equal(kimi.values.error, 'rate_limited')
    assert.equal(kimi.values.lastSuccessAt, now)
    assert.equal(kimi.values.api?.fiveHour?.percent, 25)
    t.mock.timers.setTime(now + 689_999)
    await kimi.refresh('kimi-coding')
    assert.equal(request.mock.callCount(), 2)
    t.mock.timers.setTime(now + 690_000)
    await kimi.refresh('kimi-coding')
    assert.equal(request.mock.callCount(), 3)
  } finally { kimi.dispose() }
})

test('switching away or disposing discards an in-flight Kimi reading', async t => {
  for (const dispose of [false, true]) {
    let release: (value: Response) => void = () => { throw new Error('Request did not start') }
    let notifyStarted: () => void = () => { throw new Error('Start subscription not ready') }
    const started = new Promise<void>(resolve => { notifyStarted = resolve })
    t.mock.method(globalThis, 'fetch', () => {
      notifyStarted()
      return new Promise<Response>(resolve => { release = resolve })
    })
    const kimi = new OmoKimi(async () => auth)
    const pending = kimi.refresh('kimi-coding')
    await started
    if (dispose) kimi.dispose()
    else await kimi.refresh('deepseek')
    release(Response.json(body))
    await pending
    assert.equal(kimi.values.api, null)
    assert.equal(kimi.values.error, null)
    kimi.dispose()
    t.mock.restoreAll()
  }
})

test('Kimi credentials only go to the pinned regional usage endpoint', async t => {
  for (const credential of [
    undefined,
    { auth: { apiKey: 'test-key' }, env: {} },
    { ...auth, auth: { apiKey: 'test-key', baseUrl: 'https://gateway.example/coding' } },
  ]) {
    const request = t.mock.method(globalThis, 'fetch', async () => Response.json(body))
    const kimi = new OmoKimi(async () => credential)
    try {
      await kimi.refresh('kimi-coding')
      assert.equal(request.mock.callCount(), 0)
      assert.equal(kimi.values.error, 'auth')
      assert.equal(kimi.values.api, null)
    } finally { kimi.dispose(); t.mock.restoreAll() }
  }
  const request = t.mock.method(globalThis, 'fetch', async () => Response.json(body))
  const kimi = new OmoKimi(async () => ({ ...auth, env: { KIMI_CODE_REGION: 'mainland-cn' } }))
  try {
    await kimi.refresh('kimi-coding')
    assert.equal(request.mock.calls[0]?.arguments[0], 'https://api.kimi.com/coding/v1/usages')
    assert.equal(kimi.values.api?.monthly?.percent, 60)
  } finally { kimi.dispose() }
})

test('missing usage is not fabricated as zero and failures back off', async t => {
  for (const response of [Response.json({}), new Response('', { status: 401 })]) {
    const request = t.mock.method(globalThis, 'fetch', async () => response)
    const kimi = new OmoKimi(async () => auth)
    try {
      await kimi.refresh('kimi-coding')
      assert.equal(kimi.values.api, null)
      assert.equal(kimi.values.error, response.status === 401 ? 'auth' : 'network')
      await kimi.refresh('kimi-coding')
      assert.equal(request.mock.callCount(), 1)
    } finally { kimi.dispose(); t.mock.restoreAll() }
  }
})
