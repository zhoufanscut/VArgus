import { resolveOptions } from '../../options.ts'

export function resolveCodexOptions(given: Record<string, unknown>) {
  return {
    ...resolveOptions(given),
    codexAgentCounts: given.codexAgentCounts !== false,
    codexSkillCounts: given.codexSkillCounts !== false,
    codexAutoStart: given.codexAutoStart !== false,
  }
}

export type CodexOptions = ReturnType<typeof resolveCodexOptions>
