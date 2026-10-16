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

// One row of the detail view's tokens by agent (src/collect/agents.ts), over
// the same span as the counts; the list is saved with the counts' token count
// of the same moment.
export type VargusAgent = {
  // the engine's agentId; '' for the main loop, '*others' for the sum past the cap
  id: string
  kind: 'main' | 'subagent' | 'teammate' | 'workflow' | 'others'
  // the call's name, the teammate's name or the agent type; '?' until a spawn names it
  name: string
  // the Agent call's short description, '' when none
  detail: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  requests: number
}

declare module 'claude-code' {
  interface PluginState {
    vargus: { counts: VargusCounts | null; agents: { list: VargusAgent[]; tokens: number } | null }
  }
}
