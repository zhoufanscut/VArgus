#!/bin/sh
# plugin.json's userConfig matches the shared and Claude-specific DEFAULTS in
# src/options.ts; every line of the DEFAULTS block is one this test reads; the theme
# picker's options are `auto` followed by the palettes in src/theme/palettes.ts, in order.
# Run: sh tests/claude/manifest.test.sh   (exits 1 on a failure)
cd "$(dirname "$0")/../.." || exit 1
node --input-type=module -e '
import { readFileSync } from "node:fs"
const fail = msg => { console.log("FAIL: " + msg); process.exit(1) }
const manifest = JSON.parse(readFileSync(".claude-plugin/plugin.json", "utf8"))
const src = readFileSync("src/options.ts", "utf8").replace(/\r\n/g, "\n")
const open = "export const DEFAULTS = {\n"
const block = src.slice(src.indexOf(open) + open.length, src.indexOf("}", src.indexOf(open)))
const line = /^\s+(\w+): (true|false|\d+|\x27[^\x27]*\x27),$/
const unread = block.split("\n").filter(l => l.trim() !== "" && !line.test(l))
if (unread.length) fail("options.ts DEFAULTS lines this test cannot read: " + JSON.stringify(unread))
const defaults = Object.fromEntries([...block.matchAll(new RegExp(line.source, "gm"))]
  .map(([, k, v]) => [k, v === "true" ? true : v === "false" ? false : /^\d+$/.test(v) ? Number(v) : v.slice(1, -1)]))
const config = Object.fromEntries(Object.entries(manifest.userConfig).map(([k, f]) => [k, f.default]))
const a = JSON.stringify(defaults), b = JSON.stringify(config)
if (Object.keys(defaults).length < 10 || a !== b) fail("options.ts " + a + "\n      plugin.json " + b)
const palettes = readFileSync("src/theme/palettes.ts", "utf8").replace(/\r\n/g, "\n")
const names = [...palettes.matchAll(/^  (?:\x27([a-z0-9-]+)\x27|(\w+)): \{$/gm)].map(m => m[1] ?? m[2])
const picker = manifest.userConfig.theme.options
if (names.length < 5 || JSON.stringify(["auto", ...names]) !== JSON.stringify(picker))
  fail("palettes.ts " + JSON.stringify(["auto", ...names]) + "\n      plugin.json theme options " + JSON.stringify(picker))
console.log("manifest: all pass (" + Object.keys(defaults).length + " options, auto + " + names.length + " palettes)")
'
