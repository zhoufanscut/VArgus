import type { EngineInterface, On, PluginOptions } from 'claude-code'
import { resolveThemeOption } from '../../theme'
import { DEFAULTS, editOption, parseOptions, resolveOptions, validOption, type Options } from '../../options'
import { DRIVE_PATH, shellPath } from './paths'
import { pluginDataDir } from './write'

const saving = { plugin: 'vargus', key: 'savingOption' } as const
let hasObserved = false
let observedRaw: string | undefined
let savingDepth = 0
let polling = false

function filePath($: EngineInterface): string {
  return `${$.plugin.root}/vargus.jsonc`
}

function optionKey($: EngineInterface, row: { key: string }): keyof Options | undefined {
  const prefix = $.plugin.name + '.'
  if (!row.key.startsWith(prefix)) return
  const key = row.key.slice(prefix.length)
  if (Object.hasOwn(DEFAULTS, key)) return key as keyof Options
}

async function sharedValues($: EngineInterface, preRead?: { raw: string | undefined }): Promise<Record<string, PickerValue>> {
  let text: string
  if (preRead) {
    if (preRead.raw === undefined) return {}
    text = preRead.raw
  } else {
    const path = filePath($)
    if (!await $.fs.exists(path)) return {}
    text = await $.fs.read(path)
  }
  const file = parseOptions(text)
  const values: Record<string, PickerValue> = {}
  for (const [key, value] of Object.entries(file)) {
    if (!Object.hasOwn(DEFAULTS, key)) continue
    if (!validOption(key as keyof Options, value)) continue
    values[key] = key === 'theme' ? resolveThemeOption(String(value)) : value
  }
  return values
}

type PickerValue = Options[keyof Options]
type MirroredChoice = { original: PickerValue; applied: PickerValue; rewrittenFrom?: PickerValue }
type Mirrors = Record<string, MirroredChoice>

async function mirrorFile($: EngineInterface): Promise<string | null> {
  const dir = await pluginDataDir($)
  return dir && dir + '/picker-backups.json'
}

async function readOptional($: EngineInterface, path: string): Promise<string | undefined> {
  return await $.fs.exists(path) ? $.fs.read(path) : undefined
}

// Several sessions may save different fields. Retry an intervening edit against
// its current bytes so updating one backup preserves the rest of the installation.
async function saveMirror($: EngineInterface, file: string, id: string, value?: MirroredChoice): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await readOptional($, file)
    const mirrors: Mirrors = JSON.parse(before ?? '{}')
    if (value) mirrors[id] = value
    else {
      if (!Object.hasOwn(mirrors, id)) return
      delete mirrors[id]
    }
    const after = JSON.stringify(mirrors) + '\n'
    if (before === after) return
    const edit = { path: file, id: crypto.randomUUID() }
    if (await runEdit($, edit, 'save', editInput(before, after))) return
  }
  throw new Error(file + ' changed during the edit. Retry the setting.')
}

// The native panel displays saved picker values. Its backups belong to this
// installation; Claude removes its data directory when the marketplace is removed.
export async function claudeOptions(
  $: EngineInterface,
  given: PluginOptions,
  syncPicker = false,
  preRead?: { raw: string | undefined },
): Promise<Options> {
  const pending = (await $.state.get(saving)).value
  const shared = await sharedValues($, preRead)
  if (pending) delete shared[pending]
  const file = await mirrorFile($)
  const mirrors: Mirrors = file ? JSON.parse(await readOptional($, file) ?? '{}') : {}
  const prefix = $.plugin.root + ':'
  const effective = { ...given, ...shared }
  if (!Object.keys(shared).length && !Object.keys(mirrors).some(id => id.startsWith(prefix))) return resolveOptions(effective)

  for (const row of await $.config.list()) {
    const key = optionKey($, row)
    if (!key || key === pending || !validOption(key, row.value)) continue
    if (row.isLocked) { effective[key] = row.value; continue }
    const id = prefix + key
    const mirror = mirrors[id]
    const requested = shared[key]
    if (requested === undefined && !mirror) continue
    const owned = mirror?.applied === row.value
    const original = owned ? mirror.original : row.value
    const wanted = requested ?? original
    if (requested !== undefined && owned && mirror.rewrittenFrom === requested) {
      effective[key] = mirror.applied
      continue
    }
    effective[key] = wanted
    if (!file) continue
    if (syncPicker && row.value !== wanted) {
      // Native saving can reload the mod before config.set returns its final
      // value. The replacement reads that value from its registration options.
      const guard = await $.state.set(saving, key)
      try {
        const result = await $.config.set({ key: row.key, value: wanted })
        if ('deny' in result || !validOption(key, result.value)) {
          effective[key] = row.value
          continue
        }
        effective[key] = result.value
        const updated = requested === undefined ? undefined : { original, applied: result.value,
          rewrittenFrom: result.value === requested ? undefined : requested }
        try { await saveMirror($, file, id, updated) }
        catch (error) {
          await $.config.set({ key: row.key, value: row.value })
          throw error
        }
      } finally { await $.state.set(saving, null, { ifVersion: guard.version }) }
    } else if (syncPicker && requested === undefined) {
      await saveMirror($, file, id, undefined)
    } else if (mirror?.rewrittenFrom !== undefined) {
      // A hand edit retires the previous rewrite, including on a plain reload.
      await saveMirror($, file, id, { original, applied: row.value })
    }
  }
  return resolveOptions(effective)
}

type StagedEdit = { path: string; id: string }

function editInput(before: string | undefined, after: string) {
  return { size: before === undefined ? -1 : new TextEncoder().encode(before).length, text: (before ?? '') + after }
}

