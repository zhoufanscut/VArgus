import { cleanText, shortenHome } from './text'

// What the renderer reads; collectors fill it (DESIGN, "How it works").
export type Values = {
  cwd: string
  home: string | undefined
}

// Pure: values → the line's text.
export function render(v: Values): string {
  return cleanText(shortenHome(v.cwd, v.home))
}
