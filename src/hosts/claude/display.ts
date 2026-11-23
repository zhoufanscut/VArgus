import type { SessionValues } from '../../core/session.ts'
import { displaySession, shortModelName } from '../../render/session.ts'

export function claudeDisplay(session: SessionValues) {
  return displaySession(session, shortModelName)
}
