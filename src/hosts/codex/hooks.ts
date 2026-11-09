import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { savedTranscript } from './rollout.ts'
export { footerThread, footerCandidates } from './views.ts'

// Hook environments can contain another thread's CODEX_THREAD_ID. Use the
// current event's saved transcript, never an inherited terminal/thread binding.
export async function hookSession(input: any, home: string, event: 'SessionStart' | 'UserPromptSubmit' = 'SessionStart'): Promise<{ thread: string; cwd: string; transcript: string } | undefined> {
  if (input.hook_event_name !== event || (event === 'SessionStart' && !['startup', 'resume', 'clear', 'fork'].includes(input.source))
    || typeof input.transcript_path !== 'string' || typeof input.cwd !== 'string') return
  const stream = createReadStream(input.transcript_path)
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      const record = JSON.parse(line), p = record.payload
      // Creation source/originator can survive a resume in another frontend.
      // The CLI adapter separately matches the displayed concrete thread ID.
      if (record.type !== 'session_meta' || typeof p.id !== 'string') return
      const file = await savedTranscript(home, p.id, input.transcript_path)
      return { thread: p.id, cwd: input.cwd, transcript: file }
    }
  } finally { lines.close(); stream.destroy() }
}
