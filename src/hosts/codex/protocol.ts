// Read-only subset of `codex app-server generate-ts` on codex-cli 0.167.0.
// Regenerate into a scratch directory when updating the minimum Codex version.
// https://learn.chatgpt.com/docs/app-server
export type Usage = {
  inputTokens: number; cachedInputTokens: number; outputTokens: number; totalTokens: number
}
export type TokenUsage = { total: Usage; last: Usage; modelContextWindow: number | null }
export type LimitWindow = { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null }
export type Limits = {
  limitId?: string | null; normalModelSlug?: string | null
  primary?: LimitWindow | null; secondary?: LimitWindow | null
}
export type Thread = {
  id: string; parentThreadId?: string | null; model?: string | null
  reasoningEffort?: string | null; cwd: string; createdAt: number
  ephemeral?: boolean; threadSource?: string | null
  source?: string | { subAgent?: string | { thread_spawn?: { agent_path?: string | null } } }
}
export type Item = {
  id: string; type: string; tool?: string; receiverThreadIds?: string[]
  kind?: string; agentThreadId?: string
}

// Unknown fields pass through the bridge verbatim. Observation never rewrites RPC.
export type Message = {
  id?: number | string; method?: string; params?: Record<string, unknown>
  result?: Record<string, unknown>; error?: unknown
}
