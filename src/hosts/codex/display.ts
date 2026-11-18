import type { SessionValues } from '../../core/session.ts'
import { displaySession } from '../../render/session.ts'
import type { CodexOptions } from './options.ts'

// Only the named GPT families in the checked Codex catalog are shortened.
// Preserve other providers and model IDs rather than guessing from a suffix.
export function shortCodexModelName(model: string): string {
  return /^gpt-\d+(?:\.\d+)*-(astra|sol|terra|luna)$/i.exec(model.trim())?.[1]?.toLowerCase() ?? model
}

export function codexDisplay(session: SessionValues, options: CodexOptions) {
  const display = displaySession(session, shortCodexModelName)
  return {
    ...display,
    counts: {
      ...display.counts,
      agents: options.codexAgentCounts ? display.counts.agents : 0,
      skills: options.codexSkillCounts ? display.counts.skills : 0,
    },
  }
}
