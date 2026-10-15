import type { EngineInterface, SessionMeasureInput, SessionRateLimit, SessionStartInput, Timer } from 'claude-code'

// The rate limits (DESIGN, "Data sources"; "Rules carried over from
// VantageHUD": Usage API, Usage cache and staleness).
//
// - five_hour / seven_day / spend_limit are the engine's: `$.session.usage()`
//   at session.start, then pushed by `session.measure` after each main-thread
//   turn and when a window moves a whole point. Never marked stale.
// - Per-model weekly (sn, op, others) and extra usage come only from the OAuth
//   usage API, read every 90 s and cached in `$.store` per account.
//
// Left as they are: two sessions of one account can fetch at the same moment
// (no lock; the store's last write wins, both results are good); the first
// API read of a session shows nothing for sn/op/extra until it answers.

export type Bucket = { percent: number; resetsAt: number | null }
export type ModelBucket = Bucket & { label: string }
export type ExtraBucket = Bucket & { spentUsd: number; limitUsd: number }

export type UsageData = {
  sonnet: Bucket | null
  opus: Bucket | null
  // other models' weekly caps, labelled by the API's model name (modelLabel)
  others: ModelBucket[]
  extra: ExtraBucket | null
}

export type ApiError = 'rate_limited' | 'auth' | 'network'

export type LimitsValues = {
  // the engine's windows as it last reported them
  engine: SessionRateLimit[]
  // the usage API's last good numbers and when they were read ($.clock ms)
  api: UsageData | null
  lastSuccessAt: number | null
  // why the last read failed; null after a good read or when the API is skipped
  error: ApiError | null
}

export function initialLimits(): LimitsValues {
  return { engine: [], api: null, lastSuccessAt: null, error: null }
}

// What `$.store` keeps per account, shared by every session of that account.
export type UsageCache = {
  data: UsageData | null
  lastSuccessAt: number | null
  error: ApiError | null
  // no read before this time ($.clock ms): the poll interval or a backoff
  retryAt: number
  // 429s in a row, for the backoff
  rateLimitedCount: number
}

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
// VantageHUD's poll interval (DESIGN, "Config"): the endpoint answers 429 to
// a few reads a minute.
export const POLL_MS = 90_000
// How often the store is checked: picks up another session's read and ends a
// backoff close to its time, without a request.
export const CHECK_MS = 15_000
// A failed read is retried after this (VantageHUD's transient-network pace).
export const RETRY_MS = 120_000
// Sustained 429s back off up to this; a Retry-After counts up to an hour.
export const MAX_429_BACKOFF_MS = 5 * 60_000
export const MAX_RETRY_AFTER_MS = 60 * 60_000
// Past this the last good numbers are not shown and the error is (DESIGN,
// "Usage cache and staleness").
export const MAX_STALE_MS = 15 * 60_000
// At most this many other models' buckets (VantageHUD's MAX_MODEL_WEEKLY).
const MAX_OTHERS = 4

// Module values start over on a hot reload, which runs session.start again
// (DESIGN, "The host"); the cache in $.store carries the numbers across.
let timer: Timer | null = null
let reading = false

// register.ts calls these from its own hooks: the validator refuses an event
// hooked twice without a matcher anywhere in the module graph.

// From session.measure: the engine's windows, pushed after each main-thread
// turn and when a window moves a whole point (types, 'session.measure').
export function measuredLimits($: EngineInterface, values: LimitsValues, e: SessionMeasureInput): void {
  void $
  values.engine = [...e.rateLimits]
}

// From session.start. Only an interactive session shows a line (DESIGN, "When
// the line is written"). Returns at once: the engine awaits the first
// session.start before the first prompt, and a read can take up to 30 s.
export function startLimits($: EngineInterface, values: LimitsValues, e: SessionStartInput): void {
  if (!e.isInteractive) return
  timer?.cancel()
  timer = $.clock.every(CHECK_MS, () => {
    readUsage($, values).catch(() => {})
  })
  firstRead($, values).catch(() => {})
}

async function firstRead($: EngineInterface, values: LimitsValues): Promise<void> {
  values.engine = [...(await $.session.usage()).rateLimits]
  await readUsage($, values)
}

