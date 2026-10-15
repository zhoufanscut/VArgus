import type { PluginOptions } from 'claude-code'

// 0.1.0's options (DESIGN, "Config"): one boolean per fragment and sub-option,
// and the theme. Keys and defaults match `userConfig` in plugin.json.
export const DEFAULTS = {
  folder: true,
  model: true,
  effort: true,
  rateLimits: true,
  spendLimit: false,
  otherModelWeekly: false,
  context: true,
  tokens: true,
  session: true,
  callCounts: true,
  workflowRuns: false,
  repo: true,
  branch: true,
  detachedHead: false,
  status: true,
  theme: 'graphite',
}

export type Options = typeof DEFAULTS

// The engine fills in defaults and drops values outside a picker's options;
// this keeps the code's defaults for anything missing or of the wrong type.
export function resolveOptions(given: PluginOptions): Options {
  const out: Record<string, unknown> = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS) as (keyof Options)[]) {
    const value = given[key]
    if (typeof value === typeof DEFAULTS[key]) out[key] = value
  }
  return out as Options
}
