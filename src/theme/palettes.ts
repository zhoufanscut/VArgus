import type { TokenName } from '../core/types.ts'

export type PalettePolarity = 'dark' | 'light'

// Bundled palettes use one 3-group data-first OKLCH structure, 9 hex tokens each:
//   - 5-step data-first tonal ramp (`text > calm > label > detail > sep`) in one theme hue family:
//       text    location anchors (bold folder; plain repo and branch/ref names)
//       calm    under-threshold readings (effort at/above default, <80% context/limits,
//               <4M tokens by default or <1M with includeSubagents: false, <12h session)
//       label   `xxx:` prefixes, model name, detached `@`, call counts and stale marker (carries signature theme colour)
//       detail  secondary parentheticals (`(carbon)`, `(fast)`, reset times, cache/speed, `(wt:x)`)
//       sep     the ` | ` separator (including before the stale marker)
//   - 1 vivid alarm (`alert`, highest chroma, >=2x `del` and >=1.5x `label` chroma):
//       alert   over-threshold/error states (low effort, >=80% context/limits, >=4M
//               tokens by default or >=1M with includeSubagents: false, >=12h session, `[API 429]`/`[API AUTH]`/`[API ERR]`, git in-progress ops)
//   - 3 balanced muted VCS tokens (between `label` and `detail`):
//       add / del / track   git/svn: staged (svn: added) and ahead / conflicts, modified and behind / untracked
export const PALETTES: Record<string, Record<TokenName, string>> = {
  // cobalt-indigo dark (Antigravity / Tokyo Night family)
  'agy-tokyonight': {
    text: '#e2e8f6', label: '#8babee', detail: '#8890b3', sep: '#474b5b',
    calm: '#c2cbf3', alert: '#f7768e',
    add: '#94af7b', del: '#c78c94', track: '#67aebd',
  },
  // Cool grays and blue labels inspired by the Codex conversation UI.
  'codex-ink': {
    text: '#eceff2', label: '#74a8e6', detail: '#8e949c', sep: '#45484b',
    calm: '#c9d0d9', alert: '#ff7976',
    add: '#7ea989', del: '#c38d8a', track: '#a294c1',
  },
  // warm terracotta/parchment dark (Claude Code / Anthropic family)
  'claude-terracotta': {
    text: '#fcf1ea', label: '#dd947d', detail: '#a38b7e', sep: '#4c3f3a',
    calm: '#e6c8b9', alert: '#ff6b80',
    add: '#85ac89', del: '#c08b8c', track: '#81a4c7',
  },
  // soft violet dark (OmO / Senpi dark theme family)
  'omo-violet': {
    text: '#ebeaf3', label: '#ac9be0', detail: '#908c9d', sep: '#48464e',
    calm: '#cfcae3', alert: '#ff7d80',
    add: '#79a88d', del: '#c18c8b', track: '#78a1c1',
  },
  // pure neutral-gray dark, lowest VCS chroma. Fallback for unknown names.
  graphite: {
    text: '#ededed', label: '#aeaeae', detail: '#929292', sep: '#4a4a4a',
    calm: '#d1d1d1', alert: '#f47e7c',
    add: '#8aaa8b', del: '#bc908e', track: '#86a1c0',
  },
  // crisp cobalt-slate ink on light background (GitHub light family)
  daylight: {
    text: '#181d24', label: '#20548a', detail: '#5b6e81', sep: '#c3c8ce',
    calm: '#253a4e', alert: '#bb1423',
    add: '#3f764c', del: '#945451', track: '#676099',
  },
}

export const PALETTE_POLARITY: Record<string, PalettePolarity> = {
  'agy-tokyonight': 'dark',
  'codex-ink': 'dark',
  'claude-terracotta': 'dark',
  'omo-violet': 'dark',
  graphite: 'dark',
  daylight: 'light',
}
