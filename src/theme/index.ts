import type { Rgb, Theme, TokenName } from '../core/types'
import { PALETTES } from './palettes'

// Palettes, resolvePalette and the ANSI codes (DESIGN, "Colours", "Rules
// carried over from VantageHUD", Themes). 24-bit SGR only: no 256/16-colour
// conversion, a terminal without truecolor is left to tmux or the terminal.

export const DEFAULT_THEME = 'graphite'

const ESC = '\x1b['
const RESET = `${ESC}0m`

// A null prototype and own-property lookups, so a name such as `constructor`
// or `toString` finds nothing and falls back (VantageHUD's registry rule).
const registry: Record<string, Record<TokenName, string>> = Object.assign(Object.create(null), PALETTES)

function hexToRgb(hex: string): Rgb {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
}

// Names match case- and space-insensitively, as VantageHUD's did; an unknown
// name gives the default palette.
export function resolvePalette(name: string): { name: string; rgb: Record<TokenName, Rgb> } {
  const key = name.trim().toLowerCase()
  const found = Object.prototype.hasOwnProperty.call(registry, key) ? key : DEFAULT_THEME
  const hex = registry[found]!
  const rgb = Object.fromEntries(Object.entries(hex).map(([k, v]) => [k, hexToRgb(v)])) as Record<TokenName, Rgb>
  return { name: found, rgb }
}

// RGB lerp, t clamped to 0..1 and each channel rounded (VantageHUD's lerpRgb):
// the palettes' stops are close in luminance, so plain RGB stays smooth.
export function lerp(a: Rgb, b: Rgb, t: number): Rgb {
  const k = Math.min(1, Math.max(0, t))
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ]
}

export function makeTheme(name: string, noColor: boolean): Theme {
  const palette = resolvePalette(name)
  const rgb = palette.rgb
  const stops = [rgb.gradLow, rgb.gradMid, rgb.gradHigh] as const
  return {
    name: palette.name,
    rgb,
    // NO_COLOR: the text unchanged, no escape at all (no-color.org).
    paint: (color, text) => {
      if (noColor) return text
      const [r, g, b] = typeof color === 'string' ? rgb[color] : color
      return `${ESC}38;2;${r};${g};${b}m${text}${RESET}`
    },
    // 22 ends bold alone, so a bold run never cuts a colour around it.
    bold: text => (noColor ? text : `${ESC}1m${text}${ESC}22m`),
    // Three flat tiers, not a ramp: calm below bounds[0], watch to bounds[1],
    // alert from bounds[1] (VantageHUD's gradientColor: a fixed hue reads as
    // a state faster than a position on a ramp). Percent clamped to 0..100.
    gradient: (percent, bounds = [70, 85]) => {
      const p = Math.min(100, Math.max(0, percent))
      let tier = 0
      while (tier < bounds.length && p >= bounds[tier]!) tier++
      // more bounds than two (outside the type) still give the alert tier
      return stops[Math.min(tier, stops.length - 1)]!
    },
    lerp,
  }
}
