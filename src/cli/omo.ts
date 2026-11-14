import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const MARKER = '// VArgus OmO native extension loader.\n'
const HELP = 'Usage: vargus omo install|remove [--dir EXTENSIONS_DIRECTORY]'

export async function omo(argv: string[]): Promise<number> {
  const action = argv[0]
  if ((action !== 'install' && action !== 'remove')
    || (argv.length !== 1 && !(argv.length === 3 && argv[1] === '--dir' && argv[2]))) {
    throw new Error(HELP)
  }
  let directory: string
  if (argv[2]) directory = resolve(argv[2])
  else {
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
  const loader = MARKER + `export { default } from ${JSON.stringify(entry.href)};\n`
  let previous: string | undefined
  try { previous = await readFile(target, 'utf8') }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  const previousSpecifier = previous?.match(/"file:[^"\r\n]+"(?=;\n$)/)?.[0]
  const owned = previousSpecifier !== undefined
    && previous === MARKER + `export { default } from ${previousSpecifier};\n`
  if (previous !== undefined && !owned) throw new Error(`Refusing to replace an unrelated or modified extension: ${target}`)
  if (action === 'remove') {
    if (previous !== undefined) await unlink(target)
    console.log(`VArgus loader removed: ${target}\nRun /reload in each OmO session to restore its native footer.`)
    return 0
  }
  await mkdir(directory, { recursive: true })
  await writeFile(target, loader, { flag: previous === undefined ? 'wx' : 'w' })
  console.log(`VArgus loader installed: ${target}\nRun /reload in OmO. Use /vargus off to restore the native footer.`)
  return 0
}
