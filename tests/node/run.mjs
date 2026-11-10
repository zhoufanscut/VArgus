import { readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'

// These rigs require POSIX executable shims, /proc, or tmux's raw option API.
// Windows runs the shared checks plus the native official-Codex/psmux rig.
const posixRigs = new Set(['hooks.test.mts', 'hooks-engine.test.mts', 'skills-engine.test.mts', 'fast-engine.test.mts',
  'views-engine.test.mts', 'standalone.test.mts', 'tmux.test.mts'])
const files = readdirSync('tests/node').filter(name => name.endsWith('.test.mts'))
  .filter(name => process.platform !== 'win32' || !posixRigs.has(name)).sort()
if (process.platform === 'win32') console.log('POSIX-specific rigs excluded on Windows:', [...posixRigs].join(', '))
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files.map(name => 'tests/node/' + name)],
  { stdio: 'inherit', windowsHide: true })
child.on('error', error => { console.error(error); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
