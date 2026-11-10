// Read-only requests: no thread creation, resume, configuration write or model call.
import { spawn, execFile } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

export async function codexRead(method: 'config/read' | 'thread/read', params: unknown, cwd: string, home?: string): Promise<any> {
  const command = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : 'codex'
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'codex app-server --stdio'] : ['app-server', '--stdio']
  const child = spawn(command, args, { cwd, windowsHide: true, env: home ? { ...process.env, CODEX_HOME: home } : process.env, stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = createInterface({ input: child.stdout })
  let errors = ''
  child.stderr.on('data', data => { errors = (errors + String(data)).slice(-1000) })
  try {
    return await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Reading saved Codex data timed out.')), 8000)
      const fail = (error: Error) => { clearTimeout(timer); reject(error) }
      child.once('error', fail)
      child.once('exit', () => fail(new Error('Could not read saved Codex data. ' + errors)))
      const send = (id: number, method: string, params: unknown) => child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
      child.stdin.on('error', fail)
      lines.on('line', line => {
        let reply: any
        try { reply = JSON.parse(line) } catch { return }
        if (reply.error) return fail(new Error(`Codex read: ${reply.error.message}`))
        if (reply.id === 1) send(2, method, params)
        if (reply.id === 2) {
          clearTimeout(timer); resolve(reply.result)
        }
      })
      send(1, 'initialize', { clientInfo: { name: 'vargus-footer', version: '0.1.0' } })
    })
  } finally {
    lines.close()
    child.stdin.end()
    if (process.platform === 'win32' && child.pid) {
      // cmd.exe launches the npm shim and its native child. Let EOF close the
      // whole chain and its SQLite handles before releasing the read request.
      await Promise.race([once(child, 'close'), delay(1000)])
      if (child.exitCode === null && child.signalCode === null) await promisify(execFile)('taskkill.exe',
        ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {})
    } else child.kill('SIGTERM')
  }
}
