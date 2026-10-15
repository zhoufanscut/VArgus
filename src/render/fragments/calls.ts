import type { Fragment } from '../../core/types'

// 8. call counts: `🔧73 🤖2 ⚡1`, with workflow runs `🔧73 🤖2 🔀1 ⚡1` when that
// option is on; as text (`T:73 A:2 W:1 S:1`) on WSL, whose terminals may draw
// emoji wrong and break the row (DESIGN, "Config"; VantageHUD's
// elements/call-counts.js, oh-my-claudecode#710). A zero count is left out;
// all zero: hidden. The emoji are the same in every language; the text marks
// are labels. Numbers in the label tone, so they recede.
const ICONS = { tool: '🔧', agent: '🤖', workflow: '🔀', skill: '⚡' } as const

export const calls: Fragment = ({ v, o, l, t }) => {
  const c = v.session.counts
  const text = v.core.isWsl
  const items: [keyof typeof ICONS, number][] = [
    ['tool', c.tools],
    ['agent', c.agents],
    ['workflow', o.workflowRuns ? c.workflows : 0],
    ['skill', c.skills],
  ]
  const parts = items
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => (text ? `${l[kind]}:` : ICONS[kind]) + t.paint('label', String(n)))
  return parts.length ? parts.join(' ') : null
}
