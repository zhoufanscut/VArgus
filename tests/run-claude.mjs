import { access, cp, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { runFixtureCommand, withCleanup } from './fixture-commands.mts'

const source = resolve(import.meta.dirname, '..')
const temp = await realpath(tmpdir())
const directory = await mkdtemp(join(temp, 'vargus-claude-test-'))
const checkout = join(directory, 'checkout')
const profile = join(directory, 'profile')
const temporary = join(directory, 'tmp')
const stopped = join(directory, 'commands-stopped')
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
  VARGUS_CLAUDE_CHECKOUT: checkout,
}
const windows = process.platform === 'win32'
const plugin = windows ? '"%VARGUS_CLAUDE_CHECKOUT%"' : '.'
const shell = windows ? 'git -c "alias.vargus-test=!sh" vargus-test' : 'sh'
let testsStarted = false

await withCleanup(async () => {
  await mkdir(profile)
  await mkdir(temporary)
  for (const name of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'README.md', 'bin', 'src', 'tests/claude', 'docs/setup-claude.md']) {
    await cp(join(source, name), join(checkout, name), { recursive: true, filter: path => !path.endsWith('.test.mts') })
  }
  testsStarted = true
  for (const command of [`claude plugin validate ${plugin}`, `claude plugin test ${plugin}`, `${shell} tests/claude/reader.test.sh`, `${shell} tests/claude/manifest.test.sh`]) {
    await runFixtureCommand(command, checkout, env, stopped)
    if (!windows) await access(stopped)
  }
}, async () => {
  if (windows && testsStarted) {
    console.error(`Retained Claude test fixture at ${directory}: Windows CIM cannot verify exit of unmarked descendants.`)
    return
  }
  try {
    if (testsStarted) await access(stopped)
    if (await realpath(directory) !== directory || dirname(directory) !== temp) throw new Error('Fixture path changed')
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch (error) {
    throw new Error(`Retained Claude test fixture at ${directory}`, { cause: error })
  }
})