async function runEdit($: EngineInterface, edit: StagedEdit, operation: 'prepare' | 'commit' | 'cancel' | 'save', input?: { size: number; text: string }): Promise<boolean> {
  const script = shellPath(`${$.plugin.root}/src/hosts/claude/replace-config.sh`)
  // Git for Windows supplies the POSIX shell even when sh.exe is not on PATH.
  const shell = DRIVE_PATH.test(edit.path) ? ['git', '-c', 'alias.vargus-save=!sh', 'vargus-save'] : ['sh']
  const args = [...shell, script, operation, shellPath(edit.path), edit.id]
  if (input) args.push(String(input.size))
  const result = await $.process.run(args, { cwd: $.plugin.root, stdin: input?.text })
  if ((operation === 'commit' || operation === 'save') && result.exitCode === 75) return false
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Cannot ' + operation + ' edit to ' + edit.path)
  return true
}

async function prepareEdit($: EngineInterface, key: keyof Options, value: PickerValue): Promise<StagedEdit | undefined> {
  const file = filePath($)
  const exists = await $.fs.exists(file)
  const path = exists ? (await $.fs.stat(file, { resolve: true })).realPath : file
  if (!path) throw new Error('Cannot resolve ' + file)
  const before = exists ? await $.fs.read(path) : undefined
  const after = editOption(before ?? '{\n}\n', key, value)
  if (after === before) return
  const edit = { path, id: crypto.randomUUID() }
  await runEdit($, edit, 'prepare', editInput(before, after))
  return edit
}

export async function initSharedOptions($: EngineInterface, given: PluginOptions): Promise<Options> {
  const raw = await readOptional($, filePath($))
  hasObserved = true
  observedRaw = raw
  return claudeOptions($, given, false, { raw })
}

export async function pollSharedOptions($: EngineInterface, given: PluginOptions): Promise<Options | undefined> {
  if (polling || savingDepth > 0) return undefined
  polling = true
  try {
    let raw: string | undefined
    try { raw = await readOptional($, filePath($)) }
    catch { return undefined }
    if (hasObserved && raw === observedRaw) return undefined
    if ((await $.state.get(saving)).value || savingDepth > 0) return undefined
    try {
      const result = await claudeOptions($, given, false, { raw })
      if (savingDepth > 0) return undefined
      hasObserved = true
      observedRaw = raw
      return result
    } catch (error) {
      if (savingDepth === 0) {
        hasObserved = true
        observedRaw = raw
        $.ui.log('Could not load vargus.jsonc. ' + String(error))
      }
      return undefined
    }
  } finally {
    polling = false
  }
}

async function refreshOptions($: EngineInterface, given: PluginOptions, syncPicker: boolean, apply: (changes: Partial<Options>) => void): Promise<void> {
  try {
    const raw = await readOptional($, filePath($))
    if (savingDepth === 0) {
      hasObserved = true
      observedRaw = raw
    }
    apply(await claudeOptions($, given, syncPicker, { raw }))
  } catch (error) { $.ui.log('Could not load vargus.jsonc. ' + String(error)) }
}

export function registerConfig(on: On, given: PluginOptions, apply: (changes: Partial<Options>) => void): void {
  on('command.run', { command: 'config' }, async ($, e, next) => {
    await refreshOptions($, given, true, apply)
    return next(e)
  })
  on('command.run', { command: 'reload-plugins' }, async ($, e, next) => {
    await refreshOptions($, given, false, apply)
    return next(e)
  })
  on('config.set', async ($, e, next) => {
    const key = optionKey($, e)
    if (!key || e.origin.kind === 'plugin' && e.origin.name === $.plugin.name) return next(e)
    if (!validOption(key, e.value)) {
      if (key === 'folderFoldThreshold') return { deny: 'Folder fold threshold must be a positive whole number.' }
      return next(e)
    }
    const path = filePath($)
    // A downloaded marketplace cache is private to Claude. A checkout, or an
    // existing file deliberately placed beside the plugin, has a shared config.
    if (!await $.fs.exists(path) && !await $.fs.exists(`${$.plugin.root}/.git`)) return next(e)
    savingDepth++
    let staged: StagedEdit | undefined
    // The native save can reload the mod before next() returns. The new copy
    // uses the native value for this key until the file is published.
    let savingVersion: number | undefined
    try {
      try {
        try { staged = await prepareEdit($, key, e.value) }
        catch (error) { return { deny: path + ': ' + String(error) } }
        savingVersion = (await $.state.set(saving, key)).version
        const accepted = await next(e)
        if ('deny' in accepted || !validOption(key, accepted.value)) return accepted
        try {
          if (accepted.value !== e.value) {
            if (staged) await runEdit($, staged, 'cancel')
            staged = await prepareEdit($, key, accepted.value)
          }
          for (let i = 0; staged; i++) {
            const edit = staged
            const committed = await runEdit($, edit, 'commit')
            staged = undefined  // the script releases its staging directory on success or conflict
            if (committed) break
            if (i === 2) throw new Error('The file changed during the edit. Retry the setting.')
            staged = await prepareEdit($, key, accepted.value)
          }
        } catch (error) {
          $.ui.log('Could not save ' + path + '. ' + String(error))
          const restored = await $.config.set({ key: e.key, value: e.previous })
          if ('value' in restored && restored.value !== undefined) return { value: restored.value }
          return accepted
        }
        // A person's saved choice is now also the native fallback for this key.
        const file = await mirrorFile($)
        if (file) await saveMirror($, file, $.plugin.root + ':' + key)
        if (given[key] === accepted.value) apply({ [key]: accepted.value })
        return accepted
      } finally {
        if (savingVersion !== undefined) await $.state.set(saving, null, { ifVersion: savingVersion })
        if (staged) await runEdit($, staged, 'cancel')
      }
    } finally {
      savingDepth--
    }
  })
}
