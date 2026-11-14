// Shared rate-limit readings; each host supplies its own collection policy.
export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string; label?: string; stale?: boolean }


export type Bucket = { percent: number; resetsAt: number | null }

export type ModelBucket = Bucket & { label: string }

export type ExtraBucket = Bucket & { spentUsd: number; limitUsd: number }


export type UsageData = {
  // Direct providers' windows; an engine reading takes precedence.
  fiveHour?: Bucket
  monthly?: Bucket
  sonnet: Bucket | null
  opus: Bucket | null
  // other models' weekly caps, labelled by the API's model name (modelLabel)
  others: ModelBucket[]
  extra: ExtraBucket | null
}


export type ApiError = 'rate_limited' | 'auth' | 'network'


export type LimitsValues = {
  // the engine's windows as it last reported them
  engine: RateLimit[]
  // the usage API's last good numbers and when they were read ($.clock ms)
  api: UsageData | null
  lastSuccessAt: number | null
  // why the last read failed; null after a good read or when the API is skipped
  error: ApiError | null
}


export function initialLimits(): LimitsValues {
  return { engine: [], api: null, lastSuccessAt: null, error: null }
}

// Past this the last good numbers are not shown and the error is (DESIGN,
// "Usage cache and staleness").
export const MAX_STALE_MS = 15 * 60_000
