import type { TokenName } from '../core/types'

// VantageHUD 0.6.0's five bundled palettes (src/hud/themes.js), 10 hex tokens
// each. What each token paints:
//   text      the folder
//   label     every `xxx:` prefix and the call-count numbers
//   faint     the quietest tone (parentheticals, the stale `*`)
//   sep       the ` | ` separator
//   gradLow   calm tier (< 70 %), and the value tone of token:/repo:/branch:,
//             and the calm (max) end of the effort colours
//   gradMid   watch tier (70-84 %)
//   gradHigh  alert tier (>= 85 %), and effort `low`
//   add / del / track   git: staged and ahead / modified and behind / untracked
export const PALETTES: Record<string, Record<TokenName, string>> = {
  // cool slate with cyan-teal accents (Nord / Tokyo Night family)
  aurora: {
    text: '#c8d3e8', label: '#8fd0d8', faint: '#6e7896', sep: '#48506a',
    gradLow: '#72d3c3', gradMid: '#e6c38d', gradHigh: '#e0909e',
    add: '#8fd0b8', del: '#e0909e', track: '#8dc2d6',
  },
  // warm dark (Gruvbox family)
  ember: {
    text: '#ebdbb2', label: '#a89984', faint: '#928374', sep: '#665c54',
    gradLow: '#969619', gradMid: '#f1bf3c', gradHigh: '#fb4934',
    add: '#969619', del: '#fb4934', track: '#fe8019',
  },
  // vivid dark with mauve accents (Catppuccin Mocha family)
  nebula: {
    text: '#cdd6f4', label: '#cba6f7', faint: '#6c7086', sep: '#45475a',
    gradLow: '#94e2d5', gradMid: '#f9e2af', gradHigh: '#f38ba8',
    add: '#a6e3a1', del: '#f38ba8', track: '#89b4fa',
  },
  // near-monochrome dark: only the usage tiers carry hue. VArgus's default.
  graphite: {
    text: '#e6e6e6', label: '#9e9e9e', faint: '#7d7d7d', sep: '#3f3f3f',
    gradLow: '#b0b0b0', gradMid: '#b8964f', gradHigh: '#cd6a6a',
    add: '#8fa88f', del: '#b08f8f', track: '#8f9db0',
  },
  // the one palette for a light background (GitHub light family)
  daylight: {
    text: '#24292f', label: '#0550ae', faint: '#6e7781', sep: '#d0d7de',
    gradLow: '#0a7c5a', gradMid: '#966d00', gradHigh: '#cf222e',
    add: '#116329', del: '#cf222e', track: '#8250df',
  },
}
