import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { lstat, open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createOmoHistory, foldOmoEntry, type OmoHistory } from './collect.ts'

export type OmoEnv = Readonly<Record<string, string | undefined>>

export type ResolveStateDirOptions = {
  readonly env?: OmoEnv
  readonly accountHomeDir?: string
}

export type SubagentSnapshot = {
  readonly tokens: number
  readonly tools: number
  readonly taskIds: ReadonlySet<string>
}

const EMPTY_SNAPSHOT: SubagentSnapshot = { tokens: 0, tools: 0, taskIds: new Set() }

const ACTIVE_POLL_MS = 1000
const IDLE_POLL_MS = 5000
const HOLD_FACTOR = 10
const CHUNK_BYTES = 64 * 1024
const MAX_PROJECT_CONFIG_DEPTH = 256

const TASK_ID_PATTERN = /^st_[0-9a-f]{8}$/
const NON_TERMINAL_STATUSES = new Set(['pending', 'running', 'paused'])
const AGENT_DIR_ENV_NAMES = ['OMO_CODING_AGENT_DIR', 'SENPI_CODING_AGENT_DIR', 'PI_CODING_AGENT_DIR'] as const
const HARNESS_KEYS = new Set(['[codex]', '[opencode]', '[omo]', '[native]', '[senpi]'])
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const OPENCODE_PROFILE_PATTERN = /(?:^|[\\/])profiles[\\/]([^\\/]+)[\\/]*$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.prototype.toString.call(value) === '[object Object]'
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue)
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key)) continue
    out[key] = sanitizeValue(entry)
  }
  return out
}

function mergeRecords(
  base: Readonly<Record<string, unknown>>,
  override: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (UNSAFE_KEYS.has(key)) continue
    const safe = sanitizeValue(value)
    const prev = result[key]
    result[key] = isPlainObject(prev) && isPlainObject(safe) ? mergeRecords(prev, safe) : safe
  }
  return result
}

function stripTrailingCommas(text: string): string {
  let out = ''
  let prev = ''
  const len = text.length
  for (let i = 0; i < len;) {
    const ch = text[i]!
    if (ch === '"') {
      const start = i
      i++
      while (i < len) {
        const c = text[i++]!
        if (c === '\\') { if (i < len) i++ }
        else if (c === '"') break
      }
      out += text.slice(start, i)
      prev = 'v'
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      out += ch
      i++
      continue
    }
    if (ch === ',') {
      let j = i + 1
      while (j < len) {
        const next = text[j]!
        if (next === ' ' || next === '\t' || next === '\r' || next === '\n') { j++; continue }
        break
      }
      const next = j < len ? text[j]! : ''
      if ((next === '}' || next === ']') && prev === 'v') {
        prev = ','
        i++
        continue
      }
      out += ch
      prev = ','
      i++
      continue
    }
    out += ch
    prev = ch === '{' || ch === '[' || ch === ':' ? ch : 'v'
    i++
  }
  return out
}

// Self-contained JSONC parser matching OmO's config loader (BOM, comments and
// trailing commas allowed; root must be a plain JSON object).
export function parseOmoJsonc(text: string): Record<string, unknown> | null {
  let unterminated = false
  const uncommented = text.replace(/^\uFEFF|"(?:\\[\s\S]|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|\/\*/g, token => {
    if (token[0] === '"') return token
    if (token === '/*') { unterminated = true; return token }
    return token.replace(/[^\r\n]/g, ' ')
  })
  if (unterminated) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(stripTrailingCommas(uncommented))
  } catch {
    return null
  }
  if (!isPlainObject(parsed)) return null
  return sanitizeValue(parsed) as Record<string, unknown>
}

function canonicalizeContainer(container: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const hasNative = Object.hasOwn(container, '[native]')
  for (const [key, value] of Object.entries(container)) {
    if (key === '[senpi]') {
      // Match OmO's canonicalizeLegacyHarnessBlocks: drop [senpi] when [native]
      // is also present on the same container, else promote it to [native].
      if (!hasNative) result['[native]'] = value
      continue
    }
    result[key] = value
  }
  return result
}

function canonicalizeLegacyHarnessBlocks(doc: Record<string, unknown>): Record<string, unknown> {
  const out = canonicalizeContainer(doc)
  if (isPlainObject(out.profiles)) {
    const profiles: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(out.profiles)) {
      profiles[name] = isPlainObject(value) ? canonicalizeContainer(value) : value
    }
    out.profiles = profiles
  }
  return out
}

function withoutControlKeys(config: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (key === 'profiles' || HARNESS_KEYS.has(key)) continue
    result[key] = value
  }
  return result
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

