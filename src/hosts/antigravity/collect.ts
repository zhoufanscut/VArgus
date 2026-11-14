import { initialLimits, type LimitsValues, type ModelBucket, type RateLimit } from '../../core/limits.ts'
import { initialSession } from '../../core/session.ts'
import type { Values } from '../../core/types.ts'
import { initialVcs } from '../../core/vcs.ts'

export type AntigravityModel = {
  id?: string
  display_name?: string
  effort?: string
}

export type AntigravityContextWindow = {
  total_input_tokens?: number
  total_output_tokens?: number
  context_window_size?: number
  used_percentage?: number
  remaining_percentage?: number
}

export type AntigravityQuotaBucket = {
  remaining_fraction?: number
  reset_time?: string
  reset_in_seconds?: number
  disabled?: boolean
}

export type AntigravityPayload = {
  cwd?: string
  session_id?: string
  conversation_id?: string
  transcript_path?: string
  model?: AntigravityModel | string
  workspace?: {
    current_dir?: string
    project_dir?: string
  }
  context_window?: AntigravityContextWindow | null
  quota?: Record<string, AntigravityQuotaBucket | null | undefined> | null
  terminal_width?: number
}

export type AntigravityEnv = {
  home?: string
  isWsl?: boolean
  now?: number
  fallbackCwd?: string
}

const EFFORT_IN_LABEL = /\((low|medium|high|xhigh|max)\)\s*$/i

function extractModelAndEffort(raw: AntigravityPayload['model']): { model: string | undefined; effort: string | undefined } {
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    const inferred = EFFORT_IN_LABEL.exec(trimmed)?.[1]?.toLowerCase()
    return { model: trimmed || undefined, effort: inferred }
  }
  if (!raw || typeof raw !== 'object') return { model: undefined, effort: undefined }
  const label = (typeof raw.display_name === 'string' && raw.display_name.trim())
    || (typeof raw.id === 'string' && raw.id.trim())
    || ''
  // On Antigravity 1.5.8's initial `authenticating` frames `model.effort` is
  // omitted while `display_name` already carries `(High)`. Inferring only the
  // five effort words keeps `Orchestrator (Carbon)` untouched and avoids startup flicker.
  const explicitEffort = typeof raw.effort === 'string' && raw.effort.trim() ? raw.effort.trim() : undefined
  const inferredEffort = explicitEffort ?? (label ? EFFORT_IN_LABEL.exec(label)?.[1]?.toLowerCase() : undefined)
  return {
    model: label || undefined,
    effort: inferredEffort,
  }
}

function validBucket(bucket: AntigravityQuotaBucket | null | undefined): bucket is AntigravityQuotaBucket & { remaining_fraction: number } {
  return Boolean(
    bucket
    && bucket.disabled !== true
    && typeof bucket.remaining_fraction === 'number'
    && Number.isFinite(bucket.remaining_fraction),
  )
}

function bucketPercentUsed(bucket: { remaining_fraction: number }): number {
  return Math.max(0, Math.min(100, (1 - bucket.remaining_fraction) * 100))
}

const MAX_DATE_MS = 8.64e15

function bucketResetIso(bucket: AntigravityQuotaBucket, now: number): string | undefined {
  if (typeof bucket.reset_time === 'string' && !Number.isNaN(Date.parse(bucket.reset_time))) {
    return bucket.reset_time
  }
  if (typeof bucket.reset_in_seconds === 'number' && Number.isFinite(bucket.reset_in_seconds)) {
    const ms = now + bucket.reset_in_seconds * 1000
    if (Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS) {
      return new Date(ms).toISOString()
    }
  }
  return undefined
}

function preferredQuotaPrefix(model: string | undefined): 'gemini' | '3p' | null {
  if (!model) return null
  const trimmed = model.trim()
  if (/^(?:gemini|orchestrator)\b/i.test(trimmed)) return 'gemini'
  if (/^(?:claude|gpt)\b/i.test(trimmed)) return '3p'
  return null
}

function findSingleSuffixBucket(
  quota: Record<string, AntigravityQuotaBucket | null | undefined>,
  suffix: '-5h' | '-weekly',
): (AntigravityQuotaBucket & { remaining_fraction: number }) | undefined {
  const matches = Object.entries(quota)
    .filter(([key, value]) => key.endsWith(suffix) && validBucket(value))
    .map(([, value]) => value as AntigravityQuotaBucket & { remaining_fraction: number })
  return matches.length === 1 ? matches[0] : undefined
}

