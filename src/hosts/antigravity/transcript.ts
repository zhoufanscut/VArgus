import { createHash, randomBytes } from 'node:crypto'
import { open, readFile, stat } from 'node:fs/promises'
import { dirname, join, posix, resolve, sep, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initialCounts, type Counts } from '../../core/session.ts'
import { cachePath, readCache, writeCache } from './cache.ts'
import type { AntigravityPayload } from './collect.ts'

export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const CHUNK_BYTES = 256 * 1024
const HEAD_BYTES = 4096
const TAIL_BYTES = 256
const MUTATING_TOOLS = new Set(['run_command', 'write_file', 'edit_file', 'multi_edit', 'delete_file'])
const BUILTIN_OR_GLOBAL_SKILL = /\/\.gemini\/(?:antigravity(?:-cli)?\/builtin|config)(?:\/plugins\/[^/]+)?\/skills\/[^/]+\/SKILL\.md$/
const WORKSPACE_DOT_SKILL = /\/(?:\.agents?|_agents?)(?:\/plugins\/[^/]+)?\/skills\/[^/]+\/SKILL\.md$/
const TIMESTAMP_WRAPPER = /^(?:(?:Created At|Completed At): [^\r\n]*\r?\n)*/
const SPAWN_PREFIX_LF = 'Created the following subagent:\n{'
const SPAWN_PREFIX_CRLF = 'Created the following subagent:\r\n{'
const MAX_WORKSPACE_URIS = 16
const STANDARD_APP_DATA_DIR = /\/\.gemini\/antigravity(?:-cli)?$/

export type LastPlannerStep = {
  stepCount: number
  outputTokens: number
}

export type SpawnedSubagent = {
  id: string
  workspaceDirs?: readonly string[]
}

type TranscriptCache = {
  version: 5
  path: string
  skillContextKey: string
  epoch: string
  size: number
  firstLineHash: string
  tailHash: string
  startedAt: number | undefined
  turnIndex: number
  seenSkillsInTurn: string[]
  mutatingToolsSeen: number
  counts: Counts
  stepCount: number
  plannerStepsSeen: number
  compactionsSeen: number
  pendingTools: number
  awaitingModel: boolean
  lastPlanner?: LastPlannerStep
  firstToolAfterPlannerCreatedAt?: number
  unboundedTrailingStep: boolean
  batchHasSubagentSpawn: boolean
  subagents: SpawnedSubagent[]
}

export type TranscriptState = {
  startedAt: number | undefined
  counts: Counts
  mutatingToolsSeen: number
  epoch: string
  firstLineHash: string
  committedBytes: number
  mtimeMs: number
  stepCount: number
  plannerStepsSeen: number
  compactionsSeen: number
  awaitingModel: boolean
  lastPlanner?: LastPlannerStep
  firstToolAfterPlannerCreatedAt?: number
  unboundedTrailingStep: boolean
  subagentIds: readonly string[]
  subagents: readonly SpawnedSubagent[]
}

export type TranscriptLookupOptions = {
  home?: string
  appDataDir?: string
}

