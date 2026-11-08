import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ansiRuns } from '../../src/outputs/ansi'
import { tmuxLine } from '../../src/outputs/tmux/format'
import { makeTheme } from '../../src/theme'

test('tmux preserves theme colour, nested bold and literal format-like text without raw escapes', () => {
  const t = makeTheme('graphite', false)
  const line = t.paint([1, 2, 3], 'one ' + t.bold('two')) + ' #(do-not-run) #{pane_id} #[fg=red]'
  assert.deepEqual(ansiRuns(line).slice(0, 2), [
    { text: 'one ', color: '#010203', bold: false },
    { text: 'two', color: '#010203', bold: true },
  ])
  const output = tmuxLine(line)
  assert.ok(output.includes('#[fg=#010203,bold]two'))
  assert.ok(output.includes('##(do-not-run) ##{pane_id} ##[fg=red]'))
  assert.ok(!output.includes('\x1b'))
})
