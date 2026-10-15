// The $.state contract (DESIGN, "How it works"): values that survive a hot reload.

// Counted from when the mod loaded or the last /clear or resume
// (src/collect/session.ts says what each counts).
export type VargusCounts = {
  tokens: number
  tools: number
  agents: number
  skills: number
  workflows: number
}

declare module 'claude-code' {
  interface PluginState {
    vargus: { counts: VargusCounts | null }
  }
}
