import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { withCleanup } from './fixture-commands.mts'

type Member = { pid: number; parent: number; group: number; state: string; identity: string }

async function liveProcesses(): Promise<Member[]> {
  const { stdout } = await promisify(execFile)('ps', ['xww', '-o', 'pid=,ppid=,pgid=,stat=,lstart=,comm=,args='],
    { env: { ...process.env, LC_ALL: 'C' }, timeout: 3000, maxBuffer: 8 * 1024 * 1024 })
  const rows = stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line)
    return !match || match[4]!.startsWith('Z') ? [] : [{ pid: Number(match[1]), parent: Number(match[2]),
      group: Number(match[3]), state: match[4]!, identity: match[5]!.trim() }]
  })
  assert.ok(rows.some(row => row.pid === process.pid), 'ps did not see the test controller')
  return rows
}

async function waitFor(check: () => boolean | Promise<boolean>, timeout: number, failure: string): Promise<void> {
  const until = Date.now() + timeout
  while (!await check()) { if (Date.now() >= until) throw new Error(failure); await delay(25) }
}

const payload = `
const { existsSync, renameSync, writeFileSync, writeSync } = require('node:fs')
const rescue = () => { if (existsSync('rescue')) process.kill(0, 'SIGKILL') }
process.on('SIGCONT', rescue)
writeSync(1, Buffer.from([0, 65, 255, 10]))
writeSync(2, Buffer.from([1, 66, 254, 10]))
writeFileSync('ready.tmp', String(process.pid)); renameSync('ready.tmp', 'ready')
setInterval(() => { rescue(); if (existsSync('suspend')) process.kill(0, 'SIGSTOP') }, 20)
`

export async function checkStoppedOutput(leader: 'live' | 'lost'): Promise<void> {
  const temp = await realpath(tmpdir()), dir = await mkdtemp(join(temp, 'vargus-capture-')), marker = basename(dir)
  const env = { ...process.env, VARGUS_CLAUDE_FIXTURE: marker, VARGUS_TEST_NODE: process.execPath, TMP: dir, TEMP: dir, TMPDIR: dir }
  const stopped = join(dir, 'stopped'), ready = join(dir, 'ready')
  const command = `"$VARGUS_TEST_NODE" payload.cjs ${marker}`
  const driverCode = `
import { runFixtureCommand } from ${JSON.stringify(new URL('./fixture-commands.mts', import.meta.url).href)}
import { writeFile } from 'node:fs/promises'
try { await runFixtureCommand(${JSON.stringify(command)}, process.cwd(), process.env, ${JSON.stringify(stopped)}, 3000) }
catch (error) { await writeFile('failure', JSON.stringify([error.message, ...(error.errors ?? []).map(cause => cause.message)])); process.exitCode = 1 }
`
  let witness: Member | undefined, driver: ReturnType<typeof execFile> | undefined
  let result: { code: number | string; stdout: Buffer; stderr: Buffer } | undefined
  await withCleanup(async () => {
    await writeFile(join(dir, 'payload.cjs'), payload)
    driver = execFile(process.execPath, ['--input-type=module', '-e', driverCode], { cwd: dir, env, encoding: 'buffer', timeout: 20_000 },
      (error, stdout, stderr) => { result = { code: error ? error.code ?? error.signal ?? error.message : 0, stdout, stderr } })
    await waitFor(() => existsSync(ready), 5000, 'payload did not arm its rescue handler')
    const pid = Number(await readFile(ready, 'utf8')), rows = await liveProcesses()
    const member = rows.find(row => row.pid === pid)
    assert.ok(member && member.identity.endsWith(`payload.cjs ${marker}`), 'could not identify the fixture payload')
    const anchor = rows.find(row => row.pid === member.group && row.group === member.group)
    assert.ok(anchor && anchor.parent === driver.pid && anchor.identity.includes('fixture-shell') && anchor.identity.includes(marker),
      'could not identify the isolated fixture leader')
    witness = member
    await writeFile(join(dir, 'suspend'), '')
    await waitFor(async () => {
      const current = await liveProcesses()
      return [anchor, member].every(record => current.some(row => row.pid === record.pid && row.group === record.group &&
        row.identity === record.identity && row.state.startsWith('T')))
    }, 2500, 'fixture leader and payload were not both suspended')
    if (leader === 'lost') process.kill(anchor.pid, 'SIGKILL')
    await waitFor(() => !!result, 10_000, 'execFile callback did not finish before rescue')
    assert.ok(result)
    assert.equal(result.code, 1)
    assert.deepEqual(result.stdout, Buffer.from([0, 65, 255, 10]))
    assert.deepEqual(result.stderr, Buffer.from([1, 66, 254, 10]))
    const failures: string[] = JSON.parse(await readFile(join(dir, 'failure'), 'utf8'))
    if (leader === 'live') {
      assert.match(failures[0]!, /timed out/)
      await access(stopped)
      assert.ok(!(await liveProcesses()).some(row => row.group === member.group), 'fixture group still active after timeout')
    } else {
      assert.ok(failures.some(message => message.includes('exited with no status')))
      await assert.rejects(access(stopped), { code: 'ENOENT' })
      assert.ok((await liveProcesses()).some(row => row.pid === member.pid && row.identity === member.identity && row.state.startsWith('T')),
        'expected the unrecovered payload to still be suspended')
    }
  }, async () => {
    try {
      if (witness) {
        const record = witness
        await writeFile(join(dir, 'rescue'), '')
        await waitFor(async () => {
          const group = (await liveProcesses()).filter(row => row.group === record.group)
          if (!group.length) return true
          const owner = group.find(row => row.pid === record.pid && row.identity === record.identity)
          if (owner?.state.startsWith('T')) {
            try { process.kill(owner.pid, 'SIGCONT') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
          }
          return false
        }, 5000, 'could not confirm fixture group exit after independent rescue')
      }
      if (driver) {
        await waitFor(() => !!result, 5000, 'could not confirm driver completion')
        if (!witness) await access(stopped)
      }
      if (await realpath(dir) !== dir || dirname(dir) !== temp) throw new Error('fixture path changed')
      await rm(dir, { recursive: true })
    } catch (error) {
      if (driver && !result) {
        driver.kill('SIGKILL'); driver.stdout?.destroy(); driver.stderr?.destroy(); driver.unref()
        try { await waitFor(() => !!result, 2000, 'driver did not exit after termination') } catch (exitError) {
          throw new Error(`Retained capture fixture at ${dir}`, { cause: new AggregateError([error, exitError]) })
        }
      }
      throw new Error(`Retained capture fixture at ${dir}`, { cause: error })
    }
  })
}
