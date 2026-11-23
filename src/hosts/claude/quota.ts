import type { SessionRateLimit } from 'claude-code'
import { isRecentUsage, resetTime, type ApiError, type QuotaReading, type QuotaWindow } from '../../core/limits.ts'
import type { KimiUsage } from '../../core/kimi.ts'
import type { Labels } from '../../i18n/en.ts'

// Persisted in Claude's per-provider usage cache, also read by older plugin sessions.
export type UsageData = KimiUsage

type EngineWindow = SessionRateLimit & { label?: string }
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
  return { label, percent: raw.percentUsed, resetsAt: resetTime(raw.resetsAt) }
}

export function claudeQuotaReadings(state: ClaudeLimits, labels: Labels, now: number): QuotaReading[] {
  const readings: QuotaReading[] = []
  const api = isRecentUsage(state.lastSuccessAt, now) ? state.api : null
  const fiveHour = state.engine.filter(w => w.kind === 'five_hour')
  for (const w of fiveHour) readings.push(engineWindow(w, w.label ?? labels.fiveHour))
  if (!fiveHour.length && api?.fiveHour) readings.push({ label: labels.fiveHour, ...api.fiveHour })
  for (const w of state.engine) {
    if (w.kind === 'seven_day') readings.push(engineWindow(w, w.label ?? labels.sevenDay))
  }
  for (const w of state.engine) {
    if (w.label && !['five_hour', 'seven_day', 'spend_limit'].includes(w.kind)) readings.push(engineWindow(w, w.label))
  }

  if (api) {
    if (api.monthly) readings.push({ label: labels.monthly, ...api.monthly })
  } else if (state.error) readings.push(state.error)

  return readings
}
