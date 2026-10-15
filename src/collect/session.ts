import type {
  EngineInterface, SessionEndInput, SessionMeasureInput, ToolCallInput, TurnStepInput, TurnStepResult,
} from 'claude-code'

import type { VargusCounts } from '../../types'

// The session area's collector (DESIGN, "Data sources"): model, effort,
// context %, session start, tokens and call counts. The hooks live in
// hooks/register.ts, which calls the functions below; each only observes
// (the hook passes `next(e)` on unchanged and returns what `next` gave).
//
// What each count means, against VantageHUD 0.6.0 (src/hud/token-tally.js):
// - tokens: `input_tokens + output_tokens` of every `turn.step` result's usage,
//   main loop and subagents together. Cache read and cache creation tokens are
//   left out, as VantageHUD's tokensFromUsage left them out ("`ctx:` is the
//   cache-inclusive gauge"); `input_tokens` is the uncached part alone
//   (ModelUsage), so nothing is counted twice. One `turn.step` is one request
//   with its settled usage, so VantageHUD's per-message.id de-duplication and
//   its `~` for unsettled rows have nothing to do here.
// - tools, agents, skills, workflow runs: the main loop's `tool.call`s
//   (`e.agentId` absent), as VantageHUD counted the lead transcript's tool_use
//   blocks. An agent is a call to `Agent`, a skill one to `Skill`, a workflow
//   run one to `Workflow` that does not resume a run (`resumeFromRunId`); each
//   is a tool call too. A call counts when it starts, refused or not, as a
//   tool_use block did. Not `agent.spawn`: it also fires for each agent a
//   workflow run starts and for a plugin's `$.agent.spawn` (types,
//   AgentSpawnInput), where VantageHUD counted one per Agent call.
// Edges: a hook above VArgus that answers without `next` hides that event
// from it; the tool names are the 2.1.300 tool table's (VantageHUD also
// counted `Task`, `proxy_Task`, `proxy_Skill`, which that table lacks).

export type SessionValues = {
  // $.session.model(), as given (`claude-opus-5-5[1m]`)
  model: string | undefined
  // the main loop's last `turn.step` effort; undefined for a model without one
  effort: string | number | undefined
  // $.session.usage() context percent, 0-100; undefined before a reading
  contextPercent: number | undefined
  // $.session.usage().startedAt, in $.clock.now() ms; undefined until read
  startedAt: number | undefined
  // after /clear or a resume, until the next session.measure: the tick reads
  // context and start again (register.ts refresh)
  rereading: boolean
  counts: VargusCounts
}

const COUNTS = { plugin: 'vargus', key: 'counts' } as const

function zero(): VargusCounts {
  return { tokens: 0, tools: 0, agents: 0, skills: 0, workflows: 0 }
}

export function initialSession(): SessionValues {
  return {
    model: undefined, effort: undefined, contextPercent: undefined, startedAt: undefined, rereading: false,
    counts: zero(),
  }
}

// Saves run one after another, each writing the counts as they are when it
// runs, so the last save holds the latest counts whatever order calls came in.
let saving: Promise<unknown> = Promise.resolve()

function save($: EngineInterface, values: SessionValues): void {
  saving = saving.then(() => $.state.set(COUNTS, { ...values.counts })).catch(() => {})
}

// Model and session start, and the context when no event pushed it. Called
// unawaited (see startSession). Each read on its own, so one refused read
// keeps the others.
async function readSession($: EngineInterface, values: SessionValues, withContext: boolean): Promise<void> {
  try {
    values.model = await $.session.model()
  } catch {
    // keep the last
  }
  try {
    const usage = await $.session.usage()
    values.startedAt = usage.startedAt
    if (withContext) values.contextPercent = usage.context.percent
  } catch {
    // keep the last
  }
}

// Called from register.ts's one session.start hook (the validator allows one
// hook per event and module without a matcher). A hot reload runs
// session.start again with module values new: take the counts back from
// $.state (DESIGN, "The line file"); a save made between the reload and this
// read is lost to it (in-process, so rare). The other reads are not awaited:
// session.start must not wait on them (DESIGN, "When the line is written").
export async function startSession($: EngineInterface, values: SessionValues): Promise<void> {
  try {
    const saved = (await $.state.get(COUNTS)).value
    if (saved) values.counts = { ...zero(), ...saved }
  } catch {
    // nothing saved
  }
  readSession($, values, true).catch(() => {})
}

// One function per event, so another collector hooking the same event can be
// called from one shared hook instead.

// Pushed after each main-thread turn: the context, and a fresh read of the
// model and session start (which /clear and a resume move).
export function measured($: EngineInterface, e: SessionMeasureInput, values: SessionValues): void {
  values.contextPercent = e.context.percent
  values.rereading = false
  readSession($, values, false).catch(() => {})
}

export function stepStarting(e: TurnStepInput, values: SessionValues): void {
  if (e.agentId === undefined) values.effort = e.effort
}

export function stepDone($: EngineInterface, r: TurnStepResult, values: SessionValues): void {
  if (!r.usage) return
  values.counts.tokens += r.usage.input_tokens + r.usage.output_tokens
  save($, values)
}

export function toolCalled($: EngineInterface, e: ToolCallInput, values: SessionValues): void {
  if (e.agentId !== undefined) return
  const c = values.counts
  c.tools += 1
  if (e.tool === 'Agent') c.agents += 1
  else if (e.tool === 'Skill') c.skills += 1
  else if (e.tool === 'Workflow' && !e.resumeFromRunId) c.workflows += 1
  save($, values)
}

// /clear and a resume go on under another session id with no session.start;
// the counts start over, as $.session.usage() does at /clear. Context and
// start are unknown until the next reading.
export function sessionEnding($: EngineInterface, e: SessionEndInput, values: SessionValues): void {
  if (e.reason !== 'clear' && e.reason !== 'resume') return
  values.counts = zero()
  values.contextPercent = undefined
  values.startedAt = undefined
  values.rereading = true
  save($, values)
}
