// The English labels (DESIGN, "Languages"): every word or mark the line shows.
// A plain object, not `as const`, so `Labels` keeps string values and a
// translation missing a key fails tsc.
export const en = {
  context: 'ctx',
  tokens: 'token',
  tokensPerSecond: 't/s',
  session: 'session',
  stale: 'stale',
  staleMark: '!',
  tool: 'T',
  agent: 'A',
  skill: 'S',
  staged: '+',
  modified: '!',
  untracked: '?',
  conflict: '✗',
  ahead: '⇡',
  behind: '⇣',
  gitRebase: 'rebase',
  gitAm: 'am',
  gitMerge: 'merge',
  gitCherryPick: 'cherry-pick',
  gitRevert: 'revert',
  gitBisect: 'bisect',
  repo: 'repo',
  branch: 'branch',
  worktree: '(wt:',
  fiveHour: '5h',
  sevenDay: '7d',
  monthly: '1mo',
  detachedAt: '@',
  apiRateLimited: '[API 429]',
  apiAuth: '[API AUTH]',
  apiError: '[API ERR]',
}

export type Labels = Record<keyof typeof en, string>
