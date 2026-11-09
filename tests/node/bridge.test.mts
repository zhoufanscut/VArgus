import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { startBridge } from '../../src/hosts/codex/bridge.ts'
import type { Message } from '../../src/hosts/codex/protocol.ts'

test('real Codex app-server initializes through the Unix WebSocket bridge without a model call', { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vargus-bridge-test-'))
  const client: Message[] = [], server: Message[] = []
  const bridge = await startBridge({
    socket: join(dir, 'codex.sock'), command: 'codex', args: [],
    env: { ...process.env, CODEX_HOME: dir },
    client: m => client.push(m), server: m => server.push(m),
  })
  const ws = new WebSocket(`ws+unix://${join(dir, 'codex.sock')}:/`)
  try {
    await once(ws, 'open')
    const message = once(ws, 'message')
    ws.send(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'vargus_test', version: '0.0.0' } } }))
    const [data] = await Promise.race([message, bridge.failure])
    const response = JSON.parse(data.toString())
    assert.equal(response.id, 1)
    assert.ok(response.result, JSON.stringify(response))
    assert.equal(client[0]!.method, 'initialize')
    assert.equal(server[0]!.id, 1)
    assert.ok(!client.some(m => m.method === 'turn/start'))
  } finally {
    ws.terminate()
    await bridge.close()
    await rm(dir, { recursive: true, force: true })
  }
})
