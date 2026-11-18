import type { SessionRateLimit } from 'claude-code'
import { isRecentUsage, resetTime, showModelWeekly, type ApiError, type Bucket, type QuotaReading, type QuotaWindow } from '../../core/limits.ts'
import type { KimiUsage } from '../../core/kimi.ts'
import type { Labels } from '../../i18n/en.ts'
import type { Options } from '../../options.ts'

export type ModelBucket = Bucket & { label: string }
export type ExtraBucket = Bucket & { spentUsd: number; limitUsd: number }

// Persisted in Claude's per-account usage cache, also read by older plugin sessions.
export type UsageData = KimiUsage & {
  sonnet: Bucket | null
  opus: Bucket | null
  others: ModelBucket[]
  extra: ExtraBucket | null
}

type EngineWindow = SessionRateLimit & { label?: string; stale?: boolean }
export type ClaudeLimits = {
  engine: EngineWindow[]
  api: UsageData | null
  lastSuccessAt: number | null
  error: ApiError | null
}

export function initialClaudeLimits(): ClaudeLimits {
  return { engine: [], api: null, lastSuccessAt: null, error: null }
}

function engineWindow(raw: EngineWindow, label: string): QuotaWindow {
  return { label, percent: raw.percentUsed, resetsAt: resetTime(raw.resetsAt), stale: raw.stale }
}

export function claudeQuotaReadings(state: ClaudeLimits, options: Options, labels: Labels, now: number): QuotaReading[] {
  const readings: QuotaReading[] = []
  const api = isRecentUsage(state.lastSuccessAt, now) ? state.api : null
  const stale = state.error !== null
  const fiveHour = state.engine.filter(w => w.kind === 'five_hour')
  for (const w of fiveHour) readings.push(engineWindow(w, w.label ?? labels.fiveHour))
  if (!fiveHour.length && api?.fiveHour) readings.push({ label: labels.fiveHour, ...api.fiveHour, stale })
  for (const w of state.engine) {
    if (w.kind === 'seven_day') readings.push(engineWindow(w, w.label ?? labels.sevenDay))
  }
  for (const w of state.engine) {
    if (w.label && !['five_hour', 'seven_day', 'spend_limit'].includes(w.kind)) readings.push(engineWindow(w, w.label))
  }

  if (api) {
    if (api.monthly) readings.push({ label: labels.monthly, ...api.monthly, stale })
    if (api.sonnet && showModelWeekly(api.sonnet.percent)) readings.push({ label: labels.sonnetWeekly, ...api.sonnet, stale })
    if (api.opus) readings.push({ label: labels.opusWeekly, ...api.opus, stale })
    if (options.otherModelWeekly) {
      for (const w of api.others) if (showModelWeekly(w.percent)) readings.push({ ...w, stale })
    }
    if (api.extra) {
      const { percent, resetsAt, spentUsd, limitUsd } = api.extra
      readings.push({ label: labels.extra, percent, resetsAt, stale, cost: { spentUsd, limitUsd } })
    }
  } else if (state.error) readings.push(state.error)

  const spend = options.spendLimit && state.engine.find(w => w.kind === 'spend_limit')
  if (spend) readings.push({ label: labels.spendLimit, percent: spend.percentUsed, resetsAt: resetTime(spend.resetsAt), unclamped: true })
  return readings
}
