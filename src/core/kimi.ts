import type { Bucket, UsageData } from './limits.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
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

function ratioBucket(value: unknown): Bucket | undefined {
  const entry = record(value)
  const ratio = numberValue(entry?.used_ratio)
  return ratio === null ? undefined : { percent: percent(Math.round(ratio * 10_000) / 100), resetsAt: time(entry?.reset_time) }
}

// Kimi Code's aggregate ratios plus the measured 300-minute count fallback.
// Shared parsing keeps host collectors independent.
export function parseKimiUsage(body: unknown): UsageData | null {
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
  return fiveHour || monthly ? {
    ...(fiveHour ? { fiveHour } : {}),
    ...(monthly ? { monthly } : {}),
    sonnet: null, opus: null, others: [], extra: null,
  } : null
}
