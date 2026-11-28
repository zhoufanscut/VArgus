import type { Rgb, Theme, TokenName } from '../core/types.ts'
import { PALETTES, PALETTE_POLARITY, TOKEN_NAMES, type PalettePolarity } from './palettes.ts'

// Palettes, resolvePalette and the ANSI codes (DESIGN, "Colours", "Rules
// carried over from VantageHUD", Themes). 24-bit SGR only: no 256/16-colour
// conversion, a terminal without truecolor is left to tmux or the terminal.

export const AUTO_THEME = 'auto'
export const FALLBACK_THEME = 'graphite'
export const CUSTOM_THEME = 'custom'

export type CustomTheme = { polarity?: PalettePolarity } & Partial<Record<TokenName, string>>

const ESC = '\x1b['
const RESET = `${ESC}0m`
const HEX_COLOR = /^#[0-9a-f]{6}$/i

// A null prototype and own-property lookups, so a name such as `constructor`
// or `toString` finds nothing and falls back (VantageHUD's registry rule).
const registry: Record<string, Record<TokenName, string>> = Object.assign(Object.create(null), PALETTES)
const polarities: Record<string, PalettePolarity> = Object.assign(Object.create(null), PALETTE_POLARITY)

function hexToRgb(hex: string): Rgb {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
}

export function parseCustomTheme(value: unknown): CustomTheme | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const out: CustomTheme = {}
  if (Object.hasOwn(raw, 'polarity') && typeof raw.polarity === 'string') {
    const polarity = raw.polarity.trim().toLowerCase()
    if (polarity === 'dark' || polarity === 'light') out.polarity = polarity
  }
  let hasColor = false
  for (const token of TOKEN_NAMES) {
    if (!Object.hasOwn(raw, token)) continue
    const color = raw[token]
    if (typeof color !== 'string') continue
    const hex = color.trim()
    if (HEX_COLOR.test(hex)) {
      out[token] = hex.toLowerCase()
      hasColor = true
    }
  }
  return hasColor ? out : undefined
}

export function sameCustomTheme(a: CustomTheme | undefined, b: CustomTheme | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.polarity === b.polarity && TOKEN_NAMES.every(token => a[token] === b[token])
}

function normalizeThemeKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-')
}

// Names match case- and whitespace-insensitively (internal whitespace maps to
// hyphens, so "agy tokyonight" resolves to "agy-tokyonight").
export function lookupPaletteName(name: string): string | undefined {
  const key = normalizeThemeKey(name)
  return Object.prototype.hasOwnProperty.call(registry, key) ? key : undefined
}

// Canonicalizes a theme option (`auto`, a bundled palette, or `graphite` fallback).
export function resolveThemeOption(name: string): string {
  const key = normalizeThemeKey(name)
  if (key === AUTO_THEME) return AUTO_THEME
  return Object.prototype.hasOwnProperty.call(registry, key) ? key : FALLBACK_THEME
}

// `auto` resolves to `autoTheme` when given and valid; unknown names fall back to graphite.
export function resolvePalette(name: string, autoTheme?: string, custom?: CustomTheme): { name: string; polarity: PalettePolarity; rgb: Record<TokenName, Rgb> } {
  const override = custom ? parseCustomTheme(custom) : undefined
  const key = normalizeThemeKey(name)
  const found = key === AUTO_THEME
    ? ((autoTheme ? lookupPaletteName(autoTheme) : undefined) ?? FALLBACK_THEME)
    : (Object.prototype.hasOwnProperty.call(registry, key) ? key : FALLBACK_THEME)
  const hex = registry[found]!
  const rgb = Object.fromEntries(
    Object.entries(hex).map(([k, v]) => [k, hexToRgb(override?.[k as TokenName] ?? v)]),
  ) as Record<TokenName, Rgb>
  return { name: override ? CUSTOM_THEME : found, polarity: override?.polarity ?? polarities[found]!, rgb }
}

export function makeTheme(name: string, noColor: boolean, autoTheme?: string, custom?: CustomTheme): Theme {
  const palette = resolvePalette(name, autoTheme, custom)
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
