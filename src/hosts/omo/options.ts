import { readFileSync } from 'node:fs'

export function parseOmoOptions(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('VArgus config must be a JSON object.')
  }
  return value as Record<string, unknown>
}

export function readOmoOptions(file: string): Record<string, unknown> {
  const text = readFileSync(file, 'utf8')
  try { return parseOmoOptions(text) }
  catch (error) { throw new Error(`Expected a VArgus JSON options object in ${file}.`, { cause: error }) }
}
