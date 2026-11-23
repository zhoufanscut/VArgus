// The $.state contract (DESIGN, "How it works"): values that survive a hot reload.

// Counted from when the mod loaded or the last /clear or resume
// (src/hosts/claude/collect/session.ts says what each counts).
export type VargusCounts = {
  tokens: number
  tools: number
  agents: number
  skills: number
  subagents?: { tokens: number; tools: number; agents: number; skills: number }
  cacheHitPercent?: number
  tokensPerSecond?: number
}

declare module 'claude-code' {
  interface PluginState {
    vargus: { counts: VargusCounts | null; savingOption: string | null }
  }
}
