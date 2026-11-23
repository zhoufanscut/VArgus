import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { addCounts, initialCounts, type Counts } from '../../core/session.ts'
import {
  collectDeclaredSkillRoots,
  extractBrainDir,
  readTranscriptState,
  resolveContainedTranscriptCandidate,
  SAFE_ID,
  type TranscriptReadContext,
  type TranscriptState,
} from './transcript.ts'

export const MAX_SUBAGENT_DEPTH = 8
export const MAX_SUBAGENT_TRANSCRIPTS = 64
export const SUBAGENT_BUDGET_MS = 400

export type SubagentCollectInput = {
  rootTranscriptPath: string
  rootId: string
  rootTranscript: TranscriptState
  cacheDir: string
  context?: TranscriptReadContext
  maxDepth?: number
  maxTranscripts?: number
  budgetMs?: number
  nowMs?: () => number
}

export async function collectAntigravitySubagentCounts(input: SubagentCollectInput): Promise<Counts> {
  let total = initialCounts(input.rootTranscript.counts)
  const rootId = input.rootId.trim()
  if (!SAFE_ID.test(rootId)) return total
  if (input.rootTranscript.subagentIds.length === 0) return total

  const brainDir = extractBrainDir(input.rootTranscriptPath, rootId)
  if (!brainDir) return total

  const maxDepth = input.maxDepth ?? MAX_SUBAGENT_DEPTH
  const maxTranscripts = input.maxTranscripts ?? MAX_SUBAGENT_TRANSCRIPTS
  const budgetMs = input.budgetMs ?? SUBAGENT_BUDGET_MS
  const nowMs = input.nowMs ?? (() => performance.now())
  const startMs = nowMs()

  if (maxDepth <= 0 || maxTranscripts <= 0 || nowMs() - startMs >= budgetMs) return total

  const baseContext = input.context ?? {}
  let skillRootsPromise: Promise<readonly string[]> | undefined
  const childContext: TranscriptReadContext = baseContext.customSkillRoots
    ? baseContext
    : {
      ...baseContext,
      resolveSkillRoots: () => {
        skillRootsPromise ??= baseContext.resolveSkillRoots
          ? baseContext.resolveSkillRoots()
          : collectDeclaredSkillRoots(baseContext)
        return skillRootsPromise
      },
    }

  const visited = new Set<string>([rootId])
  const queue: { id: string; depth: number }[] = []
  const enqueue = (ids: readonly string[], depth: number) => {
    if (depth > maxDepth) return
    for (const raw of ids) {
      const id = raw.trim()
      if (!SAFE_ID.test(id) || visited.has(id)) continue
      visited.add(id)
      queue.push({ id, depth })
    }
  }

  enqueue(input.rootTranscript.subagentIds, 1)

  let readCount = 0
  for (let head = 0; head < queue.length; head++) {
    if (readCount >= maxTranscripts) break
    if (nowMs() - startMs >= budgetMs) break
    const { id, depth } = queue[head]!
    const candidate = join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl')
    const childPath = resolveContainedTranscriptCandidate(candidate, id)
    if (!childPath) continue
    readCount += 1
    let child: TranscriptState
    try {
      child = await readTranscriptState(childPath, input.cacheDir, childContext)
    } catch {
      continue
    }
    total = addCounts(total, child.counts)
    if (child.subagentIds.length > 0 && depth < maxDepth) {
      enqueue(child.subagentIds, depth + 1)
    }
  }

  return total
}
