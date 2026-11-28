import type { EngineInterface, PluginOptions, Register, SessionStartInput, Timer, TurnStepChunk, TurnStepResult } from 'claude-code'

import { initialClaudeLimits, claudeQuotaReadings } from './quota'
import { measuredLimits, startLimits, stopLimits } from './collect/limits'
import {
  compacted, effectiveCounts, initialSession, measured, sessionEnding, setModel, startSession, stepDone, stepStarting,
  toolCalled,
} from './collect/session'
import { initialVcs, startVcs, stopVcs, toolCalledVcs } from './collect/vcs'
import type { Theme, Values } from '../../core/types'
import { resolveLabels } from '../../i18n'
import { resolveOptions, sameOptions, type Options } from '../../options'
import { joinParts, renderParts } from '../../render'
import { claudeDisplay } from './display'
import { initSharedOptions, pollSharedOptions, registerConfig } from './config'
import { makeTheme } from '../../theme'
import { DRIVE_PATH } from './paths'
import { createWriter, endSession, homeDir, pruneOld, writeLine, type Writer } from './write'

export const CLAUDE_THEME = 'claude-terracotta'

// Wiring only. Module values start over on a hot reload, which runs register
// and session.start again (DESIGN, "The host"); what must survive one lives in
// $.state, kept by the collectors.
let writer: Writer | null = null
let tick: Timer | null = null
let theme: Theme | null = null
let options: Options | null = null
let sessionStart: SessionStartInput | null = null
let noColor = false
const labels = resolveLabels('en')
const quota = initialClaudeLimits()
const values: Values = {
  core: { cwd: '', home: undefined, columns: undefined, isWsl: false },
  session: initialSession(),
  limits: [],
  vcs: initialVcs(),
}

async function refresh($: EngineInterface, given: PluginOptions): Promise<void> {
  if (!writer || !theme || !options) return
  if (sessionStart) {
    const before = options
    const polled = await pollSharedOptions($, given)
    if (polled && options === before && !sameOptions(options, polled)) {
      configure($, sessionStart, polled, noColor, options)
    }
  }
  values.core.cwd = await $.session.cwd()
  // re-read each tick: a /model switch raises no event but the classic
  // PostModelSwitch, which doesn't run under a managed install (a failed read
  // keeps the last model, never costs the line)
  setModel($, values.session, await $.session.model().catch(() => values.session.model))
  const now = await $.clock.now()
  values.limits = options.rateLimits ? claudeQuotaReadings(quota, labels, now) : []
  const session = { ...values.session, counts: effectiveCounts(values.session, options.includeSubagents) }
  const parts = renderParts({ v: { ...values, session }, display: claudeDisplay(session), o: options, l: labels, t: theme, now })
  const text = joinParts(parts, theme)
  await writeLine($, writer, text, values.core.columns, { t: theme, l: labels, isWsl: values.core.isWsl }, parts)
}

async function isWsl(
  $: EngineInterface,
  home: string | undefined,
  userProfile: string | undefined,
  cwd: string,
): Promise<boolean> {
  if ((!!userProfile && DRIVE_PATH.test(userProfile) && !home?.startsWith('/')) || DRIVE_PATH.test(cwd)) return false
  if (await $.env.get('WSL_DISTRO_NAME') || await $.env.get('WSL_INTEROP')) return true
  try {
    return /microsoft/i.test(await $.fs.read('/proc/version'))
  } catch {
    return false
  }
}

function configure($: EngineInterface, e: SessionStartInput, next: Options, noColor: boolean, previous?: Options): void {
  options = next
  theme = makeTheme(next.theme, noColor, CLAUDE_THEME)
  const hasVcs = next.repo || next.branch || next.status
  const hadVcs = previous?.repo || previous?.branch || previous?.status
  if (hasVcs && !hadVcs) startVcs($, values.vcs, e)
  if (!hasVcs && hadVcs) stopVcs()
  if (next.rateLimits && !previous?.rateLimits) startLimits($, quota, e)
  if (!next.rateLimits && previous?.rateLimits) stopLimits()
}

