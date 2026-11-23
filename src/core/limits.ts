// Reset times are Unix milliseconds, or null when the source has no reset time.
export type Bucket = { percent: number; resetsAt: number | null }

export type QuotaWindow = Bucket & {
  label: string
}

export type ApiError = 'rate_limited' | 'auth' | 'network'
// A host supplies its visible windows and error badges in display order.
export type QuotaReading = QuotaWindow | ApiError

export const MAX_STALE_MS = 15 * 60_000

export function isRecentUsage(lastSuccessAt: number | null, now: number): boolean {
  return lastSuccessAt !== null && now - lastSuccessAt <= MAX_STALE_MS
}

export function resetTime(iso: string | undefined): number | null {
  const ms = iso ? Date.parse(iso) : NaN
  return Number.isNaN(ms) ? null : ms
}
