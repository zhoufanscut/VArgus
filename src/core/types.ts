import type { Labels } from '../i18n/index.ts'
import type { Options } from '../options.ts'
import type { Counts, SessionValues } from './session.ts'
import type { QuotaReading } from './limits.ts'
import type { VcsValues } from './vcs.ts'

// The shared contract between collectors, fragments and the composer
// (DESIGN, "How it works"). Each area owns its own values type.

export type Rgb = readonly [number, number, number]

export type TokenName =
  | 'text' | 'label' | 'faint' | 'sep' | 'calm' | 'alert' | 'add' | 'del' | 'track'

// A resolved palette and the only way colour codes enter the line
// (DESIGN, "Colours"): with NO_COLOR every call returns its text unchanged.
export type Theme = {
  name: string
  rgb: Record<TokenName, Rgb>
  paint: (color: TokenName | Rgb, text: string) => string
  bold: (text: string) => string
}

export type CoreValues = {
  cwd: string
  home: string | undefined
  // the row's width from the PromptHint viewport; undefined until it arrives
  columns: number | undefined
  // WSL: call counts and stale marker as text (DESIGN, "Config")
  isWsl: boolean
}

export type Values = {
  core: CoreValues
  session: SessionValues
  limits: QuotaReading[]
  vcs: VcsValues
}

export type SessionDisplay = {
  modelName: string | null
  speed: 'fast' | 'ultrafast' | undefined
  contextPercent: number
  counts: Counts
}

export type FragmentInput = {
  v: Values
  display: SessionDisplay
  o: Options
  l: Labels
  t: Theme
  // $.clock.now() at this render, in ms
  now: number
}

// Pure: returns the fragment's text, or null to leave it out. Outside text
// goes through cleanText before colour codes go on.
export type Fragment = (f: FragmentInput) => string | null
