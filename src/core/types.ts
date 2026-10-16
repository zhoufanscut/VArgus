import type { Labels } from '../i18n'
import type { Options } from '../options'
import type { SessionValues } from '../collect/session'
import type { LimitsValues } from '../collect/limits'
import type { VcsValues } from '../collect/vcs'

// The shared contract between collectors, fragments and the composer
// (DESIGN, "How it works"). Each area owns its own values type.

export type Rgb = readonly [number, number, number]

export type TokenName =
  | 'text' | 'label' | 'faint' | 'sep' | 'gradLow' | 'gradMid' | 'gradHigh' | 'add' | 'del' | 'track'

// A resolved palette and the only way colour codes enter the line
// (DESIGN, "Colours"): with NO_COLOR every call returns its text unchanged.
export type Theme = {
  name: string
  // NO_COLOR: the detail view then gives its elements no colour either
  noColor: boolean
  rgb: Record<TokenName, Rgb>
  paint: (color: TokenName | Rgb, text: string) => string
  bold: (text: string) => string
  // the three-stop gauge colour for a percent; bounds default to [70, 85]
  gradient: (percent: number, bounds?: readonly [number, number]) => Rgb
  lerp: (a: Rgb, b: Rgb, t: number) => Rgb
}

export type CoreValues = {
  cwd: string
  home: string | undefined
  // the row's width from the PromptHint viewport; undefined until it arrives
  columns: number | undefined
  // WSL: call counts as text (DESIGN, "Config")
  isWsl: boolean
}

export type Values = {
  core: CoreValues
  session: SessionValues
  limits: LimitsValues
  vcs: VcsValues
}

export type FragmentInput = {
  v: Values
  o: Options
  l: Labels
  t: Theme
  // $.clock.now() at this render, in ms
  now: number
}

// Pure: returns the fragment's text, or null to leave it out. Outside text
// goes through cleanText before colour codes go on.
export type Fragment = (f: FragmentInput) => string | null
