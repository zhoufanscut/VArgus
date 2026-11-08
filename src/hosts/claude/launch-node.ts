import { readFile, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { dataDir, homeDir } from './paths'

// Node-side launcher only. The Claude mod never imports this file.
export function claudeLaunch(root: string, args: string[], runId: string, options: Record<string, unknown>) {
  const data = dataDir(process.env.CLAUDE_CONFIG_DIR, homeDir(process.env.HOME, process.env.USERPROFILE))
  if (!data || !/^[0-9a-f]{32}$/.test(runId)) throw new Error('Claude needs an absolute config folder and a valid VArgus run id.')
  const directory = join(data, `tmux-${runId}`)
  const settings = {
    statusLine: { type: 'command', command: 'true' },
    pluginConfigs: { vargus: { options: { ...options, tmuxOutput: true } }, 'vargus@inline': { options: { ...options, tmuxOutput: true } } },
  }
  return {
    args: ['--plugin-dir', root, '--settings', JSON.stringify(settings), ...args],
    async line(): Promise<string> {
      try {
        const file = join(directory, 'line')
        if (Date.now() - (await stat(file)).mtimeMs > 120000) return ''
        return await readFile(file, 'utf8')
      } catch { return '' }
    },
    async close() { await rm(directory, { recursive: true, force: true }) },
  }
}
