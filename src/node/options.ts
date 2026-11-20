import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseOptions } from '../options.ts'

export function readOptionsFile(path: string): Record<string, unknown> {
  const text = readFileSync(path, 'utf8')
  try { return parseOptions(text) }
  catch (error) { throw new Error('Expected a VArgus JSON options object in ' + path + '. ' + (error as Error).message, { cause: error }) }
}

const checkoutFile = fileURLToPath(new URL('../../vargus.jsonc', import.meta.url))

export function readCheckoutOptions(): Record<string, unknown> {
  try { return readOptionsFile(checkoutFile) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}
