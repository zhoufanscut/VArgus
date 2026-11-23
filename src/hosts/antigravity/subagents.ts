import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { addCounts, initialCounts, type Counts } from '../../core/session.ts'
import {
  collectDeclaredSkillRoots,
  extractBrainDir,
  normalizePathKey,
  readTranscriptState,
  resolveContainedTranscriptCandidate,
  SAFE_ID,
  transcriptSkillContextKey,
  type SpawnedSubagent,
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

function sameWorkspace(context: TranscriptReadContext, workspaceDirs: readonly string[]): boolean {
  if (workspaceDirs.length !== 1 || !context.cwd) return false
  const childKey = normalizePathKey(workspaceDirs[0]!)
  if (context.workspaceDirs?.some(dir => normalizePathKey(dir) !== childKey)) return false
  if (normalizePathKey(context.cwd) !== childKey) return false
  if (context.projectDir && normalizePathKey(context.projectDir) !== childKey) return false
  return true
}

function listSpawns(state: TranscriptState): readonly SpawnedSubagent[] {
  if (state.subagents.length > 0) return state.subagents
  return state.subagentIds.map(id => ({ id }))
}

export async function collectAntigravitySubagentCounts(input: SubagentCollectInput): Promise<Counts> {
  let total = initialCounts(input.rootTranscript.counts)
  const rootId = input.rootId.trim()
  if (!SAFE_ID.test(rootId)) return total
  const rootSpawns = listSpawns(input.rootTranscript)
  if (rootSpawns.length === 0) return total

  const brainDir = extractBrainDir(input.rootTranscriptPath, rootId)
  if (!brainDir) return total

  const maxDepth = input.maxDepth ?? MAX_SUBAGENT_DEPTH
  const maxTranscripts = input.maxTranscripts ?? MAX_SUBAGENT_TRANSCRIPTS
  const budgetMs = input.budgetMs ?? SUBAGENT_BUDGET_MS
  const nowMs = input.nowMs ?? (() => performance.now())
  const startMs = nowMs()

  if (maxDepth <= 0 || maxTranscripts <= 0 || nowMs() - startMs >= budgetMs) return total

  const baseContext = input.context ?? {}
  const skillRootsCache = new Map<string, Promise<readonly string[]>>()
  const withCachedSkillRoots = (context: TranscriptReadContext, inheritResolver: boolean): TranscriptReadContext => {
    if (inheritResolver && context.customSkillRoots) return context
    const key = transcriptSkillContextKey(context)
    return {
      ...context,
      resolveSkillRoots: () => {
        let pending = skillRootsCache.get(key)
        if (!pending) {
          pending = inheritResolver && context.resolveSkillRoots
            ? context.resolveSkillRoots()
            : collectDeclaredSkillRoots(context)
          skillRootsCache.set(key, pending)
        }
        return pending
      },
    }
  }
  const rootChildContext = withCachedSkillRoots(baseContext, true)

  const contextForChild = (
    parentContext: TranscriptReadContext,
    workspaceDirs: readonly string[] | undefined,
  ): TranscriptReadContext => {
    if (!workspaceDirs || workspaceDirs.length === 0 || sameWorkspace(parentContext, workspaceDirs)) {
      return parentContext
    }
    const primary = workspaceDirs[0]!
    const derived: TranscriptReadContext = {
      cwd: primary,
      projectDir: primary,
      ...(workspaceDirs.length > 1 ? { workspaceDirs } : {}),
      home: baseContext.home,
      appDataDir: baseContext.appDataDir,
    }
    if (transcriptSkillContextKey(derived) === transcriptSkillContextKey(rootChildContext)) {
      return rootChildContext
    }
    return withCachedSkillRoots(derived, false)
  }

  const visited = new Set<string>([rootId])
  const queue: { id: string; depth: number; context: TranscriptReadContext }[] = []
  const enqueue = (spawns: readonly SpawnedSubagent[], depth: number, parentContext: TranscriptReadContext) => {
    if (depth > maxDepth) return
    for (const spawn of spawns) {
      const id = spawn.id.trim()
      if (!SAFE_ID.test(id) || visited.has(id)) continue
      visited.add(id)
      queue.push({ id, depth, context: contextForChild(parentContext, spawn.workspaceDirs) })
    }
  }

  enqueue(rootSpawns, 1, rootChildContext)

  let readCount = 0
  for (let head = 0; head < queue.length; head++) {
    if (readCount >= maxTranscripts) break
    if (nowMs() - startMs >= budgetMs) break
    const { id, depth, context } = queue[head]!
    const candidate = join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl')
    const childPath = resolveContainedTranscriptCandidate(candidate, id)
    if (!childPath) continue
    readCount += 1
    let child: TranscriptState
    try {
      child = await readTranscriptState(childPath, input.cacheDir, context)
    } catch {
      continue
    }
    total = addCounts(total, child.counts)
    const nested = listSpawns(child)
    if (nested.length > 0 && depth < maxDepth) {
      enqueue(nested, depth + 1, context)
    }
  }

  return total
}
