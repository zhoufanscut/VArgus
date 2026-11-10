import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findRollout } from '../hosts/codex/rollout.ts'
import { resolveOptions } from '../options.ts'
import { hookSession } from '../hosts/codex/hooks.ts'
import { setTimeout as delay } from 'node:timers/promises'
import { savedFooter, footerIdentity } from '../hosts/codex/footer.ts'
import { startupTarget, startupHint, startupDirectory, startupSuppressed } from './startup.ts'

const exec = promisify(execFile)

export async function hook(args: string[]): Promise<number> {
  const event = args[0] === 'session-start' ? 'SessionStart' : args[0] === 'prompt' ? 'UserPromptSubmit' : undefined
  if (!event) throw new Error('Use vargus hook session-start|prompt [--config FILE].')
  const flags = args.slice(1)
  let given: Record<string, unknown> = {}, socket: string | undefined, pane: string | undefined
  for (let i = 0; i < flags.length; i += 2) {
    const flag = flags[i], value = flags[i + 1]
    if (value === undefined) throw new Error(`Missing value for ${flag}.`)
    if (flag === '--config') given = { ...given, ...JSON.parse(await readFile(value, 'utf8')) }
    else if (flag === '--socket') socket = value
    else if (flag === '--pane') pane = value
    else if (flag !== '--theme') throw new Error(`Unknown VArgus hook option: ${flag}.`)
  }
  if (!resolveOptions(given).codexAutoStart) return 0
  let raw = ''
  for await (const part of process.stdin) raw += part
  const home = process.env.CODEX_HOME ?? join(homedir(), '.codex')
  const session = await hookSession(JSON.parse(raw), home, event)
  if (!session) return 0
  // A loaded shared-daemon thread may resume without another SessionStart.
  // Prompt fallback makes one activation attempt, skipping config/read when its
  // ID is hidden, unavailable, or explicitly suppressed.
  if (event === 'UserPromptSubmit') {
    try {
      const target = await startupHint(session.thread, socket, pane)
      if (!target || await startupSuppressed(home, target, session.thread)) return 0
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || /no server running|error connecting/.test((error as Error).message)) return 0
      throw error
    }
  }
  if (await findRollout(home, session.thread) !== session.transcript) return 0
  const identity = footerIdentity(await savedFooter(session.cwd))
  if (identity === 'none') return 0
  await mkdir(startupDirectory(home), { recursive: true, mode: 0o700 })
  const until = Date.now() + 8000
  do {
    try {
      const target = await startupTarget(session.thread, socket, pane, identity === 'first')
      if (target) {
        // Recheck under the same pane lock used by manual controls. Capture all
        // stdout: SessionStart text would otherwise become model context.
        await exec(process.execPath, [fileURLToPath(new URL('../cli.ts', import.meta.url)), '__hook-on', ...flags,
          '--socket', target.socket, '--pane', target.pane], {
          cwd: session.cwd, windowsHide: true, env: { ...process.env, CODEX_THREAD_ID: session.thread, VARGUS_CODEX_TRANSCRIPT: session.transcript, VARGUS_CLI_MAIN: '1' },
        })
        return 0
      }
    } catch (error) {
      const message = (error as Error).message
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || /no server running|error connecting|Another VArgus control is pending/.test(message)) return 0
      throw error
    }
    await delay(250)
  } while (event === 'SessionStart' && Date.now() < until)
  return 0
}
