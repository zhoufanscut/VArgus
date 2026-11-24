import type { TokenName } from '../core/types.ts'

// Five bundled palettes using one 3-group data-first OKLCH structure, 9 hex tokens each:
//   - 5-step data-first tonal ramp (`text > calm > label > detail > sep`) in one theme hue family:
//       text    location anchors (bold folder; plain repo and branch/ref names)
//       calm    under-threshold readings (effort at/above default, <80% context/limits,
//               <1M tokens or <4M with includeSubagents, <12h session)
//       label   `xxx:` prefixes, model name, detached `@`, call counts and stale marker (carries signature theme colour)
//       detail  secondary parentheticals (`(carbon)`, `(fast)`, reset times, cache/speed, `(wt:x)`)
//       sep     the ` | ` separator (including before the stale marker)
//   - 1 vivid alarm (`alert`, highest chroma, >=2x `del` and >=1.5x `label` chroma):
//       alert   over-threshold/error states (low effort, >=80% context/limits, >=1M
//               tokens or >=4M with includeSubagents, >=12h session, `[API 429]`/`[API AUTH]`/`[API ERR]`, git in-progress ops)
//   - 3 balanced muted VCS tokens (between `label` and `detail`):
//       add / del / track   git/svn: staged (svn: added) and ahead / conflicts, modified and behind / untracked
export const PALETTES: Record<string, Record<TokenName, string>> = {
  // cool Arctic cyan dark (Nord / Tokyo Night family)
  aurora: {
    text: '#dfeaef', label: '#69b8d0', detail: '#7898a7', sep: '#434f57',
    calm: '#add6e0', alert: '#f6808d',
    add: '#82b291', del: '#c59094', track: '#78aac9',
  },
  // warm amber/parchment dark (Gruvbox family)
  ember: {
    text: '#eee7db', label: '#d3a067', detail: '#a58d78', sep: '#544b44',
    calm: '#e1caa6', alert: '#fe7768',
    add: '#93ad78', del: '#c78c83', track: '#72a9c2',
  },
  // soft lavender-mauve dark (Catppuccin Mocha family)
  nebula: {
    text: '#e6e7f2', label: '#b2a2e4', detail: '#8c90ae', sep: '#4a4c59',
    calm: '#cacaeb', alert: '#f87f99',
    add: '#86b689', del: '#c99099', track: '#85a6d7',
  },
  // pure neutral-gray dark, lowest VCS chroma. VArgus's default.
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
