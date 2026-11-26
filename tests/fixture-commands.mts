import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { text } from 'node:stream/consumers'
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const exec = promisify(execFile)

async function relayOutput(source: Readable, destination: NodeJS.WriteStream, cancellation: AbortController): Promise<void> {
  const failed = (error: unknown) => { cancellation.abort(error); source.destroy() }
  destination.on('error', failed)
  try {
    for await (const chunk of source) {
      await new Promise<void>((resolve, reject) => destination.write(chunk, error => error ? reject(error) : resolve()))
    }
  } catch (error) {
    failed(error)
    await nextTurn()
  } finally { destination.off('error', failed) }
}

export async function withCleanup(work: () => Promise<void>, cleanup: () => Promise<void>): Promise<void> {
  try { await work() } catch (failure) {
    try { await cleanup() } catch (cleanupError) {
      throw new AggregateError([failure, cleanupError], 'Command and fixture cleanup both failed')
    }
    throw failure
  }
  await cleanup()
}

export function windowsEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const target = name.toLowerCase()
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === target && value) return value
  }
  return undefined
}

export function buildWindowsCimQuery(marker: string): string {
  if (!marker) throw new Error('Missing fixture marker')
  if (/[\r\n"]/.test(marker)) throw new Error('Invalid Windows fixture marker')
  return `$ErrorActionPreference = 'Stop'
# ${marker}
$marker = $env:VARGUS_CLAUDE_FIXTURE
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($marker, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
  ForEach-Object { $created = if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { 'unknown-start' }; "$($_.ProcessId) $created $($_.Name)" }`
}

export function parseWindowsCimRows(stdout: string, scannerPid: number | undefined): string[] {
  const rows = stdout.trim().split(/\r?\n/).filter(Boolean)
  const scanner = scannerPid === undefined ? undefined : rows.find(row => row.startsWith(`${scannerPid} `))
  if (!scanner) throw new Error('CIM did not see its fixture marker')
  return rows.filter(row => row !== scanner)
}

async function waitForWindowsFixture(env: NodeJS.ProcessEnv): Promise<void> {
  const query = buildWindowsCimQuery(env.VARGUS_CLAUDE_FIXTURE ?? '')
  const deadline = Date.now() + 5000
  for (;;) {
    const scan = exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query],
      { env, windowsHide: true, timeout: 5000 })
    const { stdout } = await scan
    const remaining = parseWindowsCimRows(stdout, scan.child.pid)
    if (!remaining.length) return
    if (Date.now() >= deadline) throw new Error(`Fixture processes still active: ${remaining.join(', ')}`)
    await delay(100)
  }
}

async function stopWindowsTree(pid: number, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    await exec('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { env, windowsHide: true, timeout: 5000 })
  } catch (error) {
    const details = error as { code?: number | string | null; stdout?: string; stderr?: string; message?: string }
    if (details.code === 128) return
    const output = `${details.stderr ?? ''}\n${details.stdout ?? ''}`.trim()
    throw new Error(`Could not stop Windows fixture tree (PID ${pid}): ${output || details.message}`)
  }
}

async function processes(group: number, env: NodeJS.ProcessEnv) {
  if (!env.VARGUS_CLAUDE_FIXTURE) throw new Error('Missing fixture marker')
  const scan = exec('ps', ['xeww', '-o', 'pid=,pgid=,stat=,lstart=,comm=,args='], {
    env: { ...env, LC_ALL: 'C' }, timeout: 5000, maxBuffer: 8 * 1024 * 1024,
  })
  const marker = ` VARGUS_CLAUDE_FIXTURE=${env.VARGUS_CLAUDE_FIXTURE}`
  const { stdout } = await scan.catch((error: NodeJS.ErrnoException) => {
    throw new Error(`Could not inspect fixture processes with ps (${error.code ?? 'no exit code'})`)
  })
  const rows = stdout.split('\n').flatMap(line => {
    const fields = line.trim().split(/\s+/, 9)
    if (fields.length !== 9) return []
    return [{ pid: Number(fields[0]), group: Number(fields[1]), state: fields[2]!, label: fields.join(' '),
      marked: line.includes(marker + ' ') || line.endsWith(marker) }]
  })
  if (!rows.some(row => row.pid === scan.child.pid && row.marked)) throw new Error('ps did not see its fixture marker')
  return rows.filter(row => row.pid !== scan.child.pid && row.pid !== process.pid &&
    !row.state.startsWith('Z') && (row.group === group || row.marked))
}

