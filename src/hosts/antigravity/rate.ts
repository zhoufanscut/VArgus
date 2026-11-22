import { createHash } from 'node:crypto'
import { outputTokensPerSecond } from '../../core/session.ts'
import { cachePath, readCache, writeCache } from './cache.ts'
import type { AntigravityPayload } from './collect.ts'
import { EFFORT_TAIL, KNOWN_EFFORT_SLUG } from './display.ts'
import type { TranscriptState } from './transcript.ts'

// Antigravity CLI throttles statusLine invocations to 300 ms and can emit one
// trailing refresh ~300 ms after a step/context transition before going silent
// during pre-TTFT wait. Skipping no-op refreshes within this window avoids
// latching streamStartMs on that trailing flush.
export const TRAILING_THROTTLE_MS = 450

// If a PLANNER_RESPONSE and a slow tool's GENERIC result land in the same
// statusLine refresh (missed intermediate refresh), transcript.jsonl mtimeMs
// includes the slow tool's duration; skip updating the rate when the gap from
// the tool's created_at exceeds this threshold.
export const SLOW_TOOL_GAP_MS = 2000

export type AntigravityRateCache = {
  version: 1
  transcriptPath: string
  transcriptEpoch: string
  firstLineHash: string
  committedBytes: number
  stepCount: number
  plannerStepsSeen: number
  compactionsSeen: number
  payloadDigest: string
  agentState: string | undefined
  modelKey: string | undefined
  lastTransitionAt: number
  streamStartMs: number | undefined
  tokensPerSecond: number | undefined
}

export type RateInput = {
  transcriptPath: string
  transcript: TranscriptState
  payload: AntigravityPayload
  now: number
  // Approximate time agy invoked the status-line command (now minus Node startup).
  // Used for transition/stream-start timestamps so startup latency does not trim
  // measured decode durations against transcript.jsonl mtimeMs.
  observedAt?: number
}

function canonicalize(value: unknown, insideQuotaBucket = false): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(item => canonicalize(item))
  const record = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) {
    if (insideQuotaBucket && key === 'reset_in_seconds') continue
    const child = record[key]
    if (child === undefined) continue
    out[key] = canonicalize(child, false)
  }
  return out
}

// Hash all payload fields except per-second `quota.*.reset_in_seconds`
// countdowns so wall-clock ticks never look like state transitions.
export function payloadFingerprint(payload: AntigravityPayload): string {
  const record = payload as Record<string, unknown>
  const normalized: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) {
    const value = record[key]
    if (value === undefined) continue
    if (key === 'quota' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const quota: Record<string, unknown> = {}
      const rawQuota = value as Record<string, unknown>
      for (const bucket of Object.keys(rawQuota).sort()) {
        const entry = rawQuota[bucket]
        if (entry === undefined) continue
        quota[bucket] = canonicalize(entry, true)
      }
      normalized[key] = quota
    } else {
      normalized[key] = canonicalize(value)
    }
  }
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

