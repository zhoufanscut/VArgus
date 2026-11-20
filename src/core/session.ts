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
  // Session start as Unix milliseconds; undefined until read.
  startedAt: number | undefined
  // a standing compaction until the next main-loop step: a measure in this
  // gap can still carry the pre-compact fill and must not restore it
  compactPending: boolean
  counts: Counts
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