export function collectAntigravityLimits(
  quota: AntigravityPayload['quota'],
  model: string | undefined,
  now: number,
): LimitsValues {
  const limits = initialLimits()
  if (!quota || typeof quota !== 'object') return limits

  const prefix = preferredQuotaPrefix(model)
  // Known model groups read only their own `gemini-*` or `3p-*` buckets so a
  // disabled/missing group never displays the other group's quota; unfamiliar
  // gateway models fall back only when a single `*-5h` / `*-weekly` bucket exists.
  const fiveHourBucket = prefix
    ? (validBucket(quota[`${prefix}-5h`]) ? quota[`${prefix}-5h`] : undefined)
    : findSingleSuffixBucket(quota, '-5h')
  const weeklyBucket = prefix
    ? (validBucket(quota[`${prefix}-weekly`]) ? quota[`${prefix}-weekly`] : undefined)
    : findSingleSuffixBucket(quota, '-weekly')

  const engine: RateLimit[] = []
  if (fiveHourBucket && validBucket(fiveHourBucket)) {
    engine.push({
      kind: 'five_hour',
      percentUsed: bucketPercentUsed(fiveHourBucket),
      resetsAt: bucketResetIso(fiveHourBucket, now),
    })
  }
  if (weeklyBucket && validBucket(weeklyBucket)) {
    engine.push({
      kind: 'seven_day',
      percentUsed: bucketPercentUsed(weeklyBucket),
      resetsAt: bucketResetIso(weeklyBucket, now),
    })
  }
  limits.engine = engine

  // Surface the non-active quota group's weekly bucket (`3p` on Gemini, `gm` on
  // Claude/GPT) through `limits.api.others` so `otherModelWeekly` shows it from 80%.
  const otherPrefix = prefix === 'gemini' ? '3p' : prefix === '3p' ? 'gemini' : null
  const otherWeekly = otherPrefix ? quota[`${otherPrefix}-weekly`] : undefined
  if (otherPrefix && validBucket(otherWeekly)) {
    const resetIso = bucketResetIso(otherWeekly, now)
    const resetsAt = resetIso ? Date.parse(resetIso) : null
    const entry: ModelBucket = {
      label: otherPrefix === 'gemini' ? 'gm' : '3p',
      percent: bucketPercentUsed(otherWeekly),
      resetsAt: resetsAt !== null && !Number.isNaN(resetsAt) ? resetsAt : null,
    }
    limits.api = {
      sonnet: null,
      opus: null,
      others: [entry],
      extra: null,
    }
    limits.lastSuccessAt = now
  }

  return limits
}

export function collectAntigravityPayload(payload: AntigravityPayload, env: AntigravityEnv = {}): Values {
  const now = env.now ?? Date.now()
  const cwd = (typeof payload.workspace?.current_dir === 'string' && payload.workspace.current_dir)
    || (typeof payload.cwd === 'string' && payload.cwd)
    || env.fallbackCwd
    || ''
  const columns = typeof payload.terminal_width === 'number' && Number.isFinite(payload.terminal_width) && payload.terminal_width > 0
    ? Math.floor(payload.terminal_width)
    : undefined

  const session = initialSession()
  const { model, effort } = extractModelAndEffort(payload.model)
  session.model = model
  session.effort = effort

  const cw = payload.context_window
  if (cw && typeof cw === 'object' && typeof cw.context_window_size === 'number' && cw.context_window_size > 0) {
    session.contextWindow = cw.context_window_size
    const tokens = typeof cw.total_input_tokens === 'number' && Number.isFinite(cw.total_input_tokens)
      ? Math.max(0, cw.total_input_tokens)
      : undefined
    session.contextTokens = tokens
    if (typeof cw.used_percentage === 'number' && Number.isFinite(cw.used_percentage)) {
      session.contextPercent = cw.used_percentage
    } else if (tokens !== undefined) {
      session.contextPercent = (tokens / cw.context_window_size) * 100
    }
  }

  return {
    core: {
      cwd,
      home: env.home,
      columns,
      isWsl: env.isWsl ?? false,
      host: 'antigravity',
    },
    session,
    limits: collectAntigravityLimits(payload.quota, model, now),
    vcs: initialVcs(),
  }
}
