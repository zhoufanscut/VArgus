#!/bin/sh
# plugin.json's userConfig matches src/options.ts DEFAULTS: same keys, same
# defaults; every line of the DEFAULTS block is one this test reads; the theme
# picker's options are the palettes in src/theme/palettes.ts, in order.
# Run: sh tests/manifest.test.sh   (exits 1 on a failure)
root=$(cd "$(dirname "$0")/.." && pwd)
node --input-type=module -e '
import { readFileSync } from "node:fs"
const root = process.argv[1]
const fail = msg => { console.log("FAIL: " + msg); process.exit(1) }
const manifest = JSON.parse(readFileSync(root + "/.claude-plugin/plugin.json", "utf8"))
const src = readFileSync(root + "/src/options.ts", "utf8")
const open = "export const DEFAULTS = {\n"
const block = src.slice(src.indexOf(open) + open.length, src.indexOf("}", src.indexOf(open)))
const line = /^\s+(\w+): (true|false|\x27[^\x27]*\x27),$/
const unread = block.split("\n").filter(l => l.trim() !== "" && !line.test(l))
if (unread.length) fail("options.ts DEFAULTS lines this test cannot read: " + JSON.stringify(unread))
const defaults = Object.fromEntries([...block.matchAll(new RegExp(line.source, "gm"))]
  .map(([, k, v]) => [k, v === "true" ? true : v === "false" ? false : v.slice(1, -1)]))
const config = Object.fromEntries(Object.entries(manifest.userConfig).map(([k, f]) => [k, f.default]))
const a = JSON.stringify(defaults), b = JSON.stringify(config)
if (Object.keys(defaults).length < 10 || a !== b) fail("options.ts " + a + "\n      plugin.json " + b)
const palettes = readFileSync(root + "/src/theme/palettes.ts", "utf8")
const names = [...palettes.matchAll(/^  (\w+): \{$/gm)].map(m => m[1])
const picker = manifest.userConfig.theme.options
if (names.length < 5 || JSON.stringify(names) !== JSON.stringify(picker))
  fail("palettes.ts " + JSON.stringify(names) + "\n      plugin.json theme options " + JSON.stringify(picker))
console.log("manifest: all pass (" + Object.keys(defaults).length + " options, " + names.length + " themes)")
' "$root"
