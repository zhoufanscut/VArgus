import type { EngineInterface, Register, Timer } from 'claude-code'

import { initialLimits, measuredLimits, startLimits } from '../src/collect/limits'
import {
  initialSession, measured, sessionEnding, startSession, stepDone, stepStarting, toolCalled,
} from '../src/collect/session'
import { initialVcs, startVcs, toolCalledVcs } from '../src/collect/vcs'
import type { Theme, Values } from '../src/core/types'
import { resolveLabels } from '../src/i18n'
import { resolveOptions, type Options } from '../src/options'
import { render } from '../src/render'
import { makeTheme } from '../src/theme'
import { createWriter, endSession, pruneOld, writeLine, type Writer } from '../src/write'

// Wiring only. Module values start over on a hot reload, which runs register
// and session.start again (DESIGN, "The host"); what must survive one lives in
// $.state, kept by the collectors.
let writer: Writer | null = null
let tick: Timer | null = null
let theme: Theme | null = null
let options: Options | null = null
const labels = resolveLabels('en')
const values: Values = {
  core: { cwd: '', home: undefined, columns: undefined, isWsl: false },
  session: initialSession(),
  limits: initialLimits(),
  vcs: initialVcs(),
}

async function refresh($: EngineInterface): Promise<void> {
  if (!writer || !theme || !options) return
  values.core.cwd = await $.session.cwd()
  // re-read each tick: a /model switch raises no event but the classic
  // PostModelSwitch, which doesn't run under a managed install (a failed read
  // keeps the last model, never costs the line)
  values.session.model = await $.session.model().catch(() => values.session.model)
  // After /clear or a resume (sessionEnding) context and start are unknown,
  // and nothing pushes them until the next main-thread turn's session.measure:
  // a resumed long conversation would show ctx:0% and no session:. Read them
  // each tick until that measure (free without a breakdown), taking each
  // answer, so a first one that still described the session left (the id
  // lagged 0.75 s after a resume, DESIGN "The line file") is corrected a tick
  // later. A failed read keeps the values and never costs the line.
  const s = values.session
  if (s.rereading) {
    const usage = await $.session.usage().catch(() => null)
    if (usage) {
      s.contextPercent = usage.context.percent
      s.startedAt = usage.startedAt
    }
  }
  const now = await $.clock.now()
  await writeLine($, writer, render({ v: values, o: options, l: labels, t: theme, now }))
}

async function isWsl($: EngineInterface): Promise<boolean> {
  if (await $.env.get('WSLENV')) return true
  try {
    return /microsoft/i.test(await $.fs.read('/proc/version'))
  } catch {
    return false
  }
}

export const register: Register = (on, given) => {
  options = resolveOptions(given)


  on('session.start', async ($, e, next) => {
    await startSession($, values.session)
    // Only an interactive session shows a status line (DESIGN, "When the line is written").
    if (e.isInteractive) {
      writer = await createWriter($)
      startVcs($, values.vcs, e, options?.detachedHead ?? false)
      startLimits($, values.limits, e)
      values.core.home = await $.env.get('HOME')
      values.core.isWsl = await isWsl($)
      theme = makeTheme(options?.theme ?? 'graphite', !!(await $.env.get('NO_COLOR')))
      tick?.cancel()
      tick = $.clock.every(1000, () => {
        refresh($).catch(() => {})
      })
      // Not awaited: the first session.start is awaited before the first
      // prompt, and a slow or refused write must not hold it.
      refresh($).catch(() => {})
      const w = writer
      $.clock.now().then(now => pruneOld($, w, now)).catch(() => {})
    }
    return next(e)
  })

  // One hook per event: the validator refuses a second one without a matcher.
  // Each only observes: it passes the event on and returns what next gave.
  on('session.measure', async ($, e, next) => {
    measured($, e, values.session)
    measuredLimits($, values.limits, e)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    stepStarting(e, values.session)
    const r = yield* next(e)
    stepDone($, r, values.session)
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
