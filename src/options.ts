import { parseCustomTheme, type CustomTheme } from './theme/index.ts'

// Shared and Claude options (DESIGN, "Config"). Keys and defaults match
// `userConfig` in plugin.json.
export const DEFAULTS = {
  folder: true,
  folderFoldThreshold: 24,
  model: true,
  effort: true,
  context: true,
  tokens: true,
  session: true,
  callCounts: true,
  includeSubagents: true,
  rateLimits: true,
  repo: true,
  branch: true,
  status: true,
  theme: 'auto',
}

export type PickerOptionKey = keyof typeof DEFAULTS
export type Options = typeof DEFAULTS & { customTheme?: CustomTheme }

function uncomment(text: string): string {
  // Match whole strings first so comment markers inside a value survive.
  return text.replace(/^\uFEFF|"(?:\\[\s\S]|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|\/\*/g, token => {
    if (token[0] === '"') return token
    if (token === '/*') throw new SyntaxError('Unterminated block comment.')
    return token.replace(/[^\r\n]/g, ' ')
  })
}

function parseObject(json: string): Record<string, unknown> {
  const value: unknown = JSON.parse(json)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('VArgus config must be a JSON object.')
  }
  return value as Record<string, unknown>
}

export function parseOptions(text: string): Record<string, unknown> {
  return parseObject(uncomment(text))
}

// Change just the effective top-level value. Keep comments, indentation, unknown
// fields, and any earlier duplicate key as the user wrote them.
export function editOption(text: string, key: PickerOptionKey, value: (typeof DEFAULTS)[PickerOptionKey]): string {
  const json = uncomment(text)
  const current = parseObject(json)
  if (current[key] === value) return text
  const replacement = JSON.stringify(value)
  const tokens = [...json.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}[\],:]|[^\s{}[\],:"]+/g)]
  let start = 0, end = 0
  for (let i = 1; i < tokens.length - 1;) {
    const name: string = JSON.parse(tokens[i]![0])
    i += 2  // skip the key and colon in this validated object
    const first = tokens[i]!.index
    let depth = 0
    do {
      const token = tokens[i++]![0]
      if (token === '{' || token === '[') depth++
      if (token === '}' || token === ']') depth--
    } while (depth)
    if (name === key) {
      start = first
      end = tokens[i - 1]!.index + tokens[i - 1]![0].length
    }
    i++  // comma or closing brace
  }
  if (end) return text.slice(0, start) + replacement + text.slice(end)
  const afterOpen = tokens[0]!.index + 1
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const rest = text.slice(afterOpen)
  const separator = tokens.length > 2 ? ',' : ''
  const indent = text.match(/\r?\n([ \t]+)"/)?.[1] ?? '  '
  const line = indent + JSON.stringify(key) + ': ' + replacement + separator
  return text.slice(0, afterOpen) + eol + line + (/^[ \t]*[\r\n]/.test(rest) ? '' : eol) + rest
}

export function validOption(key: PickerOptionKey, value: unknown): value is (typeof DEFAULTS)[PickerOptionKey] {
  if (key === 'folderFoldThreshold') return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
  return typeof value === typeof DEFAULTS[key]
}

// Merge option layers from lowest to highest precedence; an explicit higher-layer
// `theme` overrides a lower-layer `customTheme` unless that layer also sets `customTheme`.
export function mergeOptionLayers(...layers: readonly Record<string, unknown>[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const layer of layers) {
    Object.assign(out, layer)
    if (Object.hasOwn(layer, 'theme') && validOption('theme', layer.theme) && !Object.hasOwn(layer, 'customTheme')) {
      delete out.customTheme
    }
  }
  return out
}

// The engine fills in defaults and drops values outside a picker's options;
// this keeps the code's defaults for anything missing or of the wrong type.
export function resolveOptions(given: Record<string, unknown>): Options {
  const out: Record<string, unknown> = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS) as PickerOptionKey[]) {
    const value = given[key]
    if (validOption(key, value)) out[key] = value
  }
  const customTheme = parseCustomTheme(given.customTheme)
  if (customTheme) out.customTheme = customTheme
  return out as Options
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (!isPlainObject(a) || !isPlainObject(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameValue(a[key], b[key]))
}

export function sameOptions<T extends Record<string, unknown>>(a: T, b: T): boolean {
  return sameValue(a, b)
}
