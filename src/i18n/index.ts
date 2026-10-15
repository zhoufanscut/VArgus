import { en, type Labels } from './en'

// The language registry (DESIGN, "Languages"): a null prototype and own-property
// lookups, so a tag such as `constructor` finds nothing and falls back to English.
const registry: Record<string, Labels> = Object.assign(Object.create(null), { en })

export function resolveLabels(tag: string): Labels {
  return Object.prototype.hasOwnProperty.call(registry, tag) ? registry[tag]! : en
}

export type { Labels }