function resolveProfileName(env: OmoEnv): string | undefined {
  const fromOpenCode = env.OPENCODE_CONFIG_DIR?.match(OPENCODE_PROFILE_PATTERN)?.[1]
  return nonEmpty(env.OMO_PROFILE) ?? nonEmpty(env.OCX_PROFILE) ?? nonEmpty(fromOpenCode)
}

function resolveNativeConfigView(
  merged: Readonly<Record<string, unknown>>,
  profileName: string | undefined,
): Record<string, unknown> {
  const profiles = isPlainObject(merged.profiles) ? merged.profiles : undefined
  const profileValue = profileName !== undefined && profiles !== undefined && Object.hasOwn(profiles, profileName)
    ? profiles[profileName] : undefined
  const profile = isPlainObject(profileValue) ? profileValue : undefined

  const layers: Record<string, unknown>[] = [withoutControlKeys(merged)]
  if (isPlainObject(merged['[native]'])) layers.push(merged['[native]'])
  if (profile) {
    layers.push(withoutControlKeys(profile))
    if (isPlainObject(profile['[native]'])) layers.push(profile['[native]'])
  }

  let resolved: Record<string, unknown> = {}
  for (const layer of layers) resolved = mergeRecords(resolved, layer)
  return withoutControlKeys(resolved)
}

function resolveConfigHomeDir(env: OmoEnv): string {
  return resolve(env.HOME ?? env.USERPROFILE ?? process.cwd())
}

function defaultAccountHomeDir(): string {
  try {
    return userInfo().homedir
  } catch {
    return homedir()
  }
}

function agentDirectory(env: OmoEnv): string {
  for (const name of AGENT_DIR_ENV_NAMES) {
    const configured = env[name]?.trim()
    if (configured) return resolve(configured)
  }
  return join(env.HOME ?? env.USERPROFILE ?? homedir(), '.omo', 'agent')
}

function projectStateKeyFromAbsolute(absolute: string): string {
  const hash = createHash('sha256').update(absolute).digest('hex').slice(0, 12)
  const name = basename(absolute).replace(/[^\p{L}\p{N}._-]/gu, '_') || 'root'
  return `${name}-${hash}`
}

export function projectStateKey(projectDir: string): string {
  const absolute = resolve(projectDir)
  let canonical = absolute
  try {
    canonical = realpathSync.native(absolute)
  } catch {
    canonical = absolute
  }
  return projectStateKeyFromAbsolute(canonical)
}

function isMissingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

async function realpathOrSelf(target: string): Promise<string> {
  try {
    return await realpath(target)
  } catch {
    return target
  }
}

async function isSymlinkedProjectPath(target: string): Promise<boolean> {
  if (!await pathExists(target)) return false
  try {
    return (await lstat(target)).isSymbolicLink()
  } catch {
    return true
  }
}

async function isLoadableProjectConfigFile(target: string): Promise<boolean> {
  return await pathExists(target) && !await isSymlinkedProjectPath(target)
}

async function detectUserOmoConfigPath(env: OmoEnv): Promise<string | null> {
  const configDir = join(resolveConfigHomeDir(env), '.omo')
  const jsonc = join(configDir, 'omo.jsonc')
  if (await pathExists(jsonc)) return jsonc
  const json = join(configDir, 'omo.json')
  return await pathExists(json) ? json : null
}

async function detectProjectOmoConfigPath(dir: string): Promise<string | null> {
  const omoDir = join(dir, '.omo')
  if (!await pathExists(omoDir) || await isSymlinkedProjectPath(omoDir)) return null
  const jsonc = join(omoDir, 'omo.jsonc')
  if (await isLoadableProjectConfigFile(jsonc)) return jsonc
  const json = join(omoDir, 'omo.json')
  return await isLoadableProjectConfigFile(json) ? json : null
}

async function findProjectConfigPathsFarthestFirst(
  cwd: string,
  homeDir: string,
  accountHomeDir: string,
): Promise<readonly string[]> {
  const startDir = resolve(cwd)
  const boundaryDirs = [...new Set([resolve(homeDir), resolve(accountHomeDir)])]
  const realBoundaryDirs = new Set(await Promise.all(boundaryDirs.map(realpathOrSelf)))
  const nearestFirst: string[] = []
  let currentDir = startDir

  for (let depth = 0; depth < MAX_PROJECT_CONFIG_DEPTH; depth++) {
    const isHomeDir = boundaryDirs.includes(currentDir) || realBoundaryDirs.has(await realpathOrSelf(currentDir))
    if (isHomeDir) break
    const configPath = await detectProjectOmoConfigPath(currentDir)
    if (configPath !== null) nearestFirst.push(configPath)
    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) break
    currentDir = parentDir
  }

  return nearestFirst.reverse()
}