export type TranscriptReadContext = {
  cwd?: string
  projectDir?: string
  workspaceDirs?: readonly string[]
  home?: string
  appDataDir?: string
  customSkillRoots?: readonly string[]
  resolveSkillRoots?: () => Promise<readonly string[]>
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function isWindowsAbs(raw: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(raw) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(raw)
}

function toSlashKey(path: string): string {
  if (isWindowsAbs(path) || process.platform === 'win32') {
    const normalized = win32.normalize(path).replaceAll('\\', '/')
    return /^[A-Za-z]:\//.test(normalized)
      ? normalized[0]!.toLowerCase() + normalized.slice(1)
      : normalized
  }
  return posix.resolve(path)
}

export function normalizePathKey(path: string): string {
  const slash = toSlashKey(path)
  if (slash === '/' || /^[A-Za-z]:\/$/.test(slash)) return slash
  return slash.replace(/\/+$/, '')
}

export function transcriptSkillContextKey(context: TranscriptReadContext): string {
  const cwd = context.cwd ? normalizePathKey(context.cwd) : ''
  const projectDir = context.projectDir ? normalizePathKey(context.projectDir) : ''
  const workspaceDirs = context.workspaceDirs?.length
    ? [...new Set(context.workspaceDirs.map(normalizePathKey))].filter(dir => dir !== '' && dir !== cwd && dir !== projectDir).sort()
    : []
  const home = context.home ? normalizePathKey(context.home) : ''
  // Standard `.gemini/antigravity(-cli)` builtin skill paths are already matched by
  // BUILTIN_OR_GLOBAL_SKILL regardless of whether `appDataDir` is supplied.
  const rawAppData = context.appDataDir ? normalizePathKey(context.appDataDir) : ''
  const customAppData = rawAppData && !STANDARD_APP_DATA_DIR.test(rawAppData) ? rawAppData : ''
  const customRoots = context.customSkillRoots !== undefined
    ? [...new Set(context.customSkillRoots.map(normalizePathKey))].sort()
    : null
  return JSON.stringify([cwd, projectDir, workspaceDirs, home, customAppData, customRoots])
}

// Normalizes with the target OS's own path semantics before checking `/brain/<id>/`
// containment so neither dot-segments (`<id>/../../other.jsonl`) nor literal
// backslashes in POSIX segment names (`x\brain\<id>\y/../other.jsonl`) can escape.
export function resolveContainedTranscriptCandidate(
  given: string,
  rawId: string,
  platform: 'posix' | 'win32' = process.platform === 'win32' ? 'win32' : 'posix',
): string | null {
  if (!SAFE_ID.test(rawId)) return null
  if (platform === 'win32') {
    if (!isWindowsAbs(given)) return null
    const resolved = win32.normalize(given)
    const { root } = win32.parse(resolved)
    const afterRoot = root ? `\\${resolved.slice(root.length)}` : resolved
    return afterRoot.includes(`\\brain\\${rawId}\\`) ? resolved : null
  }
  if (!posix.isAbsolute(given)) return null
  const resolved = posix.resolve(given)
  return resolved.includes(`/brain/${rawId}/`) ? resolved : null
}

export function resolveConversationId(payload: AntigravityPayload): string {
  return (typeof payload.conversation_id === 'string' && payload.conversation_id.trim())
    || (typeof payload.session_id === 'string' && payload.session_id.trim())
    || ''
}

export function extractBrainDir(
  transcriptPath: string,
  parentId: string,
  platform: 'posix' | 'win32' = process.platform === 'win32' ? 'win32' : 'posix',
): string | null {
  if (!SAFE_ID.test(parentId)) return null
  if (platform === 'win32') {
    if (!isWindowsAbs(transcriptPath)) return null
    const resolved = win32.normalize(transcriptPath)
    const { root } = win32.parse(resolved)
    const afterRoot = root ? `\\${resolved.slice(root.length)}` : resolved
    const expectedTail = `\\brain\\${parentId}\\.system_generated\\logs\\transcript.jsonl`
    if (!afterRoot.endsWith(expectedTail)) return null
    const suffix = `\\${parentId}\\.system_generated\\logs\\transcript.jsonl`
    return resolved.slice(0, resolved.length - suffix.length)
  }
  if (!posix.isAbsolute(transcriptPath)) return null
  const resolved = posix.resolve(transcriptPath)
  const expectedTail = `/brain/${parentId}/.system_generated/logs/transcript.jsonl`
  if (!resolved.endsWith(expectedTail)) return null
  const suffix = `/${parentId}/.system_generated/logs/transcript.jsonl`
  return resolved.slice(0, resolved.length - suffix.length)
}

export async function resolveTranscriptPath(
  payload: AntigravityPayload,
  options: TranscriptLookupOptions = {},
): Promise<string | null> {
  const rawId = resolveConversationId(payload)
  if (!SAFE_ID.test(rawId)) return null

  const candidates: string[] = []
  const addCandidate = (candidate: string | undefined) => {
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate)
  }

  if (typeof payload.transcript_path === 'string' && payload.transcript_path.trim()) {
    const resolved = resolveContainedTranscriptCandidate(payload.transcript_path.trim(), rawId)
    if (resolved) {
      addCandidate(resolved)
      // Antigravity CLI 1.5.8 emits `.gemini/antigravity/brain/<id>/...` in statusLine
      // payloads while writing `.gemini/antigravity-cli/brain/<id>/...` on disk.
      const ideSegment = `${sep}.gemini${sep}antigravity${sep}`
      const cliSegment = `${sep}.gemini${sep}antigravity-cli${sep}`
      if (resolved.includes(ideSegment)) {
        addCandidate(resolved.replace(ideSegment, cliSegment))
      }
    }
  }

  if (options.appDataDir) {
    addCandidate(join(options.appDataDir, 'brain', rawId, '.system_generated', 'logs', 'transcript.jsonl'))
  }
  if (options.home) {
    addCandidate(join(options.home, '.gemini', 'antigravity-cli', 'brain', rawId, '.system_generated', 'logs', 'transcript.jsonl'))
  }

  for (const candidate of candidates) {
    if (await isRegularFile(candidate)) return candidate
  }
  return null
}

