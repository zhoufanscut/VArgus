// Normalized saved-log readings. Usage and quota fields follow the Codex
// 0.167.0 app-server shapes; the collector receives no transport RPC requests.
export type Usage = {
  inputTokens: number; cachedInputTokens: number; outputTokens: number; totalTokens: number
}
export type TokenUsage = { total: Usage; last: Usage; modelContextWindow: number | null }
export type LimitWindow = { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null }
export type Limits = {
  limitId?: string | null; normalModelSlug?: string | null
  primary?: LimitWindow | null; secondary?: LimitWindow | null
}
export type Item = {
  id: string; type: string; kind?: string
}