export const register: Register = (on, given) => {
  const native = resolveOptions(given)
  options = native
  let applyOptions: ((changes: Partial<Options>) => void) | undefined
  registerConfig(on, given, changes => applyOptions?.(changes))

  on('session.start', async ($, e, next) => {
    await startSession($, values.session)
    // Only an interactive session shows a status line (DESIGN, "When the line is written").
    if (e.isInteractive) {
      let initial = native
      try { initial = await initSharedOptions($, given) }
      catch (error) { $.ui.log('Could not load vargus.jsonc. ' + String(error)) }
      writer = await createWriter($)
      sessionStart = e
      noColor = !!(await $.env.get('NO_COLOR'))
      configure($, e, initial, noColor)
      applyOptions = changes => {
        if (!options) return
        const resolved = resolveOptions({ ...options, ...changes })
        if (!sameOptions(options, resolved)) configure($, e, resolved, noColor, options)
        refresh($, given).catch(() => {})
      }
      const home = await $.env.get('HOME')
      const userProfile = await $.env.get('USERPROFILE')
      values.core.home = homeDir(home, userProfile)
      values.core.isWsl = await isWsl($, home, userProfile, e.cwd)
      tick?.cancel()
      tick = $.clock.every(1000, () => {
        refresh($, given).catch(() => {})
      })
      // Not awaited: the first session.start is awaited before the first
      // prompt, and a slow or refused write must not hold it.
      refresh($, given).catch(() => {})
      // A live plugin reload can leave the old detail pane open in Claude.
      $.ui.close({ id: 'vargus' }).catch(() => {})
      const w = writer
      $.clock.now().then(now => pruneOld($, w, now)).catch(() => {})
    }
    return next(e)
  })

  // One hook per event: the validator refuses a second one without a matcher.
  // Each only observes: it passes the event on and returns what next gave.
  on('session.measure', async ($, e, next) => {
    measured($, e, values.session)
    measuredLimits($, quota, e)
    return next(e)
  })

  // A compaction that stands resets the live window with no session.measure
  // until the next turn's end (DESIGN, "Data sources").
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    compacted($, e, r, values.session)
    return r
  })

  on('turn.step', async function* ($, e, next) {
    stepStarting($, e, values.session)
    if (e.agentId !== undefined) {
      const r = yield* next(e)
      await stepDone($, e, r, values.session)
      return r
    }
    const readClock = () => $.clock.now().catch(() => undefined)
    const stream = next(e)
    let firstClockChecked = false
    let endClockChecked = false
    let firstTokenAt: number | undefined
    let endedAt: number | undefined
    let outputChunks = 0
    let finished = false
    let r: TurnStepResult
    try {
      for (;;) {
        const nextChunk = await stream.next()
        if (nextChunk.done) {
          finished = true
          r = nextChunk.value
          break
        }
        const chunk: TurnStepChunk = nextChunk.value
        if (chunk.kind === 'thinking' || chunk.kind === 'text' || chunk.kind === 'tool' || chunk.kind === 'input') {
          if (!firstClockChecked) {
            firstClockChecked = true
            firstTokenAt = await readClock()
          }
          outputChunks += 1
        } else if (chunk.kind === 'stop' && firstTokenAt !== undefined && !endClockChecked) {
          endClockChecked = true
          endedAt = await readClock()
        }
        yield chunk
      }
    } finally {
      if (!finished) await stream.return?.(undefined as never).catch(() => {})
    }
    if (firstTokenAt !== undefined && !endClockChecked) {
      endClockChecked = true
      endedAt = await readClock()
    }
    const timing = firstTokenAt !== undefined && endedAt !== undefined
      ? { firstTokenAt, endedAt, outputChunks } : undefined
    await stepDone($, e, r, values.session, timing)
    return r
  })

  on('tool.call', async ($, e, next) => {
    toolCalled($, e, values.session)
    const result = await next(e)
    // after the tool ran: a file-changing tool asks for a git/svn read
    toolCalledVcs($, values.vcs, e)
    return result
  })

  on('session.end', async ($, e, next) => {
    sessionEnding($, e, values.session)
    // a failed removal leaves the folder, as before
    if (writer) await endSession($, writer, e.sessionId).catch(() => {})
    return next(e)
  })

  // The width: observe the prompt-hint row's viewport, draw nothing
  // (DESIGN, "When the line is written").
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (e.viewport) values.core.columns = e.viewport.columns
    return next(e)
  })
}
