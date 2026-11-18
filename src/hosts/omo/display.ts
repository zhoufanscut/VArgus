import type { SessionValues } from '../../core/session.ts'
import { displaySession, shortModelName } from '../../render/session.ts'
import { cleanText } from '../../render/text.ts'

// OmO supplies model IDs: named families omit versions, other IDs use their
// model stem. Kimi's coding catalog also uses the bare `k3` family.
function shortOmoModelName(model: string): string | null {
  const id = model.trim().toLowerCase().split('/').pop() ?? ''
  if (!id) return null
  const family = /(?:^|[-_\s])(fable|opus|sonnet|haiku|sol|terra|luna|astra|argon)(?=$|[-_\s.\d])/.exec(id)?.[1]
  if (family) return family
  if (/^k\d+(?:[.-]|$)/.test(id)) return 'kimi'
  return /^[a-z]+/.exec(id)?.[0] ?? shortModelName(id)
}

export function omoDisplay(session: SessionValues) {
  const display = displaySession(session, shortOmoModelName)
  const variant = /-(ultrafast|fast|highspeed)$/i.exec(cleanText(session.model ?? '').trim())?.[1]?.toLowerCase()
  if (variant) display.speed = variant === 'ultrafast' ? 'ultrafast' : 'fast'
  return display
}
