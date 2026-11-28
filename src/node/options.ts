import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseOptions } from '../options.ts'

export type PollOptionsResult =
  | { changed: false }
  | { changed: true; ok: true; options: Record<string, unknown> }
  | { changed: true; ok: false; error: Error }

function parseRawOptions(text: string, path: string): Record<string, unknown> {
  try { return parseOptions(text) }
  catch (error) { throw new Error('Expected a VArgus JSON options object in ' + path + '. ' + (error as Error).message, { cause: error }) }
}

function readRawOptional(path: string): string | undefined {
  try { return readFileSync(path, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export function readOptionsFile(path: string): Record<string, unknown> {
  return parseRawOptions(readFileSync(path, 'utf8'), path)
}

const checkoutFile = fileURLToPath(new URL('../../vargus.jsonc', import.meta.url))

export function readCheckoutOptions(): Record<string, unknown> {
  const raw = readRawOptional(checkoutFile)
  return raw === undefined ? {} : parseRawOptions(raw, checkoutFile)
}

/** Poll a JSON/JSONC options file by raw content so edits, deletions and symlinks take effect immediately. */
export class OptionsPoller {
  private readonly path: string
  private initialized = false
  private lastRaw: string | undefined

  constructor(path = checkoutFile) {
    this.path = path
  }

  readInitial(): Record<string, unknown> {
    const raw = readRawOptional(this.path)
    this.initialized = true
    this.lastRaw = raw
    return raw === undefined ? {} : parseRawOptions(raw, this.path)
  }

  poll(): PollOptionsResult {
    let raw: string | undefined
    try { raw = readRawOptional(this.path) }
    catch (error) { return { changed: true, ok: false, error: error instanceof Error ? error : new Error(String(error)) } }
    if (this.initialized && raw === this.lastRaw) return { changed: false }
    this.initialized = true
    this.lastRaw = raw
    if (raw === undefined) return { changed: true, ok: true, options: {} }
    try { return { changed: true, ok: true, options: parseRawOptions(raw, this.path) } }
    catch (error) { return { changed: true, ok: false, error: error instanceof Error ? error : new Error(String(error)) } }
  }
}
