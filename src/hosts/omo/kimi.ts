import { isRecentUsage, type ApiError, type QuotaReading, type QuotaWindow } from '../../core/limits.ts'
import type { Labels } from '../../i18n/en.ts'
import { parseKimiUsage, type KimiUsage } from '../../core/kimi.ts'

export type ProviderAuth = {
  readonly auth: { readonly apiKey?: string; readonly baseUrl?: string }
  readonly env?: Readonly<Record<string, string | undefined>>
}

const URLS = {
  'mainland-cn': 'https://api.kimi.com/coding/v1/usages',
  global: 'https://api.kimi.ai/coding/v1/usages',
} as const

// One native row owns this cache and request lifetime. Credentials are resolved
// by OmO, never read from a hard-coded auth.json path.
export class OmoKimi {
  private usage: { data: KimiUsage; at: number } | undefined
  private error: ApiError | null = null
  private controller: AbortController | undefined
  private retryAt = 0
  private failures = 0
  private selected = false
  private disposed = false

  private readonly resolveAuth: () => Promise<ProviderAuth | undefined>

  constructor(resolveAuth: () => Promise<ProviderAuth | undefined>) { this.resolveAuth = resolveAuth }

  readings(now: number, labels: Labels): QuotaReading[] {
    if (!this.usage || !isRecentUsage(this.usage.at, now)) return this.error ? [this.error] : []
    const { fiveHour, monthly } = this.usage.data
    const stale = this.error !== null
    const windows: QuotaWindow[] = []
    if (fiveHour) windows.push({ label: labels.fiveHour, ...fiveHour, stale })
    if (monthly) windows.push({ label: labels.monthly, ...monthly, stale })
    return windows
  }

  async refresh(provider: string | undefined, now = Date.now()): Promise<void> {
    if (this.disposed) return
    if (provider !== 'kimi-coding') {
      if (this.selected) {
        this.controller?.abort()
        this.controller = undefined
        this.usage = undefined
        this.error = null
        this.retryAt = 0
        this.failures = 0
      }
      this.selected = false
      return
    }
    this.selected = true
    if (this.controller || now < this.retryAt) return
    const controller = new AbortController()
    this.controller = controller
    const timeout = setTimeout(() => controller.abort(), 30_000)
    timeout.unref()
    try {
      const auth = await this.resolveAuth()
      if (controller.signal.aborted) return
      const region = auth?.env?.KIMI_CODE_REGION
      const url = region === 'mainland-cn' ? URLS['mainland-cn'] : region === 'global' ? URLS.global : undefined
      if (!auth?.auth.apiKey || !url) {
        this.error = 'auth'
        this.retryAt = now + 120_000
        return
      }
      if (auth.auth.baseUrl && auth.auth.baseUrl.replace(/\/+$/, '') !== url.replace(/\/v1\/usages$/, '')
        && auth.auth.baseUrl.replace(/\/+$/, '') !== url.replace(/\/usages$/, '')) {
        this.error = 'auth'
        this.retryAt = now + 120_000
        return
      }
      // Native fetch with an explicit timeout, cancellation, redirect policy
      // and provider retry cadence keeps this source-only extension dependency-free.
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${auth.auth.apiKey}`, Accept: 'application/json' },
        signal: controller.signal, redirect: 'error',
      })
      if (controller.signal.aborted) return
      if (!response.ok) {
        this.error = response.status === 429 ? 'rate_limited' : response.status === 401 || response.status === 403 ? 'auth' : 'network'
        this.failures = response.status === 429 ? this.failures + 1 : 0
        const retry = response.headers.get('retry-after') ?? ''
        const retryMs = /^\s*\d+\s*$/.test(retry) ? Math.min(Number(retry) * 1000, 3_600_000) : 0
        this.retryAt = Date.now() + (response.status === 429
          ? Math.max(Math.min(90_000 * 2 ** (this.failures - 1), 300_000), retryMs) : 120_000)
        return
      }
      const body: unknown = await response.json()
      if (controller.signal.aborted) return
      const usage = parseKimiUsage(body)
      if (!usage) {
        this.error = 'network'
        this.retryAt = Date.now() + 120_000
        return
      }
      const succeededAt = Date.now()
      this.usage = { data: usage, at: succeededAt }
      this.error = null
      this.retryAt = succeededAt + 90_000
      this.failures = 0
    } catch (error) {
      if (!(error instanceof Error)) throw error
      if (this.controller !== controller || this.disposed) return
      this.error = 'network'
      this.retryAt = Date.now() + 120_000
    } finally {
      clearTimeout(timeout)
      if (this.controller === controller) this.controller = undefined
    }
  }

  dispose(): void {
    this.disposed = true
    this.controller?.abort()
    this.controller = undefined
    this.usage = undefined
    this.error = null
  }
}
