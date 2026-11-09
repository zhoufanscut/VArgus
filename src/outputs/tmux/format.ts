import { ansiRuns } from '../ansi'

export const TMUX_PADDING = '  '

// This value is inserted with #{@vargus_line}, never E: or a shell command.
// Literal hashes are escaped for tmux's status drawing, including #[styles].
export function tmuxLine(ansi: string): string {
  const parts = ansiRuns(ansi).map(run =>
    `#[fg=${run.color ?? 'default'},${run.bold ? 'bold' : 'nobold'}]`
    + run.text.replaceAll('#', '##').replace(/[\x00-\x1f\x7f-\x9f]/g, '?'))
  return '#[align=left,nolist,norange,bg=default]' + (parts.length ? TMUX_PADDING : '') + parts.join('') + '#[default]'
}
