import { readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { sep } from 'node:path'

const testDir = 'tests'
const posixNative = ['hooks-engine.test.mts', 'skills-engine.test.mts', 'fast-engine.test.mts',
  'views-engine.test.mts', 'standalone.test.mts', 'tmux.test.mts'].map(name => 'codex/' + name)
const native = new Set([...posixNative, 'codex/windows.test.mts'])
// The hook fixtures use POSIX executable shims without launching Codex or tmux.
const posixRigs = new Set([...posixNative, 'codex/hooks.test.mts'])
const localOnly = process.argv.includes('--local')
const files = readdirSync(testDir, { recursive: true }).filter(name => name.endsWith('.test.mts'))
  .map(name => name.split(sep).join('/'))
  .filter(name => !localOnly || !native.has(name))
  .filter(name => process.platform !== 'win32' || !posixRigs.has(name)).sort()
if (process.platform === 'win32') {
  console.log('POSIX-specific rigs excluded on Windows:', [...posixRigs].join(', '))
}
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files.map(name => `${testDir}/${name}`)],
  { stdio: 'inherit', windowsHide: true })
child.on('error', error => { console.error(error); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