function unwrapArg(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (trimmed === '') return value
  const first = trimmed[0]
  if (first === '"' || first === '[' || first === '{' || trimmed === 'true' || trimmed === 'false' || trimmed === 'null' || /^-?\d/.test(trimmed)) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return value
    }
  }
  return value
}

function expandHome(home: string, raw: string): string {
  const rel = raw.replace(/^~(?:[\\/]+|$)/, '')
  const joined = isWindowsAbs(home) ? (rel ? win32.resolve(home, rel) : home) : (rel ? resolve(home, rel) : resolve(home))
  return toSlashKey(joined)
}

function resolveUserPath(raw: string, cwd: string | undefined, home: string | undefined): string | null {
  if (raw.startsWith('file://')) {
    try {
      return toSlashKey(fileURLToPath(raw))
    } catch {
      return null
    }
  }
  if (raw.includes('://')) return null
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    return home ? expandHome(home, raw) : null
  }
  if (isWindowsAbs(raw) || posix.isAbsolute(raw)) {
    return toSlashKey(raw)
  }
  if (cwd) {
    return toSlashKey(isWindowsAbs(cwd) ? win32.resolve(cwd, raw) : resolve(cwd, raw))
  }
  return null
}

type SkillsManifest = {
  entries?: { path?: unknown }[]
  inherits?: { path?: unknown }[]
}