async function resolveConfiguredStateDir(
  cwd: string,
  env: OmoEnv,
  accountHomeDir: string,
): Promise<string | undefined> {
  const userPath = await detectUserOmoConfigPath(env)
  const projectPaths = await findProjectConfigPathsFarthestFirst(cwd, resolveConfigHomeDir(env), accountHomeDir)
  const candidates = userPath === null ? projectPaths : [userPath, ...projectPaths]
  if (candidates.length === 0) return undefined

  let merged: Record<string, unknown> = {}
  for (const path of candidates) {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      continue
    }
    const parsed = parseOmoJsonc(raw)
    if (parsed === null) continue
    merged = mergeRecords(merged, canonicalizeLegacyHarnessBlocks(parsed))
  }

  const resolved = resolveNativeConfigView(merged, resolveProfileName(env))
  const task = isPlainObject(resolved.task) ? resolved.task : undefined
  return typeof task?.state_dir === 'string' && task.state_dir.length > 0 ? task.state_dir : undefined
}

// Conservative read-only mirror of OmO's legacy in-project store check:
// adopts <cwd>/.omo/senpi-task when it exists and holds any non-directory or
// dot-named entry, and NEVER writes `.in-project`.
async function subtreeHoldsRecords(dir: string): Promise<boolean> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    return !isMissingError(error)
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.includes('.')) {
      if (await subtreeHoldsRecords(join(dir, entry.name))) return true
    } else {
      return true
    }
  }
  return false
}

async function holdsLegacyRecords(dir: string): Promise<boolean> {
  if (!await pathExists(dir)) return false
  try {
    if (!(await lstat(dir)).isDirectory()) return true
  } catch (error) {
    return !isMissingError(error)
  }
  return subtreeHoldsRecords(dir)
}

export async function resolveOmoTaskStateDir(
  cwd: string,
  options: ResolveStateDirOptions = {},
): Promise<string> {
  const env = options.env ?? process.env
  const accountHomeDir = options.accountHomeDir ?? defaultAccountHomeDir()
  const configured = await resolveConfiguredStateDir(cwd, env, accountHomeDir)
  if (configured !== undefined) return configured

  const inProject = join(resolve(cwd), '.omo', 'senpi-task')
  if (await holdsLegacyRecords(inProject)) return inProject

  const canonical = await realpathOrSelf(resolve(cwd))
  return join(agentDirectory(env), 'projects', projectStateKeyFromAbsolute(canonical), 'senpi-task')
}

type ParsedTask = {
  readonly taskId: string
  readonly parentSessionId: string
  readonly rootSessionId: string
  readonly childSessionId: string | undefined
  readonly active: boolean
}

type CachedTask = {
  readonly ino: number
  readonly mtimeMs: number
  readonly size: number
  readonly task: ParsedTask | null
}

type JsonlFileState = {
  ino: number
  size: number
  offset: number
  carry: Buffer
  lineIndex: number
  state: OmoHistory
}

function parseTaskRecord(raw: unknown): ParsedTask | null {
  if (!isPlainObject(raw)) return null
  if (typeof raw.task_id !== 'string' || !TASK_ID_PATTERN.test(raw.task_id)) return null
  const parentSessionId = typeof raw.parent_session_id === 'string' ? raw.parent_session_id : ''
  const rootSessionId = typeof raw.root_session_id === 'string' ? raw.root_session_id : ''
  const childSessionId = typeof raw.child_session_id === 'string' && raw.child_session_id !== ''
    ? raw.child_session_id : undefined
  const active = typeof raw.status === 'string' && NON_TERMINAL_STATUSES.has(raw.status)
  return { taskId: raw.task_id, parentSessionId, rootSessionId, childSessionId, active }
}

function consumeJsonlLine(file: JsonlFileState, lineBuf: Buffer): void {
  const lineIndex = file.lineIndex++
  const text = lineBuf.toString('utf8').trim()
  if (!text) return
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return
  }
  if (isPlainObject(parsed)) foldOmoEntry(file.state, parsed, `line:${lineIndex}`)
}

