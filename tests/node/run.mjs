import { readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'

const posixNative = ['hooks-engine.test.mts', 'skills-engine.test.mts', 'fast-engine.test.mts',
  'views-engine.test.mts', 'standalone.test.mts', 'tmux.test.mts']
const native = new Set([...posixNative, 'windows.test.mts'])
// The hook fixtures use POSIX executable shims without launching Codex or tmux.
const posixRigs = new Set([...posixNative, 'hooks.test.mts'])
const fixturesOnly = process.argv.includes('--fixtures')
const files = readdirSync('tests/node').filter(name => name.endsWith('.test.mts'))
  .filter(name => !fixturesOnly || !native.has(name))
  .filter(name => process.platform !== 'win32' || !posixRigs.has(name)).sort()
if (process.platform === 'win32') {
  console.log('POSIX-specific rigs excluded on Windows:', [...posixRigs].join(', '))
}
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files.map(name => 'tests/node/' + name)],
  { stdio: 'inherit', windowsHide: true })
child.on('error', error => { console.error(error); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
