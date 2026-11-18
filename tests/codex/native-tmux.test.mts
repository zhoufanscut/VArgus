import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TmuxOutput } from '../../src/outputs/tmux/client.ts'

// Exercise the Windows branch on every platform. Commands use the psmux 3.4.0
// option-list contract; windows.test.mts complements this with real psmux.
const platform = process.platform
Object.defineProperty(process, 'platform', { value: 'win32' })
after(() => Object.defineProperty(process, 'platform', { value: platform }))

class NativeServer {
  options = new Map<string, string>([
    ['status', 'on'], ['status-left', '[#S] '], ['status-right', 'RIGHT'],
    ['status-left-length', '10'], ['status-right-length', '40'],
  ])
  windowOptions = new Map([
    ['window-status-format', '#I:#W'], ['window-status-current-format', '#I:#W*'],
    ['window-status-separator', ' '], ['window-status-style', 'default'],
    ['window-status-current-style', 'default'], ['window-status-bell-style', 'default'],
    ['window-status-last-style', 'default'],
  ])
  localOptions = new Map([['@0', new Map<string, string>()], ['@1', new Map<string, string>()]])
  panes = new Map([['%0', new Map<string, string>()], ['%1', new Map<string, string>()]])
  formats: string[] = []
  hooks = new Map<string, string[]>()
  activePane = '%0'
  templates = 0
  failure?: { option: string; after: boolean; pane?: string }
  hookFailure?: { event: string; after: boolean }

  value(option: string, pane = '%0') { return this.panes.get(pane)?.get(option) ?? this.options.get(option) ?? '' }