export async function runFixtureCommand(command: string, cwd: string, env: NodeJS.ProcessEnv, stopped: string, timeout = 120_000): Promise<void> {
  await rm(stopped, { force: true })
  if (!env.VARGUS_CLAUDE_FIXTURE) throw new Error('Missing fixture marker')
  if (process.platform === 'win32') {
    await waitForWindowsFixture(env)
    const started = new Date().toISOString()
    const comspec = windowsEnvValue(env, 'ComSpec') ?? 'cmd.exe'
    const child = spawn(comspec, ['/d', '/v:off', '/s', '/c', `"${command}"`], {
      cwd, env, stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: true,
    })
    const cancellation = new AbortController()
    let exited = false
    const closed = new Promise<[number | null, NodeJS.Signals | null]>(resolve => {
      child.once('close', (code, signal) => { exited = true; resolve([code, signal]) })
    })
    const interrupt = (signal: NodeJS.Signals) =>
      cancellation.abort(new Error(`${command} interrupted by ${signal} (PID ${child.pid}, started ${started})`))
    process.on('SIGINT', interrupt).on('SIGTERM', interrupt)
    let timer: NodeJS.Timeout | undefined
    try {
      await once(child, 'spawn')
      const pid = child.pid!
      await withCleanup(async () => {
        cancellation.signal.throwIfAborted()
        const [code, signal] = await Promise.race([closed, new Promise<never>((_, reject) => {
          cancellation.signal.addEventListener('abort', () => reject(cancellation.signal.reason), { once: true })
          timer = setTimeout(() => reject(new Error(`${command} timed out (PID ${pid}, started ${started})`)), timeout)
        })])
        if (code !== 0) {
          throw new Error(`${command} exited with ${signal ?? code} (PID ${pid}, started ${started})`)
        }
      }, async () => {
        clearTimeout(timer)
        if (!exited) {
          try { await stopWindowsTree(pid, env) } catch (error) {
            child.kill('SIGKILL')
            throw error
          }
          await Promise.race([closed, delay(5000, undefined, { ref: false }).then(() => {
            throw new Error(`Fixture shell did not close (PID ${pid})`)
          })])
        }
        await waitForWindowsFixture(env)
      })
      cancellation.signal.throwIfAborted()
    } finally {
      clearTimeout(timer)
      child.unref()
      process.off('SIGINT', interrupt).off('SIGTERM', interrupt)
    }
    return
  }

  const started = new Date().toISOString()
  const stopGroup = 'IFS= read -r stop; kill -s KILL 0'
  const anchor = `IFS= read -r start || exit 1
exec 4<&0
(${stopGroup}) <&4 3>&- 4<&- &
"$2" "$3" "$1" </dev/null 4<&- &
exec 3>&- 4<&-
${stopGroup}`
  const child = spawn('sh', ['-c', anchor, 'fixture-shell', command, process.execPath, join(import.meta.dirname, 'posix-fixture-status.mjs')],
    { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })
  const cancellation = new AbortController()
  const closed = Promise.all([new Promise<void>(resolve => child.once('close', () => resolve())),
    relayOutput(child.stdout, process.stdout, cancellation), relayOutput(child.stderr, process.stderr, cancellation)])
  const interrupt = (signal: NodeJS.Signals) => cancellation.abort(new Error(`${command} interrupted by ${signal} (PID ${child.pid}, started ${started})`))
  process.on('SIGINT', interrupt).on('SIGTERM', interrupt)
  try {
    await once(child, 'spawn')
    const group = child.pid!
    const lostAnchor = new Promise<string>(resolve => {
      child.once('exit', () => resolve(''))
      child.stdin!.once('error', () => resolve(''))
    })
    let timer: NodeJS.Timeout | undefined
    let visible = false
    await withCleanup(async () => {
      visible = (await processes(group, env)).some(row => row.pid === group && row.group === group && row.marked)
      if (!visible) throw new Error(`ps did not see the marked gated shell (PID ${group})`)
      cancellation.signal.throwIfAborted()
      const status = text(child.stdio[3] as NodeJS.ReadableStream)
      child.stdin!.write('run\n')
      const result = await Promise.race([status, lostAnchor, new Promise<never>((_, reject) => {
        cancellation.signal.addEventListener('abort', () => reject(cancellation.signal.reason), { once: true })
        timer = setTimeout(() => reject(new Error(`${command} timed out (PID ${group}, started ${started})`)), timeout)
      })])
      if (result.trim() !== '0') throw new Error(`${command} exited with ${result.trim() || 'no status'} (PID ${group}, started ${started})`)
    }, async () => {
      clearTimeout(timer)
      child.stdin!.destroy()
      child.kill('SIGCONT')
      await Promise.race([closed, delay(5000, undefined, { ref: false }).then(() => { throw new Error(`Fixture shell or its pipes did not close (PID ${group})`) })])
      const until = Date.now() + 5000
      let rows = await processes(group, env)
      while (rows.length && Date.now() < until) { await delay(50); rows = await processes(group, env) }
      if (rows.length) throw new Error(`Fixture processes still active: ${rows.map(row => row.label).join(', ')}`)
      if (visible) await writeFile(stopped, '')
    })
    cancellation.signal.throwIfAborted()
  } finally {
    child.stdout.destroy()
    child.stderr.destroy()
    child.stdio[3]?.destroy()
    child.unref()
    process.off('SIGINT', interrupt).off('SIGTERM', interrupt)
  }
}
