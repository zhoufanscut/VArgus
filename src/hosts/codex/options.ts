import { mergeOptionLayers, resolveOptions } from '../../options.ts'

export const CODEX_THEME = 'codex-ink'

export function resolveCodexOptions(given: Record<string, unknown>) {
  return {
    ...resolveOptions(given),
    codexAutoStart: given.codexAutoStart !== false,
  }
}

export type CodexOptions = ReturnType<typeof resolveCodexOptions>

export type SavedOptions = { options: Record<string, unknown>; overrideKeys?: string[] }

// Older helpers saved only a complete snapshot. Preserve it until a fresh activation.
export function workerOptions(checkout: Record<string, unknown>, given: Record<string, unknown>, saved?: SavedOptions): SavedOptions {
  let overrides: Record<string, unknown> = {}
  if (saved) {
    for (const key of saved.overrideKeys ?? Object.keys(saved.options)) overrides[key] = saved.options[key]
  }
  overrides = mergeOptionLayers(overrides, given)
  const options = resolveCodexOptions(mergeOptionLayers(checkout, overrides))
  const keys = new Set([...Object.keys(options), 'customTheme'])
  return { options, overrideKeys: [...keys].filter(key => Object.hasOwn(overrides, key)) }
}
