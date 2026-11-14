// Narrow structural contracts: the host provides these objects, so there is no
// runtime SDK dependency. Message bodies stay unknown until the collector reads them.
export type SessionEntry = {
  readonly id: string
  readonly type: string
  readonly timestamp: string
  readonly customType?: string
  readonly data?: unknown
  readonly message?: unknown
}

export type HistoryReducer<S> = {
  readonly initial: () => S
  readonly add: (state: S, entry: SessionEntry) => S
}

export type NativeContext = {
  readonly mode: string
  readonly cwd: string
  readonly model: { readonly id: string; readonly provider: string; readonly name?: string } | undefined
  readonly thinkingLevel?: string
  readonly sessionManager: {
    getSessionId(): string
    getHeader(): { readonly timestamp: string } | null
    reduceHistory<S>(reducer: HistoryReducer<S>): S
  }
  getContextUsage(): {
    tokens: number | null
    contextWindow: number
    percent: number | null
  } | undefined
}

export type AccountLimits = {
  readonly provider: string
  readonly account: string
  readonly reportedAt: string
  readonly plan?: string
  readonly error?: string
  readonly windows: readonly {
    readonly id: string
    readonly label: string
    readonly windowMinutes?: number
    readonly usedPercent: number
    readonly resetsAt?: string
  }[]
}
