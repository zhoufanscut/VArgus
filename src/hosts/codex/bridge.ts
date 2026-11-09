import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { WebSocketServer, WebSocket } from 'ws'
import type { Message } from './protocol.ts'

// A local transport bridge: the normal Codex TUI owns initialization, requests,
// approvals and turns. Observation adds no requests or model calls.
export async function startBridge(options: {
  socket: string; command: string; args: string[]; env?: NodeJS.ProcessEnv; cwd?: string
  client: (message: Message) => void; server: (message: Message) => void
}) {
  const http = createServer()
  const sockets = new WebSocketServer({ server: http })
  http.listen(options.socket)
  await once(http, 'listening')
  let backend: ReturnType<typeof spawn> | undefined
  let stopped = false
  const failure = new Promise<never>((_, reject) => {
    sockets.on('connection', ws => {
      if (backend) { ws.close(1008, 'One Codex client per bridge'); return }
      backend = spawn(options.command, ['app-server', '--stdio', ...options.args], {
        env: options.env ?? process.env, cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'],
      })
      let errors = ''
      backend.stderr!.on('data', data => { errors = (errors + String(data)).slice(-4000) })
      backend.on('error', reject)
      backend.on('exit', code => {
        ws.close()
        if (!stopped) reject(new Error(`Codex app-server exited (${code}): ${errors}`))
      })
      const lines = createInterface({ input: backend.stdout! })
      lines.on('line', line => {
        if (ws.readyState === WebSocket.OPEN) ws.send(line)
        try { options.server(JSON.parse(line) as Message) } catch { /* collection cannot interrupt RPC */ }
      })
      ws.on('message', data => {
        const line = data.toString()
        backend!.stdin!.write(line + '\n')
        try { options.client(JSON.parse(line) as Message) } catch { /* pass through */ }
      })
      ws.on('error', reject)
    })
    http.on('error', reject)
  })
  // Install a handler immediately, even before the caller starts its TUI.
  void failure.catch(() => {})
  return {
    endpoint: `unix://${options.socket}`,
    failure,
    async close() {
      stopped = true
      for (const ws of sockets.clients) ws.terminate()
      sockets.close()
      http.close()
      if (backend && backend.exitCode === null && backend.signalCode === null) {
        backend.stdin!.end()
        const exited = once(backend, 'exit')
        backend.kill('SIGTERM')
        const timer = setTimeout(() => backend!.kill('SIGKILL'), 2000)
        await exited
        clearTimeout(timer)
      }
    },
  }
}
