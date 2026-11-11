import { expect, test } from 'claude-code/testing'
import type { EngineInterface, ToolCallInput } from 'claude-code'

import { initialVcs, startVcs, toolCalledVcs } from '../src/hosts/claude/collect/vcs'

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

test('worktree changes invalidate completed, in-flight and clock-pending Git walks', async () => {
  let now = 0
  let cwd = '/a'
  let tick!: () => void
  let statusCalls = 0
  const statusResult = (branch: string) => ({
    exitCode: 0, stdout: `# branch.oid 1\n# branch.head ${branch}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false,
  })
  const pendingStatus: Array<(result: ReturnType<typeof statusResult>) => void> = []
  let holdNow = false
  let releaseNow: (() => void) | undefined
  const $ = {
    clock: {
      now: async () => {
        if (holdNow) {
          holdNow = false
          await new Promise<void>(resolve => { releaseNow = resolve })
        }
        return now
      },
      every: (_ms: number, fn: () => void) => { tick = fn; return { cancel: () => {} } },
    },
    session: {
      repo: async () => ({ root: cwd, remote: `https://example.invalid${cwd}.git`, internal: false, name: null }),
      cwd: async () => cwd,
    },
    fs: { exists: async () => false },
    process: {
      run: async (argv: string[]) => {
        if (argv.includes('--absolute-git-dir')) return { ...statusResult(''), stdout: `${cwd}/.git\n` }
        if (argv.includes('status')) {
          statusCalls++
          if (statusCalls % 2 === 1) return new Promise<ReturnType<typeof statusResult>>(resolve => { pendingStatus.push(resolve) })
          return statusResult(`${cwd.slice(1)}-branch`)
        }
        throw new Error(`unexpected command: ${argv.join(' ')}`)
      },
    },
  } as unknown as EngineInterface
  const values = initialVcs()
  startVcs($, values, { isInteractive: true } as never, false)
  await flush()
  expect(statusCalls).toBe(1)

  // The old two-second walk completes before the worktree event.
  now = 2000
  pendingStatus.shift()!(statusResult('a-branch'))
  await flush()
  expect([values.repo, values.branch]).toEqual(['a', 'a-branch'])
  cwd = '/b'
  toolCalledVcs($, values, { tool: 'EnterWorktree' } as ToolCallInput)
  expect(values.repo).toBeNull()
  await flush()
  now = 3000
  tick()
  await flush()
  expect([statusCalls, values.repo, values.branch]).toEqual([2, 'b', 'b-branch'])

  // The next old walk is still in flight when the worktree changes.
  now = 4000
  toolCalledVcs($, values, { tool: 'Edit' } as ToolCallInput)
  await flush()
  tick()
  await flush()
  expect(statusCalls).toBe(3)
  cwd = '/c'
  toolCalledVcs($, values, { tool: 'ExitWorktree' } as ToolCallInput)
  expect(values.repo).toBeNull()
  now = 6000
  pendingStatus.shift()!(statusResult('b-branch'))
  await flush()
  expect([values.repo, values.branch]).toEqual([null, null])
  now = 7000
  tick()
  await flush()
  expect([statusCalls, values.repo, values.branch]).toEqual([4, 'c', 'c-branch'])

  // This walk finishes, but its final clock read is pending during the event.
  now = 8000
  toolCalledVcs($, values, { tool: 'Edit' } as ToolCallInput)
  await flush()
  tick()
  await flush()
  expect(statusCalls).toBe(5)
  now = 10_000
  holdNow = true
  pendingStatus.shift()!(statusResult('c-branch'))
  await flush()
  expect(releaseNow).toBeDefined()
  cwd = '/d'
  toolCalledVcs($, values, { tool: 'EnterWorktree' } as ToolCallInput)
  expect(values.repo).toBeNull()
  releaseNow?.()
  await flush()
  expect([values.repo, values.branch]).toEqual([null, null])
  now = 11_000
  tick()
  await flush()
  expect([statusCalls, values.repo, values.branch]).toEqual([6, 'd', 'd-branch'])
  expect(pendingStatus).toEqual([])
})