export async function collectDeclaredSkillRoots(context: TranscriptReadContext): Promise<string[]> {
  const roots = new Set<string>()
  const visitedManifests = new Set<string>()
  let loadedManifests = 0

  // Per agy-customizations `docs/json_configs.md`, relative paths in `.agents/skills.json`
  // resolve against the directory containing the dot-dir first, falling back to the
  // project root when nothing exists there.
  const loadManifest = async (
    manifestPath: string,
    declaringDir: string,
    workspaceRoot: string | undefined,
  ): Promise<void> => {
    const key = toSlashKey(manifestPath)
    if (visitedManifests.has(key) || loadedManifests >= 16) return
    visitedManifests.add(key)
    let parsed: SkillsManifest
    try {
      parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as SkillsManifest
    } catch {
      return
    }
    loadedManifests += 1
    const resolveEntry = async (entryPath: string, checkFile: boolean): Promise<string | null> => {
      if (entryPath === '~' || entryPath.startsWith('~/') || entryPath.startsWith('~\\')) {
        return context.home ? expandHome(context.home, entryPath) : null
      }
      if (isWindowsAbs(entryPath) || posix.isAbsolute(entryPath)) {
        return toSlashKey(entryPath)
      }
      const localTarget = isWindowsAbs(declaringDir) ? win32.resolve(declaringDir, entryPath) : resolve(declaringDir, entryPath)
      if (!workspaceRoot || toSlashKey(declaringDir) === toSlashKey(workspaceRoot)) {
        return toSlashKey(localTarget)
      }
      const localExists = checkFile ? await isRegularFile(localTarget) : await isDirectory(localTarget)
      if (localExists) return toSlashKey(localTarget)
      const fallbackTarget = isWindowsAbs(workspaceRoot) ? win32.resolve(workspaceRoot, entryPath) : resolve(workspaceRoot, entryPath)
      return toSlashKey(fallbackTarget)
    }
    for (const item of parsed.inherits ?? []) {
      if (typeof item?.path === 'string' && item.path.trim()) {
        const inherited = await resolveEntry(item.path.trim(), true)
        if (inherited) {
          const parentDir = isWindowsAbs(inherited) ? win32.dirname(inherited) : dirname(inherited)
          await loadManifest(inherited, parentDir, workspaceRoot)
        }
      }
    }
    for (const entry of parsed.entries ?? []) {
      if (typeof entry?.path === 'string' && entry.path.trim()) {
        const dir = await resolveEntry(entry.path.trim(), false)
        if (dir) roots.add(dir.replace(/\/+$/, ''))
      }
    }
  }

  if (context.cwd) {
    let dir = isWindowsAbs(context.cwd) ? win32.normalize(context.cwd) : resolve(context.cwd)
    const stop = context.projectDir
      ? (isWindowsAbs(context.projectDir) ? win32.normalize(context.projectDir) : resolve(context.projectDir))
      : undefined
    for (let depth = 0; depth < 32; depth++) {
      for (const dot of ['.agents', '.agent', '_agents', '_agent']) {
        await loadManifest(join(dir, dot, 'skills.json'), dir, stop ?? dir)
      }
      if (stop && toSlashKey(dir) === toSlashKey(stop)) break
      const parent = isWindowsAbs(dir) ? win32.dirname(dir) : dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  for (const wsDir of context.workspaceDirs ?? []) {
    if (!wsDir) continue
    const dir = isWindowsAbs(wsDir) ? win32.normalize(wsDir) : resolve(wsDir)
    for (const dot of ['.agents', '.agent', '_agents', '_agent']) {
      await loadManifest(join(dir, dot, 'skills.json'), dir, dir)
    }
  }
  if (context.home) {
    const globalConfig = join(context.home, '.gemini', 'config')
    await loadManifest(join(globalConfig, 'skills.json'), globalConfig, context.projectDir ?? context.cwd)
  }
  return [...roots]
}

function isSkillPath(normalizedPath: string, customRoots: readonly string[], appDataDir: string | undefined): boolean {
  if (!normalizedPath.endsWith('/SKILL.md')) return false
  if (BUILTIN_OR_GLOBAL_SKILL.test(normalizedPath) || WORKSPACE_DOT_SKILL.test(normalizedPath)) return true
  if (appDataDir) {
    const base = toSlashKey(appDataDir).replace(/\/+$/, '')
    const prefix = `${base}/builtin/`
    if (normalizedPath.startsWith(prefix)) {
      const rest = normalizedPath.slice(prefix.length)
      if (/^(?:plugins\/[^/]+\/)?skills\/[^/]+\/SKILL\.md$/.test(rest)) return true
    }
  }
  for (const root of customRoots) {
    const prefix = `${root}/`
    if (normalizedPath.startsWith(prefix)) {
      const rest = normalizedPath.slice(prefix.length)
      if (/^[^/]+\/SKILL\.md$/.test(rest)) return true
    }
  }
  return false
}

type TranscriptStep = {
  type?: unknown
  created_at?: unknown
  input_tokens?: unknown
  output_tokens?: unknown
  content?: unknown
  tool_calls?: { name?: unknown; args?: Record<string, unknown> | null }[] | null
}

function extractLeadingJsonObject(text: string, start: number): string | null {
  if (text[start] !== '{') return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function parseWorkspaceUri(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed.startsWith('file://')) return null
  try {
    const url = new URL(trimmed)
    // Reject remote UNC/network hosts (`file://server/share`) on all platforms.
    if (url.protocol !== 'file:' || (url.hostname !== '' && url.hostname.toLowerCase() !== 'localhost')) return null
    const filePath = fileURLToPath(url)
    if (!filePath || filePath.includes('\0')) return null
    return isWindowsAbs(filePath) ? win32.normalize(filePath) : resolve(filePath)
  } catch {
    return null
  }
}

function extractSpawnedSubagent(content: string): SpawnedSubagent | null {
  const tsMatch = TIMESTAMP_WRAPPER.exec(content)
  const offset = tsMatch ? tsMatch[0].length : 0
  let jsonStart = -1
  if (content.startsWith(SPAWN_PREFIX_LF, offset)) {
    jsonStart = offset + SPAWN_PREFIX_LF.length - 1
  } else if (content.startsWith(SPAWN_PREFIX_CRLF, offset)) {
    jsonStart = offset + SPAWN_PREFIX_CRLF.length - 1
  } else {
    return null
  }
  const rawJson = extractLeadingJsonObject(content, jsonStart)
  if (!rawJson) return null
  try {
    const parsed = JSON.parse(rawJson) as { conversationId?: unknown; workspaceUris?: unknown }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (typeof parsed.conversationId !== 'string') return null
    const id = parsed.conversationId.trim()
    if (!SAFE_ID.test(id)) return null
    const workspaceDirs: string[] = []
    const seenKeys = new Set<string>()
    if (Array.isArray(parsed.workspaceUris)) {
      for (const entry of parsed.workspaceUris) {
        if (workspaceDirs.length >= MAX_WORKSPACE_URIS) break
        const dir = parseWorkspaceUri(entry)
        if (!dir) continue
        const key = normalizePathKey(dir)
        if (seenKeys.has(key)) continue
        seenKeys.add(key)
        workspaceDirs.push(dir)
      }
    }
    return workspaceDirs.length > 0 ? { id, workspaceDirs } : { id }
  } catch {
    return null
  }
}

function isValidCachedSubagent(value: unknown): value is SpawnedSubagent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  if (typeof entry.id !== 'string' || !SAFE_ID.test(entry.id)) return false
  if (entry.workspaceDirs !== undefined) {
    if (!Array.isArray(entry.workspaceDirs) || entry.workspaceDirs.length === 0 || entry.workspaceDirs.length > MAX_WORKSPACE_URIS) {
      return false
    }
    for (const dir of entry.workspaceDirs) {
      if (typeof dir !== 'string' || dir === '' || dir.includes('\0')) return false
      if (!isWindowsAbs(dir) && !posix.isAbsolute(dir)) return false
    }
  }
  return true
}

function mergeSpawnedSubagent(
  subagents: Map<string, readonly string[] | undefined>,
  spawn: SpawnedSubagent,
): void {
  const existing = subagents.get(spawn.id)
  if (!subagents.has(spawn.id) || (!existing?.length && spawn.workspaceDirs?.length)) {
    subagents.set(spawn.id, spawn.workspaceDirs)
  }
}

function serializeSubagents(subagents: Map<string, readonly string[] | undefined>): SpawnedSubagent[] {
  const out: SpawnedSubagent[] = []
  for (const [id, workspaceDirs] of subagents) {
    out.push(workspaceDirs?.length ? { id, workspaceDirs: [...workspaceDirs] } : { id })
  }
  return out
}

function applyStep(
  rawStep: unknown,
  state: {
    startedAt: number | undefined
    turnIndex: number
    seenSkills: Set<string>
    mutatingToolsSeen: number
    counts: Counts
    stepCount: number
    plannerStepsSeen: number
    compactionsSeen: number
    pendingTools: number
    awaitingModel: boolean
    lastPlanner: LastPlannerStep | undefined
    firstToolAfterPlannerCreatedAt: number | undefined
    unboundedTrailingStep: boolean
    batchHasSubagentSpawn: boolean
    subagents: Map<string, readonly string[] | undefined>
  },
  context: TranscriptReadContext,
  customSkillRoots: readonly string[],
): void {
  if (!rawStep || typeof rawStep !== 'object' || Array.isArray(rawStep)) return
  const step = rawStep as TranscriptStep
  state.stepCount += 1
  let createdMs: number | undefined
  if (typeof step.created_at === 'string') {
    const parsed = Date.parse(step.created_at)
    if (!Number.isNaN(parsed)) {
      createdMs = parsed
      if (state.startedAt === undefined || parsed < state.startedAt) {
        state.startedAt = parsed
      }
    }
  }

  // Uncached input + output tokens across model steps (`PLANNER_RESPONSE` and
  // compaction `CHECKPOINT`); `cache_read_tokens` is separate on Antigravity 1.5.8.
  const inputTokens = typeof step.input_tokens === 'number' && Number.isFinite(step.input_tokens) ? Math.max(0, step.input_tokens) : 0
  const outputTokens = typeof step.output_tokens === 'number' && Number.isFinite(step.output_tokens) ? Math.max(0, step.output_tokens) : 0
  if (inputTokens > 0 || outputTokens > 0) {
    state.counts.tokens += inputTokens + outputTokens
  }

  let validToolCalls = 0
  let hasSubagentSpawn = false
  if (Array.isArray(step.tool_calls)) {
    for (const call of step.tool_calls) {
      if (!call || typeof call !== 'object') continue
      const name = typeof call.name === 'string' ? call.name.trim() : ''
      if (!name) continue
      validToolCalls += 1
      state.counts.tools += 1
      if (MUTATING_TOOLS.has(name)) state.mutatingToolsSeen += 1

      const args = call.args && typeof call.args === 'object' ? call.args : undefined
      if (name === 'invoke_subagent') {
        state.counts.agents += 1
        hasSubagentSpawn = true
      } else if (name === 'swarm' && unwrapArg(args?.action) === 'add') {
        const tasks = unwrapArg(args?.tasks)
        const copies = unwrapArg(args?.n)
        if (Array.isArray(tasks) && tasks.length > 0) state.counts.agents += tasks.length
        else if (typeof copies === 'number' && Number.isFinite(copies) && copies > 1) state.counts.agents += Math.floor(copies)
        else state.counts.agents += 1
      } else if (name === 'read_file') {
        const rawPath = unwrapArg(args?.Path)
        if (typeof rawPath === 'string' && rawPath.trim()) {
          const resolved = resolveUserPath(rawPath.trim(), context.cwd, context.home)
          if (resolved && isSkillPath(resolved, customSkillRoots, context.appDataDir) && !state.seenSkills.has(resolved)) {
            state.seenSkills.add(resolved)
            state.counts.skills += 1
          }
        }
      }
    }
  }

  if (step.type === 'USER_INPUT') {
    state.turnIndex += 1
    state.seenSkills.clear()
    state.pendingTools = 0
    state.batchHasSubagentSpawn = false
    state.awaitingModel = true
    state.firstToolAfterPlannerCreatedAt = undefined
    if (state.lastPlanner) state.unboundedTrailingStep = true
  } else if (step.type === 'PLANNER_RESPONSE') {
    state.plannerStepsSeen += 1
    state.lastPlanner = { stepCount: state.stepCount, outputTokens }
    state.pendingTools = validToolCalls
    state.batchHasSubagentSpawn = hasSubagentSpawn
    state.awaitingModel = false
    state.firstToolAfterPlannerCreatedAt = undefined
    state.unboundedTrailingStep = false
  } else if (step.type === 'CHECKPOINT') {
    state.compactionsSeen += 1
    state.pendingTools = 0
    state.batchHasSubagentSpawn = false
    state.awaitingModel = true
    state.firstToolAfterPlannerCreatedAt = undefined
    if (state.lastPlanner) state.unboundedTrailingStep = true
  } else if (step.type === 'SYSTEM_MESSAGE') {
    if (state.pendingTools === 0) state.awaitingModel = true
    if (state.lastPlanner) state.unboundedTrailingStep = true
  } else if (typeof step.type === 'string' && step.type !== '' && state.pendingTools > 0) {
    if (state.batchHasSubagentSpawn && step.type === 'GENERIC' && typeof step.content === 'string') {
      const spawn = extractSpawnedSubagent(step.content)
      if (spawn) mergeSpawnedSubagent(state.subagents, spawn)
    }
    if (createdMs === undefined) state.unboundedTrailingStep = true
    else if (state.firstToolAfterPlannerCreatedAt === undefined) state.firstToolAfterPlannerCreatedAt = createdMs
    state.pendingTools -= 1
    if (state.pendingTools === 0) {
      state.awaitingModel = true
      state.batchHasSubagentSpawn = false
    }
  } else if (state.lastPlanner) {
    state.unboundedTrailingStep = true
  }
}

async function hashWindowAt(
  handle: Awaited<ReturnType<typeof open>>,
  endOffset: number,
): Promise<string> {
  if (endOffset <= 0) return ''
  const length = Math.min(TAIL_BYTES, endOffset)
  const buf = Buffer.allocUnsafe(length)
  const { bytesRead } = await handle.read(buf, 0, length, endOffset - length)
  return createHash('sha256').update(buf.subarray(0, bytesRead)).digest('hex')
}

export async function readTranscriptState(
  transcriptPath: string,
  cacheDir: string,
  context: TranscriptReadContext = {},
): Promise<TranscriptState> {
  const empty = (): TranscriptState => ({
    startedAt: undefined,
    counts: initialCounts(),
    mutatingToolsSeen: 0,
    epoch: '',
    firstLineHash: '',
    committedBytes: 0,
    mtimeMs: 0,
    stepCount: 0,
    plannerStepsSeen: 0,
    compactionsSeen: 0,
    awaitingModel: false,
    unboundedTrailingStep: false,
    subagentIds: [],
    subagents: [],
  })
  let handle
  try {
    handle = await open(transcriptPath, 'r')
  } catch {
    return empty()
  }

  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size <= 0) return empty()

    const headLength = Math.min(HEAD_BYTES, info.size)
    const headBuffer = Buffer.allocUnsafe(headLength)
    const { bytesRead: headRead } = await handle.read(headBuffer, 0, headLength, 0)
    if (headRead <= 0) return empty()
    const headSlice = headBuffer.subarray(0, headRead)
    const firstNewline = headSlice.indexOf(0x0a)
    // Wait until at least one complete JSONL line has been flushed.
    if (firstNewline < 0 && info.size < HEAD_BYTES) return empty()
    const firstLineBytes = firstNewline >= 0 ? headSlice.subarray(0, firstNewline) : headSlice
    const firstLineHash = createHash('sha256').update(firstLineBytes).digest('hex')

    const skillContextKey = transcriptSkillContextKey(context)
    const file = cachePath(cacheDir, 'transcript', transcriptPath)
    const cached = await readCache<TranscriptCache>(file)
    const hasValidHeader = Boolean(
      cached
      && cached.path === transcriptPath
      && typeof cached.epoch === 'string'
      && cached.epoch !== ''
      && cached.firstLineHash === firstLineHash
      && cached.size >= 0
      && cached.size <= info.size,
    )
    let sameBytes = hasValidHeader
    if (sameBytes && cached && cached.size > 0) {
      const actualTail = await hashWindowAt(handle, cached.size)
      if (actualTail !== cached.tailHash) sameBytes = false
    }
    const canResume = Boolean(
      sameBytes
      && cached
      && cached.version === 5
      && cached.skillContextKey === skillContextKey
      && typeof cached.stepCount === 'number'
      && typeof cached.plannerStepsSeen === 'number'
      && typeof cached.compactionsSeen === 'number'
      && typeof cached.pendingTools === 'number'
      && typeof cached.awaitingModel === 'boolean'
      && typeof cached.unboundedTrailingStep === 'boolean'
      && typeof cached.batchHasSubagentSpawn === 'boolean'
      && Array.isArray(cached.subagents)
      && cached.subagents.every(isValidCachedSubagent),
    )

    if (canResume && cached && cached.size === info.size) {
      const subagentMap = new Map<string, readonly string[] | undefined>()
      for (const spawn of cached.subagents) mergeSpawnedSubagent(subagentMap, spawn)
      const subagents = serializeSubagents(subagentMap)
      return {
        startedAt: cached.startedAt,
        counts: initialCounts(cached.counts),
        mutatingToolsSeen: cached.mutatingToolsSeen,
        epoch: cached.epoch,
        firstLineHash,
        committedBytes: cached.size,
        mtimeMs: info.mtimeMs,
        stepCount: cached.stepCount,
        plannerStepsSeen: cached.plannerStepsSeen,
        compactionsSeen: cached.compactionsSeen,
        awaitingModel: cached.awaitingModel,
        lastPlanner: cached.lastPlanner,
        firstToolAfterPlannerCreatedAt: cached.firstToolAfterPlannerCreatedAt,
        unboundedTrailingStep: cached.unboundedTrailingStep,
        subagentIds: subagents.map(s => s.id),
        subagents,
      }
    }

    // Preserve epoch across context-only or cache-version replays when the underlying
    // transcript bytes have not rewound so rate tracking stays intact.
    const epoch = sameBytes && cached ? cached.epoch : randomBytes(8).toString('hex')
    const customSkillRoots = context.customSkillRoots
      ?? (context.resolveSkillRoots ? await context.resolveSkillRoots() : await collectDeclaredSkillRoots(context))
    const initialSubagents = new Map<string, readonly string[] | undefined>()
    if (canResume && cached) {
      for (const spawn of cached.subagents) mergeSpawnedSubagent(initialSubagents, spawn)
    }
    const state = {
      startedAt: canResume && cached ? cached.startedAt : undefined,
      turnIndex: canResume && cached ? cached.turnIndex : 0,
      seenSkills: new Set<string>(canResume && cached ? cached.seenSkillsInTurn : []),
      mutatingToolsSeen: canResume && cached ? cached.mutatingToolsSeen : 0,
      counts: initialCounts(canResume ? cached?.counts : undefined),
      stepCount: canResume && cached ? cached.stepCount : 0,
      plannerStepsSeen: canResume && cached ? cached.plannerStepsSeen : 0,
      compactionsSeen: canResume && cached ? cached.compactionsSeen : 0,
      pendingTools: canResume && cached ? cached.pendingTools : 0,
      awaitingModel: canResume && cached ? cached.awaitingModel : false,
      lastPlanner: canResume && cached ? cached.lastPlanner : undefined,
      firstToolAfterPlannerCreatedAt: canResume && cached ? cached.firstToolAfterPlannerCreatedAt : undefined,
      unboundedTrailingStep: canResume && cached ? cached.unboundedTrailingStep : false,
      batchHasSubagentSpawn: canResume && cached ? cached.batchHasSubagentSpawn : false,
      subagents: initialSubagents,
    }

    let readOffset = canResume && cached ? cached.size : 0
    let committedOffset = readOffset
    let carry: Buffer = Buffer.alloc(0)
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES)

    while (readOffset < info.size) {
      const toRead = Math.min(CHUNK_BYTES, info.size - readOffset)
      const { bytesRead } = await handle.read(buffer, 0, toRead, readOffset)
      if (bytesRead <= 0) break
      readOffset += bytesRead
      const chunk = carry.length > 0
        ? Buffer.concat([carry, buffer.subarray(0, bytesRead)])
        : buffer.subarray(0, bytesRead)

      let lineStart = 0
      for (;;) {
        const nl = chunk.indexOf(0x0a, lineStart)
        if (nl < 0) break
        const lineBytes = chunk.subarray(lineStart, nl)
        committedOffset += (nl - lineStart) + 1
        lineStart = nl + 1
        const text = lineBytes.toString('utf8').trim()
        if (!text) continue
        try {
          applyStep(JSON.parse(text), state, context, customSkillRoots)
        } catch {
          // skip malformed line
        }
      }
      carry = lineStart < chunk.length ? Buffer.from(chunk.subarray(lineStart)) : Buffer.alloc(0)
    }

    const tailHash = await hashWindowAt(handle, committedOffset)
    const subagents = serializeSubagents(state.subagents)
    const subagentIds = subagents.map(s => s.id)
    const updated: TranscriptCache = {
      version: 5,
      path: transcriptPath,
      skillContextKey,
      epoch,
      size: committedOffset,
      firstLineHash,
      tailHash,
      startedAt: state.startedAt,
      turnIndex: state.turnIndex,
      seenSkillsInTurn: [...state.seenSkills],
      mutatingToolsSeen: state.mutatingToolsSeen,
      counts: state.counts,
      stepCount: state.stepCount,
      plannerStepsSeen: state.plannerStepsSeen,
      compactionsSeen: state.compactionsSeen,
      pendingTools: state.pendingTools,
      awaitingModel: state.awaitingModel,
      lastPlanner: state.lastPlanner,
      firstToolAfterPlannerCreatedAt: state.firstToolAfterPlannerCreatedAt,
      unboundedTrailingStep: state.unboundedTrailingStep,
      batchHasSubagentSpawn: state.batchHasSubagentSpawn,
      subagents,
    }
    await writeCache(cacheDir, file, updated).catch(() => {})

    return {
      startedAt: state.startedAt,
      counts: state.counts,
      mutatingToolsSeen: state.mutatingToolsSeen,
      epoch,
      firstLineHash,
      committedBytes: committedOffset,
      mtimeMs: info.mtimeMs,
      stepCount: state.stepCount,
      plannerStepsSeen: state.plannerStepsSeen,
      compactionsSeen: state.compactionsSeen,
      awaitingModel: state.awaitingModel,
      lastPlanner: state.lastPlanner,
      firstToolAfterPlannerCreatedAt: state.firstToolAfterPlannerCreatedAt,
      unboundedTrailingStep: state.unboundedTrailingStep,
      subagentIds,
      subagents,
    }
  } finally {
    await handle.close().catch(() => {})
  }
}
