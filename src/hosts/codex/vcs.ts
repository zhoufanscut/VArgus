import type { Values } from '../../core/types.ts'
import { initialVcs } from '../../core/vcs.ts'
import { readGit } from '../../node/git.ts'

const GIT_TIMEOUT_MS = 30_000

export function pollGit(): (values: Values) => void {
  let gitAt = 0
  let gitCwd = ''
  let pending = false
  return values => {
    const cwd = values.core.cwd
    // A render or paused snapshot must not pair a new folder with old Git data.
    if (cwd !== gitCwd) values.vcs = initialVcs()
    if (pending || (cwd === gitCwd && Date.now() < gitAt)) return
    gitCwd = cwd
    const start = Date.now()
    pending = true
    void readGit(cwd, GIT_TIMEOUT_MS).then(vcs => {
      if (values.core.cwd === cwd) values.vcs = vcs
    }).finally(() => {
      gitAt = Date.now() + Math.max(5000, (Date.now() - start) * 10)
      pending = false
    })
  }
}