// An env switch is on unless empty, `0`, `false`, `no` or `off` (VantageHUD).
function isOn(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase()
  return v !== '' && v !== '0' && v !== 'false' && v !== 'no' && v !== 'off'
}

function isAnthropicHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === 'anthropic.com' || host.endsWith('.anthropic.com')
  } catch {
    return false
  }
}

// The API describes the subscription of the local login, so behind another
// provider it would show limits that traffic does not draw on (VantageHUD).
// CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC refuses a plugin's request that
// carries `auth` (types, HttpInit.auth): skipped, rather than an [API err].
async function isApiSkipped($: EngineInterface): Promise<boolean> {
  const base = ((await $.env.get('ANTHROPIC_BASE_URL')) ?? '').trim()
  if (base && !isAnthropicHost(base)) return true
  // Each name a literal: the validator lists the variables a module reads.
  if (isOn(await $.env.get('CLAUDE_CODE_USE_BEDROCK'))) return true
  if (isOn(await $.env.get('CLAUDE_CODE_USE_VERTEX'))) return true
  if (isOn(await $.env.get('CLAUDE_CODE_USE_FOUNDRY'))) return true
  return !!(await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'))
}

function show(values: LimitsValues, cache: UsageCache | null): void {
  values.api = cache?.data ?? null
  values.lastSuccessAt = cache?.lastSuccessAt ?? null
  values.error = cache?.error ?? null
}

function asCache(stored: unknown): UsageCache | null {
  return stored && typeof stored === 'object' && typeof (stored as UsageCache).retryAt === 'number'
    ? (stored as UsageCache)
    : null
}

// One read: the account's cache when it is fresh (this or another session
// read it), else the API. One key per account: CLAUDE_CONFIG_DIR picks the
// credentials, and one shared cache once showed one account's numbers in
// another's session (DESIGN, "Usage cache and staleness").
async function readUsage($: EngineInterface, values: LimitsValues): Promise<void> {
  if (reading) return
  reading = true
  try {
    // Both checks come before any cache read: the cache is per config folder,
    // not per login, so a session behind a gateway, on an API key or with no
    // login would otherwise show another login's numbers (VantageHUD checked
    // its provider "before any cache read so a stale cache cannot leak").
    if (await isApiSkipped($)) return show(values, null)
    // Never refresh an OAuth token: refresh tokens are single-use, so a
    // refresh revokes Claude Code's own token (anthropics/claude-code#42603).
    // The engine holds the credential; the mod only borrows a handle. Null
    // (a gateway, a 3P provider, no login) or an API key: the OAuth endpoint
    // has nothing for it, so no API numbers and no badge.
    const auth = await $.session.authorize()
    if (!auth || auth.kind !== 'bearer') return show(values, null)
    const key = `usage:${(await $.env.get('CLAUDE_CONFIG_DIR')) ?? ''}`
    const now = await $.clock.now()
    const cache = asCache(await $.store.get(key))
    if (cache && now < cache.retryAt) return show(values, cache)
    const next = await fetchUsage($, auth.handle, cache, now)
    show(values, next)
    await $.store.set(key, next)
  } finally {
    reading = false
  }
}

async function fetchUsage(
  $: EngineInterface,
  handle: string,
  cache: UsageCache | null,
  now: number,
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
    res = await $.http.fetch(USAGE_URL, { headers: { 'anthropic-beta': 'oauth-2025-04-20' }, auth: handle })
  } catch {
    // refused (a policy), timed out, unreachable
    return failed('network', now + RETRY_MS)
  }
  if (res.status === 429) {
    const count = (cache?.rateLimitedCount ?? 0) + 1
    const backoff = Math.max(POLL_MS, Math.min(POLL_MS * 2 ** (count - 1), MAX_429_BACKOFF_MS))
    return failed('rate_limited', now + Math.max(backoff, retryAfterMs(res.headers['retry-after'])), count)
  }
  // 401: the server rejected the credential. VantageHUD kept a fingerprint of
  // the rejected token so it would not re-send that token faster than the
  // transient pace while re-reading the store for a new one. A mod never sees
  // the token, and the handle is opaque (the types do not say it changes with
  // the credential), so every 401 waits that pace; after a re-login the
  // badge or the stale mark can stay up to RETRY_MS (+ CHECK_MS).
  if (res.status === 401) return failed('auth', now + RETRY_MS)
  // 403 is what a region block answers too, which no credential fixes: a
  // network error, not auth (VantageHUD).
  if (res.status !== 200) return failed('network', now + RETRY_MS)
  let data: UsageData | null = null
  try {
    data = parseUsage(JSON.parse(res.text))
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

// A model's short label: the first letter and the first consonant after it,
// letters only, so Sonnet → sn, Opus → op, Fable → fb (VantageHUD's rule).
// The name is server text; null when no ASCII letter is left.
// Escape sequences go whole before the letters are picked: the final byte of a
// CSI (`m` of ESC[31m) is a letter. A one-letter name gives a one-letter label.
export function modelLabel(name: unknown): string | null {
  if (typeof name !== 'string') return null
  const [first, ...rest] = name.replace(ESCAPES, '').toLowerCase().match(/[a-z]/g) ?? []
  if (first === undefined) return null
  return first + (rest.find(c => !VOWELS.has(c)) ?? rest[0] ?? '')
}

// CSI (ESC [ … final byte) and OSC (ESC ] … BEL or ST, or cut off).
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g
const VOWELS = new Set(['a', 'e', 'i', 'o', 'u'])

type Json = Record<string, any>

function percentOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null
}

function timeOf(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

// The parts of the usage API's answer the engine does not give. Null when the
// body is not the usage shape (no five_hour, seven_day or limits): counted as
// a failed read, keeping the last good numbers.
//
// - Per-model weekly caps come only from `limits[]` entries of kind
//   `weekly_scoped` naming a model: the flat `seven_day_sonnet` /
//   `seven_day_opus` are null on current accounts (measured, DESIGN "Data
//   sources"). A surface-scoped entry is skipped; per label the highest wins.
// - extra: the `limit_usd` / `spent_usd` form, and none at all when the
//   answer carries `used_credits`: VantageHUD showed no extra: for
//   `used_credits` on an Enterprise or unknown plan, and a mod cannot read the
//   plan (`$.session.identity()` answers only an organization-installed mod).
export function parseUsage(body: unknown): UsageData | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const b = body as Json
  if (!('five_hour' in b) && !('seven_day' in b) && !Array.isArray(b.limits)) return null
  const scoped = new Map<string, ModelBucket>()
  for (const l of Array.isArray(b.limits) ? (b.limits as Json[]) : []) {
    if (!l || l.kind !== 'weekly_scoped' || !l.scope || typeof l.scope !== 'object' || l.scope.surface != null) continue
    const percent = percentOf(l.percent)
    const label = modelLabel(l.scope.model?.display_name)
    if (percent === null || !label) continue
    const prev = scoped.get(label)
    if (!prev || percent > prev.percent) scoped.set(label, { label, percent, resetsAt: timeOf(l.resets_at) })
  }
  const bucket = (m: ModelBucket | undefined): Bucket | null => (m ? { percent: m.percent, resetsAt: m.resetsAt } : null)
  const sonnet = bucket(scoped.get('sn'))
  const opus = bucket(scoped.get('op'))
  scoped.delete('sn')
  scoped.delete('op')

  let extra: ExtraBucket | null = null
  const x = b.extra_usage as Json | null | undefined
  if (x && x.is_enabled !== false && x.used_credits == null && typeof x.limit_usd === 'number' && x.limit_usd > 0) {
    const spentUsd = typeof x.spent_usd === 'number' ? x.spent_usd : 0
    extra = {
      percent: percentOf(x.utilization) ?? percentOf((spentUsd / x.limit_usd) * 100) ?? 0,
      resetsAt: timeOf(x.resets_at),
      spentUsd,
      limitUsd: x.limit_usd,
    }
  }
  return { sonnet, opus, others: [...scoped.values()].slice(0, MAX_OTHERS), extra }
}
