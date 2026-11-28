import type { Rgb, Theme, TokenName } from '../core/types.ts'
import { PALETTES, PALETTE_POLARITY, type PalettePolarity } from './palettes.ts'

// Palettes, resolvePalette and the ANSI codes (DESIGN, "Colours", "Rules
// carried over from VantageHUD", Themes). 24-bit SGR only: no 256/16-colour
// conversion, a terminal without truecolor is left to tmux or the terminal.

export const DEFAULT_THEME = 'graphite'

const ESC = '\x1b['
const RESET = `${ESC}0m`

// A null prototype and own-property lookups, so a name such as `constructor`
// or `toString` finds nothing and falls back (VantageHUD's registry rule).
const registry: Record<string, Record<TokenName, string>> = Object.assign(Object.create(null), PALETTES)
const polarities: Record<string, PalettePolarity> = Object.assign(Object.create(null), PALETTE_POLARITY)

function hexToRgb(hex: string): Rgb {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
}

// Names match case- and whitespace-insensitively (internal whitespace maps to
// hyphens, so "agy tokyonight" resolves to "agy-tokyonight").
export function lookupPaletteName(name: string): string | undefined {
  const key = name.trim().toLowerCase().replace(/\s+/g, '-')
  return Object.prototype.hasOwnProperty.call(registry, key) ? key : undefined
}

// An unknown name gives the default palette.
export function resolvePalette(name: string): { name: string; polarity: PalettePolarity; rgb: Record<TokenName, Rgb> } {
  const found = lookupPaletteName(name) ?? DEFAULT_THEME
  const hex = registry[found]!
  const rgb = Object.fromEntries(Object.entries(hex).map(([k, v]) => [k, hexToRgb(v)])) as Record<TokenName, Rgb>
  return { name: found, polarity: polarities[found]!, rgb }
}

export function makeTheme(name: string, noColor: boolean): Theme {
  const palette = resolvePalette(name)
  const rgb = palette.rgb
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
  }
}