  async command(...args: string[]): Promise<string> {
    const separator = args.indexOf(';')
    if (separator >= 0) {
      if (args[0] === 'set-hook') throw new Error('psmux hook writes must be separate requests')
      await this.command(...args.slice(0, separator))
      return this.command(...args.slice(separator + 1))
    }
    const [command, ...flags] = args
    const target = flags[flags.indexOf('-t') + 1] ?? '%0'
    const option = flags.at(-1)!
    if (command === 'display-message') {
      if (option === '#{session_id}') return '$1'
      if (option === '#{window_width}') return '80'
      if (option === '#{m/r:[^ ],#{P:#{@vargus_owner}}}') return this.value('@vargus_owner', this.activePane) ? '1' : '0'
      if (option === '#{@vargus_line}') return this.value('@vargus_line')
      this.templates++
      return 'ORIGINAL INFO'
    }
    if (command === 'dump-state') return JSON.stringify({ status_format: this.formats.map(format =>
      format.replace(/#\{(@[\w-]+)\}/g, (_, name: string) => this.value(name))) })
    if (command === 'list-windows') return [...this.localOptions.keys()].join('\n')
    if (command === 'show-hooks') return [...this.hooks].flatMap(([event, commands]) => commands.map((command, i) =>
      `${event}${commands.length > 1 ? `[${i}]` : ''} -> ${command}`)).join('\n')
    if (command === 'set-hook') {
      const event = flags.find(flag => !flag.startsWith('-'))!
      const failure = this.hookFailure?.event === event ? this.hookFailure : undefined
      if (failure) this.hookFailure = undefined
      if (failure && !failure.after) throw new Error('CONTROLLED HOOK FAILURE')
      if (flags.includes('-u')) this.hooks.delete(event)
      else this.hooks.set(event, [...(flags.includes('-a') ? this.hooks.get(event) ?? [] : []), flags.at(-1)!])
      if (failure) throw new Error('CONTROLLED HOOK FAILURE')
      return ''
    }
    if (command === 'show-options') {
      if (flags.includes('-v')) return flags.includes('-p') ? this.value(option, target) : this.options.get(option) ?? this.windowOptions.get(option) ?? ''
      if (flags.includes('-w')) {
        const entries = flags.includes('-g') ? this.windowOptions : this.localOptions.get(target)!
        return [...entries].map(([key, value]) => `${key} ${value}`).join('\n')
      }
      // Plain ShowOptions omits the global separator and bell/last styles.
      return [...this.options, ...[...this.windowOptions].filter(([key]) => !['window-status-separator', 'window-status-bell-style', 'window-status-last-style'].includes(key))]
        .map(([key, value]) => `${key} "${value}"`).join('\n')
    }
    if (command === 'set-option') {
      const separator = flags.indexOf(';')
      if (separator >= 0) {
        await this.command(command, ...flags.slice(0, separator))
        return this.command(...flags.slice(separator + 1))
      }
      let index = 0
      while (flags[index]?.startsWith('-')) index += flags[index] === '-t' ? 2 : 1
      const name = flags[index]!, value = flags[index + 1] ?? ''
      const failure = this.failure?.option === name && (!this.failure.pane || target === this.failure.pane) ? this.failure : undefined
      if (failure) this.failure = undefined
      if (failure && !failure.after) throw new Error('CONTROLLED WRITE FAILURE')
      const row = name.match(/^status-format\[(\d+)\]$/)
      if (row) {
        while (this.formats.length <= Number(row[1])) this.formats.push('')
        this.formats[Number(row[1])] = value
      } else {
        const values = flags.includes('-p') ? this.panes.get(target)! : this.options
        if (flags.includes('-u')) values.delete(name)
        else values.set(name, value)
      }
      if (failure) throw new Error('CONTROLLED WRITE FAILURE')
      return ''
    }
    throw new Error('Unexpected native command: ' + args.join(' '))
  }
}

async function rig() {
  const root = await mkdtemp(join(tmpdir(), 'vargus-native-contract-')), server = new NativeServer()
  class Output extends TmuxOutput {
    override command(...args: string[]) { return server.command(...args) }
  }
  return { root, server, output: (pane = '%0') => new Output('native-test', pane, root),
    states: async () => Promise.all((await readdir(root, { recursive: true })).filter(name => name.endsWith('state.json'))
      .map(async name => JSON.parse(await readFile(join(root, name), 'utf8')))),
    close: () => rm(root, { recursive: true, force: true }) }
}

test('native attachment rolls back rejected writes before and after their application and can retry', async () => {
  for (const option of ['@vargus_original_left', 'status-left', 'status-left-length', 'status-right-length', '@vargus_native_layout', 'status', '@vargus_owner']) {
    for (const after of [false, true]) {
      const r = await rig(), output = r.output()
      const original = new Map(r.server.options)
      r.server.panes.get('%0')!.set('@vargus_line', 'PRIOR LINE')
      r.server.panes.get('%0')!.set('@vargus_header', 'PRIOR HEADER')
      try {
        r.server.failure = { option, after }
        await assert.rejects(output.attach(), /CONTROLLED WRITE FAILURE/)
        await output.detach()
        for (const [name, value] of original) assert.equal(r.server.options.get(name), value, `${option} after=${after}: ${name}`)
        assert.equal(r.server.value('@vargus_line'), 'PRIOR LINE')
        assert.equal(r.server.value('@vargus_header'), 'PRIOR HEADER')
        assert.equal(r.server.value('@vargus_owner'), '')
        assert.deepEqual(await r.states(), [])
        await output.attach(); await output.update('RETRIED'); await output.detach()
        assert.equal(r.server.options.get('status'), 'on')
      } finally { await output.detach(); await r.close() }
    }
  }
})

test('a failed native join preserves the existing owner and its bar', async () => {
  const r = await rig(), first = r.output(), second = r.output('%1')
  try {
    await first.attach(); await first.update('FIRST OWNER')
    r.server.failure = { option: '@vargus_owner', pane: '%1', after: true }
    await assert.rejects(second.attach(), /CONTROLLED WRITE FAILURE/)
    assert.equal(r.server.options.get('status'), '2')
    assert.equal((await r.states())[0].owners.length, 1)
    assert.match(r.server.value('@vargus_header'), /FIRST OWNER/)
    await second.attach(); await second.detach()
    await first.update('STILL RUNNING')
    assert.match(r.server.value('@vargus_header'), /STILL RUNNING/)
    await first.detach()
    assert.equal(r.server.options.get('status-left'), '[#S] ')
  } finally { await first.detach(); await second.detach(); await r.close() }
})

test('partial native hook installation rolls back while preserving user hooks and can retry', async () => {
  for (const after of [false, true]) {
    const r = await rig(), output = r.output()
    r.server.hooks.set('after-select-window', ['set-option @user BEFORE', 'set-option @second "two words"'])
    r.server.hooks.set('after-select-window[1000]', ['set-option @literal INDEXED'])
    const original = structuredClone(r.server.hooks)
    try {
      r.server.hookFailure = { event: 'after-select-pane', after }
      await assert.rejects(output.attach(), /CONTROLLED HOOK FAILURE/)
      assert.deepEqual(r.server.hooks, original)
      assert.deepEqual(await r.states(), [])
      assert.equal(r.server.options.get('status'), 'on')
      await output.attach(); await output.update('RETRIED'); await output.detach()
      assert.deepEqual(r.server.hooks, original)
    } finally { await output.detach(); await r.close() }
  }
})

test('native render ticks reconcile window routes without hooks and preserve later heights', async () => {
  const r = await rig(), output = r.output()
  try {
    await output.attach(); await output.update('OWNED')
    assert.equal(r.server.options.get('status'), '2')
    r.server.activePane = '%1'
    await output.update('OWNED WHILE ANOTHER WINDOW IS SELECTED')
    assert.equal(r.server.options.get('status'), 'on')
    r.server.activePane = '%0'
    await output.update('BACK')
    assert.equal(r.server.options.get('status'), '2')
    r.server.options.set('status', '4')
    r.server.activePane = '%1'
    await output.update('USER HEIGHT')
    await output.detach()
    assert.equal(r.server.options.get('status'), '4')
  } finally { await output.detach(); await r.close() }
})

test('native hook cleanup distinguishes literal indexed names from real vectors and preserves later ambiguity', async () => {
  for (const mode of ['singleton', 'vector', 'ambiguous', 'later']) {
    const r = await rig(), output = r.output(), event = 'after-select-pane'
    r.server.hooks.set(event, mode === 'singleton' ? ['set-option @user USER'] : ['set-option @user USER', 'set-option @second SECOND'])
    if (mode !== 'later') r.server.hooks.set(`${event}[${mode === 'vector' ? 2 : 0}]`, ['set-option @literal LITERAL'])
    const original = structuredClone(r.server.hooks)
    try {
      await output.attach(); await output.update('OWNED')
      if (mode === 'ambiguous') assert.ok(!(await r.states())[0].native.rows.hooks.some(([name]: [string]) => name === event))
      if (mode === 'later') r.server.hooks.set(`${event}[0]`, ['set-option @new_literal NEW'])
      await output.detach()
      if (mode === 'later') {
        assert.deepEqual(r.server.hooks.get(`${event}[0]`), ['set-option @new_literal NEW'])
        assert.deepEqual(r.server.hooks.get(event)!.slice(0, 2), original.get(event))
      } else assert.deepEqual(r.server.hooks, original)
      assert.deepEqual(await r.states(), [])
    } finally { await output.detach(); await r.close() }
  }
})

test('native global separator and flag-style shell formatters use the append layout, including aliases and later edits', async () => {
  for (const option of ['window-status-separator', 'window-status-bell-style', 'window-status-last-style']) {
    for (const alias of [false, true]) {
      const r = await rig(), output = r.output()
      const format = alias ? '#{E:formatter}' : '#(slow-command)'
      r.server.options.set('@formatter', '#(slow-command)')
      try {
        r.server.windowOptions.set(option, format)
        await output.attach(); await output.update('APPENDED READING')
        assert.equal(r.server.options.get('status-left'), '[#S] ')
        assert.equal(r.server.templates, 0)
        assert.match(r.server.value('@vargus_line'), /APPENDED READING/)
        await output.detach()
        r.server.windowOptions.set(option, 'default')
        await output.attach(); await output.update('TOP HEADER')
        assert.match(r.server.options.get('status-left')!, /vargus_header/)
        const templates = r.server.templates
        r.server.windowOptions.set(option, format)
        await output.update('LATER APPENDED READING')
        assert.equal(r.server.options.get('status-left'), '[#S] ')
        assert.equal(r.server.templates, templates)
      } finally { await output.detach(); await r.close() }
    }
  }
})

test('native window-local bar overrides retain psmux rendering before attachment and when added with two owners', async () => {
  for (const option of ['window-status-format', 'window-status-current-format', 'window-status-style', 'window-status-current-style', 'window-status-separator']) {
    const r = await rig(), first = r.output(), second = r.output('%1')
    try {
      r.server.localOptions.get('@1')!.set(option, 'CUSTOM LOCAL VALUE')
      await first.attach(); await first.update('APPENDED')
      assert.equal(r.server.options.get('status-left'), '[#S] ')
      assert.equal(r.server.localOptions.get('@1')!.get(option), 'CUSTOM LOCAL VALUE')
      assert.equal(r.server.templates, 0)
      await first.detach()
      r.server.localOptions.get('@1')!.delete(option)
      await first.attach(); await second.attach(); await first.update('FIRST'); await second.update('SECOND')
      assert.match(r.server.options.get('status-left')!, /vargus_header/)
      const templates = r.server.templates
      r.server.localOptions.get('@1')!.set(option, 'LATER LOCAL VALUE')
      await first.update('FIRST APPENDED'); await second.update('SECOND APPENDED')
      assert.equal(r.server.options.get('status-left'), '[#S] ')
      assert.equal(r.server.templates, templates)
      assert.match(r.server.value('@vargus_line', '%0'), /FIRST APPENDED/)
      assert.match(r.server.value('@vargus_line', '%1'), /SECOND APPENDED/)
      await first.detach()
      assert.equal(r.server.options.get('status'), 'on')
      await second.detach()
      assert.equal(r.server.options.get('status'), 'on')
    } finally { await first.detach(); await second.detach(); await r.close() }
  }
})
