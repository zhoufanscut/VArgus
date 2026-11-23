import type { Values } from '../../core/types.ts'
import { initialVcs } from '../../core/vcs.ts'
import { readVcs } from '../../node/vcs.ts'

const VCS_TIMEOUT_MS = 30_000

export function pollVcs(): (values: Values) => void {
  let vcsAt = 0
  let vcsCwd = ''
  let pending = false
  return values => {
    const cwd = values.core.cwd
    // A render or paused snapshot must not pair a new folder with old VCS data.
    if (cwd !== vcsCwd) values.vcs = initialVcs()
    if (pending || (cwd === vcsCwd && Date.now() < vcsAt)) return
    vcsCwd = cwd
    const start = Date.now()
    pending = true
    void readVcs(cwd, VCS_TIMEOUT_MS).then(vcs => {
      if (values.core.cwd === cwd) values.vcs = vcs
    }).finally(() => {
      vcsAt = Date.now() + Math.max(5000, (Date.now() - start) * 10)
      pending = false
    })
  }
}
