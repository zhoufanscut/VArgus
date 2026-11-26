import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const source = resolve(import.meta.dirname, '..')
const temp = await realpath(tmpdir())
const directory = await mkdtemp(join(temp, 'vargus-claude-test-'))
const checkout = join(directory, 'checkout')
const profile = join(directory, 'profile')
const temporary = join(directory, 'tmp')
const marker = basename(directory)
const env = {
  ...process.env,
  CLAUDE_CONFIG_DIR: profile,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_AUTOUPDATER: '1',
  TEMP: temporary,
  TMP: temporary,
  TMPDIR: temporary,
  VARGUS_CLAUDE_FIXTURE: marker,
}
const windows = process.platform === 'win32'
const shell = windows ? ['git', '-c', 'alias.vargus-test=!sh', 'vargus-test'] : ['sh']
const exec = promisify(execFile)
let testsStarted = false

async function run([command, ...prefix], args, windowsVerbatimArguments = false) {
  const startedAt = new Date()
  const child = spawn(command, [...prefix, ...args], {
    cwd: checkout, env, stdio: 'inherit', windowsHide: true, windowsVerbatimArguments, timeout: 120_000, killSignal: 'SIGKILL',
  })
  const [code, signal] = await once(child, 'close')
  if (code !== 0) {
    throw new Error(`${[command, ...prefix, ...args].join(' ')} exited with ${signal ?? code} (PID ${child.pid}, started ${startedAt.toISOString()})`)
  }
}

function runClaude(action) {
  return windows
    ? run([process.env.ComSpec ?? 'cmd.exe', '/d', '/s', '/c'], [`claude plugin ${action} "${checkout}"`], true)
    : run(['claude'], ['plugin', action, checkout])
}

async function fixtureProcesses() {
  const options = { env, timeout: 5_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
  const scan = windows
    ? exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' } |
  ForEach-Object { "$($_.ProcessId) active $($_.CreationDate.ToString('o')) $($_.Name)" }
`], options)
    : exec('ps', ['xeww', '-o', 'pid=,stat=,lstart=,args='], options)
  const { stdout } = await scan
  const rows = stdout.split(/\r?\n/).filter(line => line.trim() && (windows || line.includes(marker)))
    .map(line => line.trim().split(/\s+/, 7))
  if (!rows.some(([pid]) => Number(pid) === scan.child.pid)) throw new Error('Process query did not see its fixture marker')
  return rows.filter(([pid, state]) => Number(pid) !== scan.child.pid && !state?.startsWith('Z'))
    .map(row => row.join(' '))
}

async function verifyExit() {
  const deadline = Date.now() + 5_000
  let remaining = await fixtureProcesses()
  while (remaining.length && Date.now() < deadline) {
    await delay(100)
    remaining = await fixtureProcesses()
  }
  if (remaining.length) throw new Error(`Fixture processes still active: ${remaining.join(', ')}`)
}

try {
  await mkdir(profile)
  await mkdir(temporary)
  for (const name of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'src', 'tests/claude', 'docs/setup-claude.md']) {
    await cp(join(source, name), join(checkout, name), { recursive: true })
  }
  await verifyExit()
  testsStarted = true
  await runClaude('validate')
  await runClaude('test')
  for (const name of ['reader.test.sh', 'manifest.test.sh']) {
    const script = join(checkout, 'tests', 'claude', name)
    await run(shell, [windows ? script.replaceAll('\\', '/') : script])
  }
} finally {
  try {
    if (testsStarted) await verifyExit()
    if (dirname(await realpath(directory)) !== temp) throw new Error('Fixture path no longer resolves inside temp')
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch (error) {
    throw new Error(`Retained Claude test fixture at ${directory}`, { cause: error })
  }
}
