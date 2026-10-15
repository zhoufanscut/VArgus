import type { Fragment } from '../../core/types'

// 6. tokens: `token:69.5k`, the session's input + output tokens
// (src/collect/session.ts says what counts) (DESIGN, "Fragments"; VantageHUD's
// elements/token-usage.js). Hidden while nothing is counted.

// Raw under 1k, one decimal of k under 1M, two decimals of M beyond. The k/M
// switch is at 999,950, where one decimal of k would round to `1000.0k`
// (VantageHUD's formatTokenCount).
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return `${tokens}`
  if (tokens < 999950) return `${(tokens / 1000).toFixed(1)}k`
  return `${(tokens / 1000000).toFixed(2)}M`
}

export const tokens: Fragment = ({ v, l, t }) => {
  const total = v.session.counts.tokens
  if (!(total > 0)) return null
  return t.paint('label', `${l.tokens}:`) + t.paint('gradLow', formatTokenCount(total))
}
