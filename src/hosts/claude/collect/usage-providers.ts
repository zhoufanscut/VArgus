// Direct provider usage APIs. A provider matches an exact base URL and parses
// into shared UsageData. Matching fixes the HTTPS destination: the existing
// environment credential is never sent to a gateway that merely names Kimi.
// New direct providers add one entry to DIRECT_PROVIDERS.

import type { UsageData } from '../../../core/limits'
import { parseKimiUsage } from '../../../core/kimi'

export type DirectUsageProvider = {
  id: string
  baseUrl: string
  usageUrl: string
  parse: (body: unknown) => UsageData | null
}

const DIRECT_PROVIDERS: DirectUsageProvider[] = [
  {
    id: 'kimi.com', baseUrl: 'https://api.kimi.com/coding', usageUrl: 'https://api.kimi.com/coding/v1/usages',
    parse: parseKimiUsage,
  },
  {
    id: 'kimi.ai', baseUrl: 'https://api.kimi.ai/coding', usageUrl: 'https://api.kimi.ai/coding/v1/usages',
    parse: parseKimiUsage,
  },
]

export function directUsageProvider(baseUrl: string | undefined): DirectUsageProvider | null {
  if (!baseUrl) return null
  let normalized: string
  try {
    const url = new URL(baseUrl)
    normalized = `${url.origin.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
  return DIRECT_PROVIDERS.find(p => p.baseUrl === normalized) ?? null
}
