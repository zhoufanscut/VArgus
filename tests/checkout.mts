import { cp } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// Exercise the source-only install without importing a developer's personal options.
export async function fixtureCheckout(dir: string): Promise<string> {
  const checkout = join(dir, 'install')
  for (const name of ['src', 'bin', 'package.json']) {
    await cp(resolve(name), join(checkout, name), { recursive: true })
  }
  return checkout
}
