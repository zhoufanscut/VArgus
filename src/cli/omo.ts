import { mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { readOmoOptions } from '../hosts/omo/options.ts'
import { writeSetupFile } from './settings.ts'

const MARKER = '// VArgus OmO native extension loader.\n'
const HELP = `Usage:
  vargus omo install [--dir EXTENSIONS_DIRECTORY] [--config FILE]
  vargus omo remove [--dir EXTENSIONS_DIRECTORY]`

function loaderSource(entrySpecifier: string, configArgument?: string): string {
  return MARKER + (configArgument === undefined
    ? `export { default } from ${entrySpecifier};\n`
    : `import { configuredVargus } from ${entrySpecifier};\nexport default configuredVargus(${configArgument});\n`)
}

export async function omo(argv: string[]): Promise<number> {
  const action = argv[0]
  if (action !== 'install' && action !== 'remove') throw new Error(HELP)
  let directory: string | undefined
  let config: string | undefined
  for (let i = 1; i < argv.length; i += 2) {
    const [flag, value] = argv.slice(i, i + 2)
    if (!value) throw new Error(HELP)
    if (flag === '--dir' && directory === undefined) directory = resolve(value)
    else if (flag === '--config' && config === undefined && action === 'install') config = resolve(value)
    else throw new Error(HELP)
  }
  if (config !== undefined) readOmoOptions(config)
  if (directory === undefined) {
    const { stdout } = await promisify(execFile)('omo', ['config', 'agent-dir', '--json'], {
      timeout: 10000, windowsHide: true,
    })
    const selection: unknown = JSON.parse(stdout)
    if (selection === null || typeof selection !== 'object'
      || !('version' in selection) || selection.version !== 1
      || !('ok' in selection) || selection.ok !== true
      || !('dir' in selection) || typeof selection.dir !== 'string' || !selection.dir) {
      throw new Error('OmO did not report its agent directory. Supply --dir EXTENSIONS_DIRECTORY.')
    }
    directory = join(selection.dir, 'extensions')
  }
  const target = join(directory, 'vargus.ts')
  const entry = new URL('../hosts/omo/register.ts', import.meta.url)
  let previous: string | undefined
  try { previous = await readFile(target, 'utf8') }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  const [, entryLine, configLine] = previous?.split('\n') ?? []
  const previousSpecifier = entryLine?.match(/ from ("file:[^"\r\n]+");$/)?.[1]
  const previousConfig = configLine?.match(/\(("(?:[^"\\]|\\.)*")\);$/)?.[1]
  const owned = previousSpecifier !== undefined
    && previous === loaderSource(previousSpecifier, previousConfig)
  if (previous !== undefined && !owned) throw new Error(`Refusing to replace an unrelated or modified extension: ${target}`)
  if (action === 'remove') {
    if (previous !== undefined) await unlink(target)
    console.log(`VArgus loader removed: ${target}\nRun /reload in each OmO session to restore its native footer.`)
    return 0
  }
  const loader = loaderSource(JSON.stringify(entry.href), config === undefined ? previousConfig : JSON.stringify(config))
  if (previous === undefined) {
    await mkdir(directory, { recursive: true })
    await writeFile(target, loader, { flag: 'wx' })
  } else if (previous !== loader) {
    const file = await realpath(target)
    await writeSetupFile(file, previous, loader)
  }
  console.log(`VArgus loader installed: ${target}\nRun /reload in OmO. Use /vargus off to restore the native footer.`)
  return 0
}
