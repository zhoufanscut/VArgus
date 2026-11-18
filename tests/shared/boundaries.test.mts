import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

const root = await realpath('.')
const sharedAreas = new Set(['core', 'render', 'theme', 'i18n', 'options.ts'])
const nativeOutputs = new Map([
  ['src/hosts/omo/register.ts', 'src/outputs/omo.ts'],
])

function projectPath(file: string): string {
  return relative(root, file).split(sep).join('/')
}

async function files(dir: string): Promise<string[]> {
  return (await Promise.all((await readdir(dir, { withFileTypes: true })).map(e =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.[cm]?tsx?$/.test(e.name) ? [join(dir, e.name)] : []))).flat()
}

// Consume comments and unrelated quoted text while collecting literal module
// paths. Dynamic imports may use an ordinary string or a constant template.
const moduleText = new RegExp([
  String.raw`//[^\r\n]*|/\*[\s\S]*?\*/`,
  String.raw`(?:\bfrom\b|\bimport\b(?:\s*\(\s*)?)\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)')`,
  '\\bimport\\s*\\(\\s*`([^`$\\r\\n]+)`',
  String.raw`"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'`,
].join('|'), 'g')

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(moduleText)].flatMap(([, double, single, template]) => {
    const specifier = double ?? single ?? template
    return specifier === undefined ? [] : [specifier]
  })
}

async function localModule(file: string, spec: string): Promise<string> {
  const base = resolve(dirname(file), spec)
  for (const candidate of [base, base + '.ts', base + '.tsx', base + '.d.ts',
    join(base, 'index.ts'), join(base, 'index.d.ts')]) {
    try {
      if ((await stat(candidate)).isFile()) return await realpath(candidate)
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
  assert.fail(`Cannot resolve ${spec} from ${projectPath(file)}`)
}

test('module specifiers include literal dynamic imports and skip comments', () => {
  const source = [
    "// import '../retired.ts'",
    "/* export * from '../retired.ts' */",
    `const message = "Try import '../retired.ts'"`,
    "import type { Value } from '../core/values.ts'",
    'export { example } from "../core/example.ts"',
    'const load = import(`../other/entry.ts`)',
  ].join('\n')
  assert.deepEqual(importSpecifiers(source), ['../core/values.ts', '../core/example.ts', '../other/entry.ts'])
})

test('shared modules have no host, display, Node or Claude API imports; host collectors are independent', async () => {
  const checked = await files(join(root, 'src'))
  assert.ok(checked.includes(join(root, 'src', 'hosts', 'claude', 'register.ts')))
  assert.ok(checked.includes(join(root, 'src', 'cli.ts')))
  for (const file of checked) {
    const path = projectPath(file)
    const [, area, host] = path.split('/')
    const shared = sharedAreas.has(area!)
    const claude = area === 'hosts' && host === 'claude'
    for (const spec of importSpecifiers(await readFile(file, 'utf8'))) {
      const message = `${path} imports ${spec}`
      if (!spec.startsWith('.')) {
        assert.ok(spec.startsWith('node:') ? !shared && !claude : spec === 'claude-code' && claude, message)
        continue
      }
      const target = projectPath(await localModule(file, spec))
      const [top, targetArea, targetHost] = target.split('/')
      if (top !== 'src') continue
      const cli = targetArea === 'cli' || targetArea === 'cli.ts'
      if (shared) assert.ok(!cli && !['hosts', 'outputs', 'node'].includes(targetArea!), message)
      if (area === 'node') assert.ok(!cli && targetArea !== 'hosts' && targetArea !== 'outputs', message)
      if (claude) assert.notEqual(targetArea, 'node', message)
      if (area === 'hosts') {
        assert.ok(!cli, message)
        if (targetArea === 'hosts') assert.equal(targetHost, host, message)
        if (targetArea === 'outputs') assert.equal(target, nativeOutputs.get(path), message)
      }
      if (area === 'outputs') assert.ok(!cli && targetArea !== 'hosts', message)
    }
  }
})

test('the reachable Claude mod graph excludes Node code', async () => {
  const plugin = JSON.parse(await readFile(join(root, '.claude-plugin/plugin.json'), 'utf8')) as { hooks: string }
  const hookFile = resolve(root, plugin.hooks)
  const { modules } = JSON.parse(await readFile(hookFile, 'utf8')) as { modules: string[] }
  const pending = modules.map(spec => resolve(dirname(hookFile), spec))
  const visited = new Set<string>()
  while (pending.length) {
    const file = pending.pop()!
    if (visited.has(file)) continue
    visited.add(file)
    for (const spec of importSpecifiers(await readFile(file, 'utf8'))) {
      if (!spec.startsWith('.')) {
        assert.equal(spec, 'claude-code', `${file} imports a package outside the mod API`)
        continue
      }
      pending.push(await localModule(file, spec))
    }
  }
  assert.ok(visited.has(join(root, 'src', 'hosts', 'claude', 'register.ts')))
  assert.ok(visited.has(join(root, 'src', 'render', 'index.ts')))
})

test('user installs declare no npm runtime dependencies', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'))
  for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.deepEqual(pkg[key] ?? {}, {}, key)
  }
})
