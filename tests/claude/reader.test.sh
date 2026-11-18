#!/bin/sh
# The statusLine commands from README.md, run against line files in a test home.
# Run: sh tests/claude/reader.test.sh   (exits 1 on a failure)
set -u
root=$(cd "$(dirname "$0")/../.." && pwd)
fails=0
fail() { echo "FAIL: $*"; fails=$((fails + 1)); }

cmd='cat "$HOME/.claude/plugins/data/vargus-vargus/$CLAUDE_CODE_SESSION_ID/line" 2>/dev/null'
cmd2='f="$HOME/.claude/plugins/data/vargus-vargus/$CLAUDE_CODE_SESSION_ID/line"; [ -n "$(find "$f" -mmin -2 2>/dev/null)" ] && cat "$f"'

node --input-type=module - "$root/README.md" "$cmd" "$cmd2" <<'JS' || exit 1
import { readFileSync } from "node:fs"
const [file, ...commands] = process.argv.slice(2)
const readme = readFileSync(file, "utf8")
for (const command of commands) {
  const entry = '"command": ' + JSON.stringify(command) + ','
  if (!readme.includes(entry)) {
    console.error("FAIL: README is missing " + entry)
    process.exitCode = 1
  }
}
JS

tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT
reader_test_home="$tmp/home dir"
data="$reader_test_home/.claude/plugins/data/vargus-vargus"
mkdir -p "$data/S1" || exit 1
# A line with colour codes and wide characters, no trailing newline.
printf '\033[38;2;1;2;3m~/proj\033[0m | 中文 ✓' > "$data/S1/line"

for shell in sh bash; do
  command -v "$shell" >/dev/null || { echo "skip: no $shell"; continue; }
  out=$(HOME="$reader_test_home" CLAUDE_CODE_SESSION_ID=S1 "$shell" -c "$cmd"; echo "rc=$?")
  want=$(printf '\033[38;2;1;2;3m~/proj\033[0m | 中文 ✓rc=0')
  [ "$out" = "$want" ] || fail "$shell: present line: $out"
  out=$(HOME="$reader_test_home" CLAUDE_CODE_SESSION_ID=S2 "$shell" -c "$cmd" 2>&1; echo "rc=$?")
  [ "$out" = "rc=1" ] || fail "$shell: missing file: $out"
  out=$(HOME="$reader_test_home" CLAUDE_CODE_SESSION_ID= "$shell" -c "$cmd" 2>&1; echo "rc=$?")
  [ "$out" = "rc=1" ] || fail "$shell: empty id: $out"
done

# The blankStopped reader prints the file only while it is under two minutes
# old (GNU find; BSD find rounds the age up to whole minutes: under one).
ago() { date -d "-$1 seconds" +%Y%m%d%H%M.%S 2>/dev/null || date -v-"$1"S +%Y%m%d%H%M.%S; }
for shell in sh bash; do
  command -v "$shell" >/dev/null || continue
  touch "$data/S1/line"
  out=$(HOME="$reader_test_home" CLAUDE_CODE_SESSION_ID=S1 "$shell" -c "$cmd2"; echo "rc=$?")
  [ "$out" = "$want" ] || fail "$shell: blankStopped, fresh line: $out"
  touch -t "$(ago 180)" "$data/S1/line"
  out=$(HOME="$reader_test_home" CLAUDE_CODE_SESSION_ID=S1 "$shell" -c "$cmd2" 2>&1; echo "rc=$?")
  [ "$out" = "rc=1" ] || fail "$shell: blankStopped, 3 min old: $out"
  out=$(HOME="$reader_test_home" CLAUDE_CODE_SESSION_ID=S2 "$shell" -c "$cmd2" 2>&1; echo "rc=$?")
  [ "$out" = "rc=1" ] || fail "$shell: blankStopped, missing file: $out"
  out=$(HOME="$reader_test_home" CLAUDE_CODE_SESSION_ID= "$shell" -c "$cmd2" 2>&1; echo "rc=$?")
  [ "$out" = "rc=1" ] || fail "$shell: blankStopped, empty id: $out"
done

[ "$fails" -eq 0 ] && echo "reader: all pass" || exit 1
