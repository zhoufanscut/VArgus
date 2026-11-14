import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'

async function files(dir: string): Promise<string[]> {
  return (await Promise.all((await readdir(dir, { withFileTypes: true })).map(e =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.[cm]?tsx?$/.test(e.name) ? [join(dir, e.name).replaceAll('\\', '/')] : []))).flat()
}

test('shared modules have no host, display, Node or Claude API imports; host collectors are independent', async () => {
  const checked = await files('src')
  assert.ok(checked.includes('src/hosts/claude/register.ts'))
  assert.ok(checked.includes('src/hosts/codex/collect.ts'))
  assert.ok(checked.includes('src/hosts/antigravity/collect.ts'))
  assert.ok(checked.includes('src/hosts/omo/collect.ts'))
  assert.ok(checked.includes('src/hosts/omo/register.ts'))
  assert.ok(checked.includes('src/cli.ts'))
  for (const file of checked) {
    const text = await readFile(file, 'utf8')
    const imports = [...text.matchAll(/(?:from\s+|import\s*(?:\(\s*)?)['"]([^'"]+)['"]/g)].map(m => m[1]!)
    for (const spec of imports) assert.ok(spec.startsWith('.') || spec.startsWith('node:') || spec === 'claude-code', `${file} imports an npm package: ${spec}`)
    if (/^src\/(core|render|theme|i18n)\//.test(file) || file === 'src/options.ts') {
      for (const spec of imports) assert.ok(!/hosts|outputs|claude-code|^node:/.test(spec), `${file} imports ${spec}`)
    }
    if (file.startsWith('src/hosts/codex/')) for (const spec of imports) assert.ok(!/claude|antigravity|omo|claude-code|outputs/.test(spec), `${file} imports ${spec}`)
    if (file.startsWith('src/hosts/claude/')) for (const spec of imports) assert.ok(!/codex|antigravity|omo|outputs/.test(spec), `${file} imports ${spec}`)
    if (file.startsWith('src/hosts/antigravity/')) for (const spec of imports) assert.ok(!/claude|codex|omo|claude-code|outputs/.test(spec), `${file} imports ${spec}`)
    if (file.startsWith('src/hosts/omo/')) for (const spec of imports) {
      assert.ok(!/claude|codex|antigravity/.test(spec), `${file} imports ${spec}`)
      if (/outputs/.test(spec)) assert.ok(file === 'src/hosts/omo/register.ts' && spec === '../../outputs/omo.ts', `${file} imports ${spec}`)
    }
    if (file.startsWith('src/outputs/')) for (const spec of imports) assert.ok(!/hosts|claude-code/.test(spec), `${file} imports ${spec}`)
  }
})

test('the reachable Claude mod graph excludes Node code', async () => {
  const manifest = JSON.parse(await readFile('hooks/hooks.json', 'utf8')) as { modules: string[] }
  const pending = manifest.modules.map(spec => resolve('hooks', spec))
  const visited = new Set<string>()
  while (pending.length) {
    const file = pending.pop()!
    if (visited.has(file)) continue
    visited.add(file)
    const text = await readFile(file, 'utf8')
    for (const [, spec] of text.matchAll(/(?:from\s+|import\s*)['"]([^'"]+)['"]/g)) {
      if (!spec!.startsWith('.')) {
        assert.equal(spec, 'claude-code', `${file} imports a package outside the mod API`)
        continue
      }
      const base = resolve(dirname(file), spec!)
      const destination = [base, base + '.ts', base + '.tsx', base + '.d.ts', join(base, 'index.ts'), join(base, 'index.d.ts')]
      let found: string | undefined
      for (const candidate of destination) {
        try { await readFile(candidate); found = candidate; break } catch { /* next valid source spelling */ }
      }
      assert.ok(found, `Cannot resolve ${spec} from ${file}`)
      pending.push(found)
    }
  }
  assert.ok(visited.has(resolve('src/hosts/claude/register.ts')))
  assert.ok(visited.has(resolve('src/render/index.ts')))
})

test('user installs declare no npm runtime dependencies', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'))
  for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.deepEqual(pkg[key] ?? {}, {}, key)
  }
})
