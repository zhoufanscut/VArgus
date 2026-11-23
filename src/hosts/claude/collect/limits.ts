// The rate limits (DESIGN, "Data sources"; "Usage cache and staleness"):
//
// - five_hour / seven_day come from the engine: `$.session.usage()` at
//   session.start, then pushed by `session.measure` after each main-thread
//   turn and when a window moves a whole point.
// - Kimi Code's five-hour and monthly-total windows come from its direct
//   usage API after an exact coding base-URL match, using the existing env
//   credential and cached in `$.store` per provider and config directory.
//   Anthropic OAuth usage is not polled; session.authorize() is not called.

import type { ApiError } from '../../../core/limits'
import type { ClaudeLimits, UsageData } from '../quota'
import type { EngineInterface, HttpInit, SessionMeasureInput, SessionStartInput, Timer } from 'claude-code'
import { directUsageProvider } from './usage-providers'

// What `$.store` keeps per provider and config directory, shared across sessions.
export type UsageCache = {
  data: UsageData | null
  lastSuccessAt: number | null
  error: ApiError | null
  // no read before this time ($.clock ms): the poll interval or a backoff
  retryAt: number
  // 429s in a row, for the backoff
  rateLimitedCount: number
}

// Poll interval on success.
export const POLL_MS = 90_000
// How often the store is checked: picks up another session's read and ends a
// backoff close to its time, without a request.
export const CHECK_MS = 15_000
// A failed read is retried after this.
export const RETRY_MS = 120_000
// Sustained 429s back off up to this; a Retry-After counts up to an hour.
export const MAX_429_BACKOFF_MS = 5 * 60_000
export const MAX_RETRY_AFTER_MS = 60 * 60_000
// Module values start over on a hot reload, which runs session.start again
// (DESIGN, "The host"); the cache in $.store carries the numbers across.
let timer: Timer | null = null

export function stopLimits(): void {
  timer?.cancel()
  timer = null
}
let reading = false

// register.ts calls these from its own hooks: the validator refuses an event
// hooked twice without a matcher anywhere in the module graph.

// From session.measure: the engine's windows, pushed after each main-thread
// turn and when a window moves a whole point (types, 'session.measure').
export function measuredLimits($: EngineInterface, values: ClaudeLimits, e: SessionMeasureInput): void {
  void $
  values.engine = [...e.rateLimits]
}

// From session.start. Only an interactive session shows a line (DESIGN, "When
// the line is written"). Returns at once: the engine awaits the first
// session.start before the first prompt, and a read can take up to 30 s.
export function startLimits($: EngineInterface, values: ClaudeLimits, e: SessionStartInput): void {
  if (!e.isInteractive) return
  timer?.cancel()
  timer = $.clock.every(CHECK_MS, () => {
    readUsage($, values).catch(() => {})
  })
  firstRead($, values).catch(() => {})
}

async function firstRead($: EngineInterface, values: ClaudeLimits): Promise<void> {
  values.engine = [...(await $.session.usage()).rateLimits]
  await readUsage($, values)
}

function show(values: ClaudeLimits, cache: UsageCache | null): void {
  values.api = cache?.data ?? null
  values.lastSuccessAt = cache?.lastSuccessAt ?? null
  values.error = cache?.error ?? null
}

function asCache(stored: unknown): UsageCache | null {
  return stored && typeof stored === 'object' && typeof (stored as UsageCache).retryAt === 'number'
    ? (stored as UsageCache)
    : null
}

type UsageRequest = {
  url: string
  init?: HttpInit
  parse: (body: unknown) => UsageData | null
}

// One read for a matching direct usage provider: use the shared cache when
// fresh (this or another session read it), else fetch the provider API.
// Keyed by provider and CLAUDE_CONFIG_DIR so profiles keep separate caches.
async function readUsage($: EngineInterface, values: ClaudeLimits): Promise<void> {
  if (reading) return
  reading = true
  try {
    const provider = directUsageProvider(await $.env.get('ANTHROPIC_BASE_URL'))
    if (!provider) return show(values, null)
    // Literal names: plugin validation lists every environment variable read.
    const token = (await $.env.get('ANTHROPIC_AUTH_TOKEN'))?.trim()
      || (await $.env.get('ANTHROPIC_API_KEY'))?.trim()
    if (!token) return show(values, null)
    const key = `usage:${provider.id}:${(await $.env.get('CLAUDE_CONFIG_DIR')) ?? ''}`
    const request: UsageRequest = {
      url: provider.usageUrl,
      init: { headers: { Authorization: `Bearer ${token}` } },
      parse: provider.parse,
    }
    const now = await $.clock.now()
    const cache = asCache(await $.store.get(key))
    if (cache && now < cache.retryAt) return show(values, cache)
    const next = await fetchUsage($, cache, now, request)
    show(values, next)
    // Older plugin sessions sharing this store iterate data.others when enabled.
    await $.store.set(key, next.data ? { ...next, data: { others: [], ...next.data } } : next)
  } finally {
    reading = false
  }
}

async function fetchUsage(
  $: EngineInterface,
  cache: UsageCache | null,
  now: number,
  request: UsageRequest,
): Promise<UsageCache> {
  const failed = (error: ApiError, retryAt: number, rateLimitedCount = 0): UsageCache => ({
    data: cache?.data ?? null,
    lastSuccessAt: cache?.lastSuccessAt ?? null,
    error,
    retryAt,
    rateLimitedCount,
  })
  let res
  try {
    res = await $.http.fetch(request.url, request.init)
  } catch {
    // refused (a policy), timed out, unreachable
    return failed('network', now + RETRY_MS)
  }
  if (res.status === 429) {
    const count = (cache?.rateLimitedCount ?? 0) + 1
    const backoff = Math.max(POLL_MS, Math.min(POLL_MS * 2 ** (count - 1), MAX_429_BACKOFF_MS))
    return failed('rate_limited', now + Math.max(backoff, retryAfterMs(res.headers['retry-after'])), count)
  }
  if (res.status === 401) return failed('auth', now + RETRY_MS)
  // 403 is what a region block answers too, which no credential fixes: a
  // network error, not auth.
  if (res.status !== 200) return failed('network', now + RETRY_MS)
  let data: UsageData | null = null
  try {
    data = request.parse(JSON.parse(res.text))
  } catch {
    // not JSON: a proxy or captive portal answering 200
  }
  if (!data) return failed('network', now + RETRY_MS)
  return { data, lastSuccessAt: now, error: null, retryAt: now + POLL_MS, rateLimitedCount: 0 }
}

// A 429's Retry-After in ms: the delta-seconds form only (an HTTP date is
// ignored), capped at an hour so a huge value cannot freeze the reads.
export function retryAfterMs(value: string | undefined): number {
  if (typeof value !== 'string' || !/^\s*\d+\s*$/.test(value)) return 0
  return Math.min(parseInt(value, 10) * 1000, MAX_RETRY_AFTER_MS)
}
