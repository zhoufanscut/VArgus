// Shared session values. Hosts own the source and lifetime of these readings.
export type Counts = { tokens: number; tools: number; agents: number; skills: number }


export type SessionValues = {
  // Model identifier as reported by the host.
  model: string | undefined
  // Effective main-thread effort; undefined before the host supplies it.
  effort: string | number | undefined
  // Default effort for the model that supplied the effective effort.
  defaultEffort?: string
  // Recorded Fast-mode selection; undefined before the host supplies it.
  fast: boolean | undefined
  // Host context percent, 0-100; undefined before a reading.
  contextPercent: number | undefined
  // Tokens in use and window size, where provided by the host collector.
  contextTokens: number | undefined
  contextWindow: number | undefined
  // Share of the latest request's prompt input served from cache, from 0 to 100.
  cacheHitPercent?: number
  // Latest eligible model response's output decode rate in tokens/second.
  tokensPerSecond?: number
  // Session start as Unix milliseconds; undefined until read.
  startedAt: number | undefined
  // a standing compaction until the next main-loop step: a measure in this
  // gap can still carry the pre-compact fill and must not restore it
  compactPending: boolean
  counts: Counts
}

function tokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function cacheHitPercent(read: number, totalInput: number): number | undefined {
  if (!tokenCount(read) || !tokenCount(totalInput) || totalInput === 0 || read > totalInput) return undefined
  return (100 * read) / totalInput
}

export function cacheHitFromSplitInput(read: unknown, input: unknown, written: unknown): number | undefined {
  if (!tokenCount(read) || !tokenCount(input) || !tokenCount(written)) return undefined
  return cacheHitPercent(read, input + read + written)
}

// Minimum streamed generation window (first token to last) before computing a
// decode rate, filtering out short replies and single-chunk bursts.
export const MIN_RATE_MS = 500

export function outputTokensPerSecond(outputTokens: unknown, durationMs: unknown): number | undefined {
  if (!tokenCount(outputTokens) || outputTokens <= 0) return undefined
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < MIN_RATE_MS) return undefined
  const rate = (outputTokens * 1000) / durationMs
  return Number.isFinite(rate) && rate > 0 ? rate : undefined
}


export function initialCounts(saved?: Partial<Counts>): Counts {
  const { tokens = 0, tools = 0, agents = 0, skills = 0 } = saved ?? {}
  return { tokens, tools, agents, skills }
}


export function initialSession(): SessionValues {
  return {
    model: undefined, effort: undefined, fast: undefined, contextPercent: undefined, contextTokens: undefined,
    contextWindow: undefined, startedAt: undefined, compactPending: false,
    counts: initialCounts(),
  }
}