// Asynchronous reader for OmO's on-disk `senpi-task` store.
export class OmoSubagents {
  private readonly resolveOptions: ResolveStateDirOptions | undefined
  private cwd = ''
  private sessionId = ''
  private stateDir = ''
  private generation = 0
  private disposed = false
  private current: SubagentSnapshot = EMPTY_SNAPSHOT
  private hasActive = false
  private pending: { generation: number; done: Promise<void> } | null = null
  private timing: { start: number; end: number; duration: number } | null = null
  private readonly taskCache = new Map<string, CachedTask>()
  private readonly fileCache = new Map<string, JsonlFileState>()

  constructor(resolveOptions?: ResolveStateDirOptions) {
    this.resolveOptions = resolveOptions
  }

  get snapshot(): SubagentSnapshot {
    return this.current
  }

  private reset(): void {
    this.stateDir = ''
    this.current = EMPTY_SNAPSHOT
    this.hasActive = false
    this.timing = null
    this.taskCache.clear()
    this.fileCache.clear()
  }

  private isStale(generation: number): boolean {
    return this.disposed || generation !== this.generation
  }

  async refresh(cwd: string, sessionId: string, now = Date.now(), force = false): Promise<SubagentSnapshot> {
    if (this.disposed) return this.current
    if (cwd !== this.cwd || sessionId !== this.sessionId) {
      this.cwd = cwd
      this.sessionId = sessionId
      this.generation++
      this.reset()
    }
    const generation = this.generation
    if (!cwd || !sessionId) return this.current
    if (this.pending) {
      const pending = this.pending
      await pending.done
      if (this.isStale(generation)) return this.current
      if (pending.generation === generation) return this.current
      return this.refresh(cwd, sessionId, now, force)
    }
    if (this.timing) {
      const floor = this.hasActive || force ? ACTIVE_POLL_MS : IDLE_POLL_MS
      const interval = Math.max(floor, HOLD_FACTOR * this.timing.duration)
      if (now >= this.timing.start && now < this.timing.end + interval) return this.current
    }

    const start = Date.now()
    const run = this.scan(generation, cwd, sessionId, now, start)
    this.pending = { generation, done: run }
    try {
      await run
    } finally {
      if (this.pending?.done === run) this.pending = null
    }
    return this.current
  }

  private async scan(generation: number, cwd: string, sessionId: string, now: number, start: number): Promise<void> {
    try {
      const stateDir = await resolveOmoTaskStateDir(cwd, this.resolveOptions)
      if (this.isStale(generation)) return
      if (stateDir !== this.stateDir) {
        this.stateDir = stateDir
        this.taskCache.clear()
        this.fileCache.clear()
      }

      const tasksDir = join(stateDir, 'tasks')
      let names: string[]
      try {
        names = (await readdir(tasksDir)).filter(name => name.endsWith('.json')).sort()
      } catch {
        names = []
      }
      if (this.isStale(generation)) return

      const seenTaskPaths = new Set<string>()
      const validTasks: ParsedTask[] = []
      for (const name of names) {
        const filePath = join(tasksDir, name)
        seenTaskPaths.add(filePath)
        const task = await this.readTaskCached(generation, filePath)
        if (this.isStale(generation)) return
        if (task !== null) validTasks.push(task)
      }
      for (const cachedPath of this.taskCache.keys()) {
        if (!seenTaskPaths.has(cachedPath)) this.taskCache.delete(cachedPath)
      }

      // Fixed-point session tree closure starting from the active session.
      const treeSessions = new Set<string>([sessionId])
      const matched = new Map<string, ParsedTask>()
      let changed = true
      while (changed) {
        changed = false
        for (const task of validTasks) {
          if (matched.has(task.taskId)) continue
          const byParent = task.parentSessionId !== '' && treeSessions.has(task.parentSessionId)
          const byRoot = task.rootSessionId !== '' && treeSessions.has(task.rootSessionId)
          if (!byParent && !byRoot) continue
          matched.set(task.taskId, task)
          changed = true
          if (task.childSessionId !== undefined && !treeSessions.has(task.childSessionId)) {
            treeSessions.add(task.childSessionId)
          }
        }
      }

      const seenJsonlPaths = new Set<string>()
      let tokens = 0
      let tools = 0
      const taskIds = new Set<string>()
      let hasActive = false

      for (const task of matched.values()) {
        taskIds.add(task.taskId)
        if (task.active) hasActive = true
        const sessionsDir = join(stateDir, 'children', task.taskId, 'sessions', task.taskId)
        let jsonlNames: string[]
        try {
          jsonlNames = (await readdir(sessionsDir)).filter(name => name.endsWith('.jsonl')).sort()
        } catch {
          jsonlNames = []
        }
        if (this.isStale(generation)) return
        for (const jsonlName of jsonlNames) {
          const jsonlPath = join(sessionsDir, jsonlName)
          seenJsonlPaths.add(jsonlPath)
          const history = await this.readJsonlIncremental(generation, jsonlPath)
          if (this.isStale(generation)) return
          if (!history) continue
          tokens += history.counts.tokens
          tools += history.counts.tools
          for (const agentId of history.agents) taskIds.add(agentId)
        }
      }

      for (const cachedPath of this.fileCache.keys()) {
        if (!seenJsonlPaths.has(cachedPath)) this.fileCache.delete(cachedPath)
      }

      if (this.isStale(generation)) return
      const duration = Math.max(0, Date.now() - start)
      this.timing = { start: now, end: now + duration, duration }
      this.hasActive = hasActive
      this.current = { tokens, tools, taskIds }
    } catch {
      if (this.isStale(generation)) return
      const duration = Math.max(0, Date.now() - start)
      this.timing = { start: now, end: now + duration, duration }
    }
  }

