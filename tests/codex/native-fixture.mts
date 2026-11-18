import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export function nativeFixtureEnv(dir: string, overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, ...overrides, VARGUS_NATIVE_FIXTURE: dir }
}

export async function startTestDaemon(home: string, env: NodeJS.ProcessEnv): Promise<void> {
  const dir = join(home, 'app-server-daemon')
  const file = join(dir, 'settings.json')
  await mkdir(dir, { recursive: true })
  const text = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '{}'
    throw error
  })
  const settings = JSON.parse(text) as { updater?: { autoUpdateEnabled?: boolean } }
  settings.updater = { ...settings.updater, autoUpdateEnabled: false }
  await writeFile(file, JSON.stringify(settings))
  await exec('codex', ['app-server', 'daemon', 'start'], { env, timeout: 20000 })
}

async function activeFixtureProcesses(dir: string): Promise<string[]> {
  const scan = exec('ps', ['xeww', '-o', 'pid=,stat=,lstart=,args='], {
    env: nativeFixtureEnv(dir, { LC_ALL: 'C' }), timeout: 5000, maxBuffer: 8 * 1024 * 1024,
  })
  const { stdout } = await scan.catch(() => {
    throw new Error(`Could not inspect fixture processes. Retained ${dir}`)
  })
  const marker = ' VARGUS_NATIVE_FIXTURE=' + dir
  const processes = stdout.split('\n')
    .filter(line => line.includes(marker + ' ') || line.endsWith(marker) || line.includes(dir + '/'))
    .map(line => line.trimStart().split(/\s+/, 7))
  if (!processes.some(([pid]) => Number(pid) === scan.child.pid)) {
    throw new Error(`Process scan could not see its fixture marker. Retained ${dir}`)
  }
  return processes.filter(([pid, state]) =>
    Number(pid) !== scan.child.pid && !state?.startsWith('Z')).map(fields => fields.join(' '))
}

export async function removeNativeFixture(dir: string): Promise<void> {
  const until = Date.now() + 5000
  let remaining = await activeFixtureProcesses(dir)
  while (remaining.length && Date.now() < until) {
    await delay(100)
    remaining = await activeFixtureProcesses(dir)
  }
  if (remaining.length) {
    throw new Error(`Retained fixture ${dir} with live processes (PID, state, start time) ${remaining.join(', ')}`)
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
