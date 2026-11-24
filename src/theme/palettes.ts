import type { TokenName } from '../core/types.ts'

// Five bundled palettes derived from VantageHUD 0.6.0 (src/hud/themes.js), 9
// hex tokens each (two tiers: calm and alert). What each token paints:
//   text      location anchors (bold folder; plain repo and branch/ref names)
//   label     `xxx:` prefixes, model name, detached `@`, call counts and stale text
//   faint     secondary parentheticals (`(fast)`, reset times, cache/speed, `(wt:x)`)
//   sep       the ` | ` separator (including before the stale marker)
//   calm      under-threshold readings (effort at/above default, <80% context/limits,
//             <1M tokens or <4M with includeSubagents, <12h session)
//   alert     over-threshold/error states (low effort, >=80% context/limits, >=1M
//             tokens or >=4M with includeSubagents, >=12h session, `[API 429]`/`[API auth]`/`[API err]`, git in-progress ops)
//   add / del / track   git/svn: staged and ahead / conflicts, modified and behind / untracked
export const PALETTES: Record<string, Record<TokenName, string>> = {
  // cool slate with cyan-teal accents (Nord / Tokyo Night family)
  aurora: {
    text: '#c8d3e8', label: '#8fd0d8', faint: '#6e7896', sep: '#48506a',
    calm: '#72d3c3', alert: '#e0909e',
    add: '#8fd0b8', del: '#e0909e', track: '#8dc2d6',
  },
  // warm dark (Gruvbox family)
  ember: {
    text: '#ebdbb2', label: '#a89984', faint: '#928374', sep: '#665c54',
    calm: '#969619', alert: '#fb4934',
    add: '#969619', del: '#fb4934', track: '#fe8019',
  },
  // vivid dark with mauve accents (Catppuccin Mocha family)
  nebula: {
    text: '#cdd6f4', label: '#cba6f7', faint: '#6c7086', sep: '#45475a',
    calm: '#94e2d5', alert: '#f38ba8',
    add: '#a6e3a1', del: '#f38ba8', track: '#89b4fa',
  },
  // near-monochrome dark: only alert and VCS counts carry hue. VArgus's default.
  graphite: {
    text: '#e6e6e6', label: '#9e9e9e', faint: '#7d7d7d', sep: '#3f3f3f',
    calm: '#b0b0b0', alert: '#cd6a6a',
    add: '#8fa88f', del: '#b08f8f', track: '#8f9db0',
  },
  // the one palette for a light background (GitHub light family)
  daylight: {
    text: '#24292f', label: '#0550ae', faint: '#6e7781', sep: '#d0d7de',
    calm: '#0a7c5a', alert: '#cf222e',
    add: '#116329', del: '#cf222e', track: '#8250df',
  },
}