  private async readTaskCached(generation: number, filePath: string): Promise<ParsedTask | null> {
    let info
    try {
      info = await stat(filePath)
    } catch {
      if (!this.isStale(generation)) this.taskCache.delete(filePath)
      return null
    }
    if (this.isStale(generation)) return null
    if (!info.isFile()) {
      this.taskCache.delete(filePath)
      return null
    }
    const cached = this.taskCache.get(filePath)
    if (cached && cached.ino === info.ino && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      return cached.task
    }
    let handle
    try {
      handle = await open(filePath, 'r')
    } catch {
      if (!this.isStale(generation)) this.taskCache.delete(filePath)
      return null
    }
    try {
      const fdStat = await handle.stat()
      if (this.isStale(generation)) return null
      if (!fdStat.isFile()) {
        this.taskCache.delete(filePath)
        return null
      }
      const raw: unknown = JSON.parse(await handle.readFile('utf8'))
      if (this.isStale(generation)) return null
      const task = parseTaskRecord(raw)
      this.taskCache.set(filePath, { ino: fdStat.ino, mtimeMs: fdStat.mtimeMs, size: fdStat.size, task })
      return task
    } catch {
      if (!this.isStale(generation)) this.taskCache.delete(filePath)
      return null
    } finally {
      await handle.close().catch(() => {})
    }
  }

  private async readJsonlIncremental(generation: number, filePath: string): Promise<OmoHistory | null> {
    let info
    try {
      info = await stat(filePath)
    } catch {
      if (!this.isStale(generation)) this.fileCache.delete(filePath)
      return null
    }
    if (this.isStale(generation)) return null
    if (!info.isFile()) {
      this.fileCache.delete(filePath)
      return null
    }
    const existing = this.fileCache.get(filePath)
    if (existing && existing.ino === info.ino && existing.size === info.size) {
      return existing.state
    }

    let handle
    try {
      handle = await open(filePath, 'r')
    } catch {
      if (!this.isStale(generation)) this.fileCache.delete(filePath)
      return null
    }
    try {
      const fdStat = await handle.stat()
      if (this.isStale(generation)) return null
      if (!fdStat.isFile()) {
        this.fileCache.delete(filePath)
        return null
      }
      const entry: JsonlFileState = existing && existing.ino === fdStat.ino && fdStat.size >= existing.offset
        ? existing
        : { ino: fdStat.ino, size: 0, offset: 0, carry: Buffer.alloc(0), lineIndex: 0, state: createOmoHistory() }

      const buf = Buffer.allocUnsafe(CHUNK_BYTES)
      for (;;) {
        const { bytesRead } = await handle.read(buf, 0, buf.length, entry.offset)
        if (this.isStale(generation)) return null
        if (bytesRead === 0) break
        entry.offset += bytesRead
        const chunk = buf.subarray(0, bytesRead)
        const combined = entry.carry.length > 0 ? Buffer.concat([entry.carry, chunk]) : chunk
        let lineStart = 0
        for (let i = 0; i < combined.length; i++) {
          if (combined[i] !== 0x0a) continue
          consumeJsonlLine(entry, combined.subarray(lineStart, i))
          lineStart = i + 1
        }
        entry.carry = lineStart < combined.length ? Buffer.from(combined.subarray(lineStart)) : Buffer.alloc(0)
      }
      entry.size = entry.offset
      this.fileCache.set(filePath, entry)
      return entry.state
    } catch {
      if (!this.isStale(generation)) this.fileCache.delete(filePath)
      return null
    } finally {
      await handle.close().catch(() => {})
    }
  }

  dispose(): void {
    this.disposed = true
    this.generation++
    this.reset()
  }
}
