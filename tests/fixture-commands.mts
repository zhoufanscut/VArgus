import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { text } from 'node:stream/consumers'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export async function withCleanup(work: () => Promise<void>, cleanup: () => Promise<void>): Promise<void> {
  try { await work() } catch (failure) {
    try { await cleanup() } catch (cleanupError) {
      throw new AggregateError([failure, cleanupError], 'Command and fixture cleanup both failed')
    }
    throw failure
  }
  await cleanup()
}

async function processes(group: number, env: NodeJS.ProcessEnv) {
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
  const started = new Date().toISOString()
  if (process.platform === 'win32') {
    const supervisor = join(dirname(stopped), 'fixture-job.exe')
    await access(supervisor).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      const compiler = join(process.env.SystemRoot!, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
      await exec(compiler, ['/nologo', `/out:${supervisor}`, join(import.meta.dirname, 'windows-fixture-job.cs')], { cwd, env, windowsHide: true, timeout: 15_000 })
    })
    const child = spawn(supervisor, [command, String(timeout), stopped], {
      cwd, env, stdio: 'inherit', windowsHide: true, timeout: timeout + 15_000, killSignal: 'SIGKILL',
    })
    const [code, signal] = await once(child, 'close')
    if (code !== 0) throw new Error(`${command} failed (${signal ?? code}; supervisor PID ${child.pid}, started ${started})`)
    return
  }

  const anchor = 'IFS= read -r start || exit 1; sh -c "$1" </dev/null 3>&-; printf "%s\\n" "$?" >&3; exec 3>&-; IFS= read -r stop'
  const child = spawn('sh', ['-c', anchor, 'fixture-shell', command], { cwd, env, detached: true, stdio: ['pipe', 'inherit', 'inherit', 'pipe'] })
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  const cancellation = new AbortController()
  const interrupt = (signal: NodeJS.Signals) => cancellation.abort(new Error(`${command} interrupted by ${signal} (PID ${child.pid}, started ${started})`))
  process.on('SIGINT', interrupt).on('SIGTERM', interrupt)
  try {
    await once(child, 'spawn')
    const group = child.pid!
    const status = text(child.stdio[3] as NodeJS.ReadableStream)
    let timer: NodeJS.Timeout | undefined
    let visible = false
    await withCleanup(async () => {
      visible = (await processes(group, env)).some(row => row.pid === group && row.group === group && row.marked)
      if (!visible) throw new Error(`ps did not see the marked gated shell (PID ${group})`)
      cancellation.signal.throwIfAborted()
      child.stdin!.write('run\n')
      const result = await Promise.race([status, new Promise<never>((_, reject) => {
        cancellation.signal.addEventListener('abort', () => reject(cancellation.signal.reason), { once: true })
        timer = setTimeout(() => reject(new Error(`${command} timed out (PID ${group}, started ${started})`)), timeout)
      })])
      if (result.trim() !== '0') throw new Error(`${command} exited with ${result.trim() || 'no status'} (PID ${group}, started ${started})`)
    }, async () => {
      clearTimeout(timer)
      if (child.exitCode === null && child.signalCode === null) process.kill(-group, 'SIGKILL')
      child.stdin!.destroy()
      await Promise.race([closed, delay(5000, undefined, { ref: false }).then(() => { throw new Error(`Shell PID ${group} did not close`) })])
      const until = Date.now() + 5000
      let rows = await processes(group, env)
      while (rows.length && Date.now() < until) { await delay(50); rows = await processes(group, env) }
      if (rows.length) throw new Error(`Fixture processes still active: ${rows.map(row => row.label).join(', ')}`)
      if (visible) await writeFile(stopped, '')
    })
    cancellation.signal.throwIfAborted()
  } finally {
    process.off('SIGINT', interrupt).off('SIGTERM', interrupt)
  }
}
