// Direct provider usage APIs. A provider matches an exact base URL and parses
// into shared UsageData. Matching fixes the HTTPS destination: the existing
// environment credential is never sent to a gateway that merely names Kimi.
// New direct providers add one entry to DIRECT_PROVIDERS.

import type { Bucket, UsageData } from '../../../core/limits'

export type DirectUsageProvider = {
  id: string
  baseUrl: string
  usageUrl: string
  parse: (body: unknown) => UsageData | null
}

type Json = Record<string, unknown>

function record(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'string' && !value.trim()) return null
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? n : null
}

function percent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

function time(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

function kimiData(fiveHour?: Bucket, monthly?: Bucket): UsageData {
  return {
    ...(fiveHour ? { fiveHour } : {}),
    ...(monthly ? { monthly } : {}),
    sonnet: null, opus: null, others: [], extra: null,
  }
}

function ratioBucket(value: unknown): Bucket | undefined {
  const entry = record(value)
  const ratio = numberValue(entry?.used_ratio)
  return ratio === null ? undefined : { percent: percent(Math.round(ratio * 10_000) / 100), resetsAt: time(entry?.reset_time) }
}

// Kimi Code 2.5.2 reads usages.limit_5h and limit_month_total with
// used_ratio/reset_time. The measured response also carries a 300-minute
// limits[] count window (used, or limit - remaining) is the 5h fallback.
function parseKimiUsage(body: unknown): UsageData | null {
  const b = record(body)
  if (!b) return null
  const usages = record(b.usages)
  let fiveHour = ratioBucket(usages?.limit_5h)
  const monthly = ratioBucket(usages?.limit_month_total)
  if (!fiveHour) {
    for (const raw of Array.isArray(b.limits) ? b.limits : []) {
      const item = record(raw)
      const window = record(item?.window)
      const detail = record(item?.detail)
      if (window?.duration !== 300 || window.timeUnit !== 'TIME_UNIT_MINUTE') continue
      const limit = numberValue(detail?.limit)
      const remaining = numberValue(detail?.remaining)
      const used = numberValue(detail?.used)
        ?? (limit !== null && remaining !== null ? limit - remaining : null)
      if (limit === null || limit <= 0 || used === null) continue
      fiveHour = { percent: percent(used / limit * 100), resetsAt: time(detail?.resetTime) }
      break
    }
  }
  return fiveHour || monthly ? kimiData(fiveHour, monthly) : null
}

const DIRECT_PROVIDERS: DirectUsageProvider[] = [
  {
    id: 'kimi.com', baseUrl: 'https://api.kimi.com/coding', usageUrl: 'https://api.kimi.com/coding/v1/usages',
    parse: parseKimiUsage,
  },
  {
    id: 'kimi.ai', baseUrl: 'https://api.kimi.ai/coding', usageUrl: 'https://api.kimi.ai/coding/v1/usages',
    parse: parseKimiUsage,
  },
]

export function directUsageProvider(baseUrl: string | undefined): DirectUsageProvider | null {
  if (!baseUrl) return null
  let normalized: string
  try {
    const url = new URL(baseUrl)
    normalized = `${url.origin.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
  return DIRECT_PROVIDERS.find(p => p.baseUrl === normalized) ?? null
}
