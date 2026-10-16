import type {
  AgentSpawnInput, AgentSpawnResult, EngineInterface, SessionEndInput, TurnStepInput, TurnStepResult,
} from 'claude-code'

import type { VargusAgent } from '../../types'

// Tokens by agent, for the detail view only (DESIGN, "The detail view"): the
// same `turn.step` usage the `token:` count sums, split by `e.agentId` (the
// main loop has none) and kept with all four counts. Collected only with the
// detailView option on; register.ts calls these from its own hooks.
//
// Names come from `agent.spawn`: the call's `name`, else the teammate's
// address before `@`, else the agent type. An agent whose spawn this copy of
// the mod did not see (it started before the mod loaded) is named by its type
// only once a spawn names it; until then it shows as `?`.

export type AgentsValues = { list: VargusAgent[] }

// The main loop's id in the list; no engine agent id is empty.
export const MAIN = ''
// Past this many agents, the rest are summed into one row (a workflow run can
// start dozens); the view shows the largest few anyway.
export const MAX_AGENTS = 64
export const OTHERS = '*others'

const AGENTS = { plugin: 'vargus', key: 'agents' } as const

export function initialAgents(): AgentsValues {
  return { list: [] }
}

function blank(id: string, kind: VargusAgent['kind'], name: string, detail = ''): VargusAgent {
  return { id, kind, name, detail, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 }
}

// The agent's row, made if new; past MAX_AGENTS a new agent's tokens go to
// the OTHERS row.
function row(values: AgentsValues, id: string): VargusAgent {
  const found = values.list.find(a => a.id === id)
  if (found) return found
  if (values.list.length >= MAX_AGENTS) {
    const others = values.list.find(a => a.id === OTHERS)
    if (others) return others
    const made = blank(OTHERS, 'others', '')
    values.list.push(made)
    return made
  }
  const made = id === MAIN ? blank(MAIN, 'main', '') : blank(id, 'subagent', '?')
  values.list.push(made)
  return made
}

// Saves run one after another (as session.ts saves the counts), so the last
// save holds the latest list.
let saving: Promise<unknown> = Promise.resolve()

function save($: EngineInterface, values: AgentsValues): void {
  saving = saving.then(() => $.state.set(AGENTS, values.list.map(a => ({ ...a })))).catch(() => {})
}

// From session.start, after the counts are restored: a hot reload keeps the
// list in $.state. Taken back only when its in + out is the restored token
// count: with the option off the list is neither kept nor cleared, so after
// an off-then-on reload it may hold an earlier conversation's agents.
export async function startAgents($: EngineInterface, values: AgentsValues, tokens: number): Promise<void> {
  values.list = []
  try {
    const saved = (await $.state.get(AGENTS)).value
    if (saved && saved.reduce((n, a) => n + a.input + a.output, 0) === tokens) values.list = saved.map(a => ({ ...a }))
  } catch {
    // nothing saved
  }
}

// From agent.spawn, after `next` answered: the started agent's name. A
// refused spawn (no agentId) starts nothing.
export function agentSpawned($: EngineInterface, values: AgentsValues, e: AgentSpawnInput, r: AgentSpawnResult): void {
  if (!r.agentId) return
  const a = row(values, r.agentId)
  if (a.id === OTHERS) return
  a.kind = r.teammateId ? 'teammate' : e.workflow ? 'workflow' : 'subagent'
  a.name = e.name ?? r.teammateId?.split('@')[0] ?? e.subagentType
  a.detail = e.description
  save($, values)
}

// From turn.step, after the step: its usage on its agent's row.
export function agentStep($: EngineInterface, values: AgentsValues, e: TurnStepInput, r: TurnStepResult): void {
  if (!r.usage) return
  const a = row(values, e.agentId ?? MAIN)
  a.input += r.usage.input_tokens
  a.output += r.usage.output_tokens
  a.cacheRead += r.usage.cache_read_input_tokens
  a.cacheWrite += r.usage.cache_creation_input_tokens
  a.requests += 1
  save($, values)
}

// /clear and a resume start the list over, as the counts do (session.ts).
export function agentsEnding($: EngineInterface, values: AgentsValues, e: SessionEndInput): void {
  if (e.reason !== 'clear' && e.reason !== 'resume') return
  values.list = []
  save($, values)
}