export function baseModelKey(model: AntigravityPayload['model']): string | undefined {
  let raw = ''
  if (typeof model === 'string') {
    raw = model.trim()
  } else if (model && typeof model === 'object') {
    raw = (typeof model.display_name === 'string' && model.display_name.trim())
      || (typeof model.id === 'string' && model.id.trim())
      || ''
  }
  if (!raw) return undefined
  let normalized = raw.replace(EFFORT_TAIL, '').trim().toLowerCase().replace(/\s+/g, '-')
  const slugEffort = KNOWN_EFFORT_SLUG.exec(normalized)?.[1]
  if (slugEffort) normalized = normalized.slice(0, -(slugEffort.length + 1))
  // Align version separators across display labels (`Claude Opus 5.5`) and slugs (`claude-opus-5-5`).
  normalized = normalized.replace(/(?<=\d)\.(?=\d)/g, '-')
  return normalized || undefined
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function optionalPositiveFinite(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value > 0)
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function isValidRateCache(value: unknown): value is AntigravityRateCache {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const c = value as Record<string, unknown>
  return c.version === 1
    && typeof c.transcriptPath === 'string'
    && typeof c.transcriptEpoch === 'string'
    && c.transcriptEpoch !== ''
    && typeof c.firstLineHash === 'string'
    && nonNegativeFinite(c.committedBytes)
    && nonNegativeFinite(c.stepCount)
    && nonNegativeFinite(c.plannerStepsSeen)
    && nonNegativeFinite(c.compactionsSeen)
    && typeof c.payloadDigest === 'string'
    && optionalString(c.agentState)
    && optionalString(c.modelKey)
    && nonNegativeFinite(c.lastTransitionAt)
    && optionalPositiveFinite(c.streamStartMs)
    && optionalPositiveFinite(c.tokensPerSecond)
}

function sameRateCache(a: AntigravityRateCache | undefined, b: AntigravityRateCache): boolean {
  return Boolean(
    a
    && a.transcriptPath === b.transcriptPath
    && a.transcriptEpoch === b.transcriptEpoch
    && a.firstLineHash === b.firstLineHash
    && a.committedBytes === b.committedBytes
    && a.stepCount === b.stepCount
    && a.plannerStepsSeen === b.plannerStepsSeen
    && a.compactionsSeen === b.compactionsSeen
    && a.payloadDigest === b.payloadDigest
    && a.agentState === b.agentState
    && a.modelKey === b.modelKey
    && a.lastTransitionAt === b.lastTransitionAt
    && a.streamStartMs === b.streamStartMs
    && a.tokensPerSecond === b.tokensPerSecond,
  )
}

export function advanceAntigravityRate(
  prev: AntigravityRateCache | undefined,
  input: RateInput,
): AntigravityRateCache {
  const { transcriptPath, transcript, payload, now } = input
  const observedAt = input.observedAt ?? now
  const payloadDigest = payloadFingerprint(payload)
  const agentState = typeof payload.agent_state === 'string' && payload.agent_state.trim()
    ? payload.agent_state.trim()
    : undefined
  const modelKey = baseModelKey(payload.model)

  const sameTranscript = Boolean(
    prev
    && prev.version === 1
    && prev.transcriptPath === transcriptPath
    && transcript.epoch !== ''
    && prev.transcriptEpoch === transcript.epoch
    && transcript.firstLineHash !== ''
    && prev.firstLineHash === transcript.firstLineHash
    && prev.committedBytes <= transcript.committedBytes
    && prev.stepCount <= transcript.stepCount
    && prev.plannerStepsSeen <= transcript.plannerStepsSeen
    && prev.compactionsSeen <= transcript.compactionsSeen,
  )

  if (!sameTranscript) {
    return {
      version: 1,
      transcriptPath,
      transcriptEpoch: transcript.epoch,
      firstLineHash: transcript.firstLineHash,
      committedBytes: transcript.committedBytes,
      stepCount: transcript.stepCount,
      plannerStepsSeen: transcript.plannerStepsSeen,
      compactionsSeen: transcript.compactionsSeen,
      payloadDigest,
      agentState,
      modelKey,
      lastTransitionAt: observedAt,
      streamStartMs: undefined,
      tokensPerSecond: undefined,
    }
  }

  let tokensPerSecond = prev!.tokensPerSecond
  let streamStartMs = prev!.streamStartMs
  let lastTransitionAt = prev!.lastTransitionAt

  const prevModel = prev!.modelKey
  const effectiveModel = modelKey ?? prevModel
  if (prevModel !== undefined && modelKey !== undefined && modelKey !== prevModel) {
    tokensPerSecond = undefined
    streamStartMs = undefined
  }

  const compacted = transcript.compactionsSeen > prev!.compactionsSeen
  if (compacted) {
    tokensPerSecond = undefined
    streamStartMs = undefined
  }

  const newPlannerSteps = transcript.plannerStepsSeen - prev!.plannerStepsSeen
  const transcriptChanged = transcript.committedBytes !== prev!.committedBytes
    || transcript.stepCount !== prev!.stepCount
  const payloadChanged = payloadDigest !== prev!.payloadDigest

  if (newPlannerSteps > 0) {
    const last = transcript.lastPlanner
    if (!compacted && newPlannerSteps === 1 && last) {
      if (last.outputTokens <= 0) {
        tokensPerSecond = undefined
      } else if (streamStartMs !== undefined && last.stepCount === prev!.stepCount + 1) {
        const endMs = nonNegativeFinite(transcript.mtimeMs)
          && transcript.mtimeMs > 0
          && transcript.mtimeMs <= now + 1000
          ? Math.min(transcript.mtimeMs, now)
          : observedAt
        const hasTrailingSteps = transcript.stepCount > last.stepCount
        const trailingBounded = !hasTrailingSteps || (
          !transcript.unboundedTrailingStep
          && transcript.firstToolAfterPlannerCreatedAt !== undefined
          && endMs - transcript.firstToolAfterPlannerCreatedAt <= SLOW_TOOL_GAP_MS
        )
        if (trailingBounded) {
          const rate = outputTokensPerSecond(last.outputTokens, endMs - streamStartMs)
          if (rate !== undefined) tokensPerSecond = rate
        }
      }
    } else if (!compacted && last && last.outputTokens <= 0) {
      tokensPerSecond = undefined
    }
    streamStartMs = undefined
    lastTransitionAt = observedAt
  } else if (agentState !== 'working' || !transcript.awaitingModel) {
    streamStartMs = undefined
    if (transcriptChanged || payloadChanged) lastTransitionAt = observedAt
  } else if (transcriptChanged || payloadChanged) {
    if (transcriptChanged) streamStartMs = undefined
    lastTransitionAt = observedAt
  } else if (streamStartMs === undefined) {
    if (observedAt < lastTransitionAt) {
      lastTransitionAt = observedAt
    } else if (observedAt - lastTransitionAt > TRAILING_THROTTLE_MS) {
      streamStartMs = observedAt
    }
  }

  return {
    version: 1,
    transcriptPath,
    transcriptEpoch: transcript.epoch,
    firstLineHash: transcript.firstLineHash,
    committedBytes: transcript.committedBytes,
    stepCount: transcript.stepCount,
    plannerStepsSeen: transcript.plannerStepsSeen,
    compactionsSeen: transcript.compactionsSeen,
    payloadDigest,
    agentState,
    modelKey: effectiveModel,
    lastTransitionAt,
    streamStartMs,
    tokensPerSecond,
  }
}

export async function updateAntigravityRate(
  transcriptPath: string,
  transcript: TranscriptState,
  payload: AntigravityPayload,
  cacheDir: string,
  now = Date.now(),
  observedAt = now,
): Promise<number | undefined> {
  if (!transcript.firstLineHash || !transcript.epoch) return undefined
  const file = cachePath(cacheDir, 'rate', transcriptPath)
  const raw = await readCache<unknown>(file)
  const prev = isValidRateCache(raw) ? raw : undefined
  const next = advanceAntigravityRate(prev, { transcriptPath, transcript, payload, now, observedAt })
  if (!sameRateCache(prev, next)) {
    await writeCache(cacheDir, file, next).catch(() => {})
  }
  return next.tokensPerSecond
}
