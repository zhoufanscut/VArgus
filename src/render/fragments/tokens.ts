import type { Fragment } from '../../core/types.ts'

// Session token total with the latest request's cache-hit percentage and
// output decode speed when known. Hidden while nothing is counted
// (DESIGN, "Fragments").

// Raw under 1k, one decimal of k under 1M, two decimals of M beyond. The k/M
// switch (and default `includeSubagents: false` calm -> alert flip) is at
// 999,950, where one decimal of k would round to `1000.0k` and switches to
// `1.00M` (VantageHUD's formatTokenCount).
const MILLION_THRESHOLD = 999_950
// Subagents mode (`includeSubagents: true`) expands the calm -> alert flip to
// 3,995,000, where two-decimal M rounds from `3.99M` to `4.00M`.
const SUBAGENT_ALERT_THRESHOLD = 3_995_000

export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return `${tokens}`
  if (tokens < MILLION_THRESHOLD) return `${(tokens / 1000).toFixed(1)}k`
  return `${(tokens / 1000000).toFixed(2)}M`
}

function formatCachePercent(percent: number): number {
  if (percent === 100) return 100
  return Math.min(99.9, Math.round(percent * 10) / 10)
}

// One decimal under 10 (omitting trailing `.0`), whole integer from 10 up.
// Values that round to 0 are omitted so positive output never displays `0t/s`.
export function formatTokenRate(rate: number): string | null {
  if (!Number.isFinite(rate) || rate <= 0) return null
  const value = rate >= 9.95 ? Math.round(rate) : Math.round(rate * 10) / 10
  return value > 0 ? `${value}` : null
}

export const tokens: Fragment = ({ v, o, l, t }) => {
  const total = v.session.counts.tokens
  if (!(total > 0)) return null
  const details: string[] = []
  if (v.session.cacheHitPercent !== undefined) details.push(`${formatCachePercent(v.session.cacheHitPercent)}%`)
  const rate = v.session.tokensPerSecond === undefined ? null : formatTokenRate(v.session.tokensPerSecond)
  if (rate !== null) details.push(`${rate}${l.tokensPerSecond}`)
  const suffix = details.length ? t.paint('detail', `(${details.join(', ')})`) : ''
  const alertThreshold = o.includeSubagents ? SUBAGENT_ALERT_THRESHOLD : MILLION_THRESHOLD
  return t.paint('label', `${l.tokens}:`) + t.paint(total >= alertThreshold ? 'alert' : 'calm', formatTokenCount(total)) + suffix
}
