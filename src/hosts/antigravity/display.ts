import type { SessionValues } from '../../core/session.ts'
import { displaySession, shortModelName } from '../../render/session.ts'

const EFFORT_TAIL = /\s*\((?:low|medium|high|xhigh|max)\)\s*$/i
const KNOWN_EFFORT_SLUG = /^(?:gemini|claude|gpt-oss)-[a-z0-9.-]+-(low|medium|high|xhigh|max)$/i
const GEMINI_FAMILY = /^gemini[\s-]+(?:\d+(?:\.\d+)*[\s-]+)?([a-z][a-z0-9]*(?:[\s-][a-z0-9]+)*)$/

// Antigravity sends display labels (`Gemini 4 Carbon (High)`, `Orchestrator (Carbon)`,
// `Claude Opus 5.5 (High)`, `GPT-OSS 120B (Medium)`). Strip any effort suffix so
// `:effort` never repeats it, shorten Gemini and Claude to their family, keep
// Orchestrator's variant, and preserve other provider identifiers whole.
export function shortAntigravityModelName(model: string): string | null {
  let id = model.trim().replace(EFFORT_TAIL, '').trim().toLowerCase()
  if (id === '') return null
  const slugEffort = KNOWN_EFFORT_SLUG.exec(id)?.[1]
  if (slugEffort) id = id.slice(0, -(slugEffort.length + 1))
  if (id.includes('claude')) return shortModelName(id)
  const orchestrator = /^orchestrator\s*\(([a-z0-9.-]+)\)$/.exec(id)
    ?? /^gemini-pro-orchestrator(?:-([a-z0-9.-]+))?$/.exec(id)
  if (orchestrator) return `orchestrator(${orchestrator[1] ?? 'carbon'})`
  const gemini = GEMINI_FAMILY.exec(id)?.[1]
  if (gemini) return gemini.replace(/\s+/g, '-')
  return id.replace(/\s+/g, '-')
}

export function antigravityDisplay(session: SessionValues) {
  return displaySession(session, shortAntigravityModelName, 0)
}
