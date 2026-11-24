import type { TokenName } from '../core/types.ts'

// Five bundled palettes using one 3-group OKLCH structure, 9 hex tokens each:
//   - 5-step tonal ramp (`text > label > calm > faint > sep`) in one base undertone:
//       text   location anchors (bold folder; plain repo and branch/ref names)
//       label  `xxx:` prefixes, model name, detached `@`, call counts and stale text
//       calm   under-threshold readings (effort at/above default, <80% context/limits,
//              <1M tokens or <4M with includeSubagents, <12h session)
//       faint  secondary parentheticals (`(carbon)`, `(fast)`, reset times, cache/speed, `(wt:x)`)
//       sep    the ` | ` separator (including before the stale marker)
//   - 1 vivid alarm (`alert`, highest chroma, >=2x `del` chroma):
//       alert  over-threshold/error states (low effort, >=80% context/limits, >=1M
//              tokens or >=4M with includeSubagents, >=12h session, `[API 429]`/`[API AUTH]`/`[API ERR]`, git in-progress ops)
//   - 3 balanced muted VCS tokens:
//       add / del / track   git/svn: staged (svn: added) and ahead / conflicts, modified and behind / untracked
export const PALETTES: Record<string, Record<TokenName, string>> = {
  // cool cyan-slate dark (Nord / Tokyo Night family)
  aurora: {
    text: '#d3e2ed', label: '#adc1cd', faint: '#6e7c89', sep: '#444e59',
    calm: '#90a1ad', alert: '#f6808d',
    add: '#82b291', del: '#c59094', track: '#78aac9',
  },
  // warm stone/parchment dark (Gruvbox family)
  ember: {
    text: '#eadfc5', label: '#c8baa6', faint: '#84786d', sep: '#544b44',
    calm: '#a89a8a', alert: '#fe7768',
    add: '#93ad78', del: '#c78c83', track: '#72a9c2',
  },
  // cool mauve-slate dark (Catppuccin Mocha family)
  nebula: {
    text: '#dcdef4', label: '#bfb9d7', faint: '#76798c', sep: '#494c5b',
    calm: '#9c9cb4', alert: '#f87f99',
    add: '#86b689', del: '#c99099', track: '#85a6d7',
  },
  // pure neutral-gray dark, lowest VCS chroma. VArgus's default.
  graphite: {
    text: '#e6e6e6', label: '#bfbfbf', faint: '#7a7a7a', sep: '#4a4a4a',
    calm: '#9e9e9e', alert: '#f47e7c',
    add: '#8aaa8b', del: '#bc908e', track: '#86a1c0',
  },
  // cool slate-ink on light background (GitHub light family)
  daylight: {
    text: '#22272d', label: '#3d4650', faint: '#7c848d', sep: '#c3c8ce',
    calm: '#5c646d', alert: '#bb1423',
    add: '#3f764c', del: '#945451', track: '#676099',
  },
}
