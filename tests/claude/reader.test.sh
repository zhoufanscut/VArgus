#!/bin/sh
# The statusLine commands from the Claude setup guide, run in a test home.
# Run: sh tests/claude/reader.test.sh   (exits 1 on a failure)
set -u
cd "$(dirname "$0")/../.." || exit 1
fails=0
fail() { echo "FAIL: $*"; fails=$((fails + 1)); }

cmd='f="$HOME/.claude/plugins/data/vargus-vargus/$CLAUDE_CODE_SESSION_ID/line"; if [ -s "$f" ] && { IFS= read -r d && [ "$(date +%s)" -ge "$d" ] && IFS= read -r row; } 2>/dev/null < "$f.live"; then printf %s "$row"; else cat "$f" 2>/dev/null; fi'

node --input-type=module - docs/setup-claude.md "$cmd" <<'JS' || exit 1
import { readFileSync } from "node:fs"
const [file, ...commands] = process.argv.slice(2)
const guide = readFileSync(file, "utf8")
for (const command of commands) {
  const entry = '"command": ' + JSON.stringify(command) + ','
  if (!guide.includes(entry)) {
    console.error("FAIL: " + file + " is missing " + entry)
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

touch -t 200001010000 "$data/S1/line" || exit 1
for shell in sh bash; do
  command -v "$shell" >/dev/null || { echo "skip: no $shell"; continue; }
  out=$(HOME="$reader_test_home" CLAUDE_CODE_SESSION_ID=S1 "$shell" -c "$cmd"; echo "rc=$?")
  want=$(printf '\033[38;2;1;2;3m~/proj\033[0m | 中文 ✓rc=0')
  [ "$out" = "$want" ] || fail "$shell: present line: $out"
  printf '1\nold reading | ⌛stale\n' > "$data/S1/line.live"
  out=$(HOME="$reader_test_home" CLAUDE_CODE_SESSION_ID=S1 "$shell" -c "$cmd")
  [ "$out" = 'old reading | ⌛stale' ] || fail "$shell: expired deadline: $out"
  printf '%s\nunused stale row\n' "$(( $(date +%s) + 60 ))" > "$data/S1/line.live"
  out=$(HOME="$reader_test_home" CLAUDE_CODE_SESSION_ID=S1 "$shell" -c "$cmd"; echo "rc=$?")
  [ "$out" = "$want" ] || fail "$shell: recovered reader: $out"
  out=$(HOME="$reader_test_home" CLAUDE_CODE_SESSION_ID=S2 "$shell" -c "$cmd" 2>&1; echo "rc=$?")
  [ "$out" = "rc=1" ] || fail "$shell: missing file: $out"
  out=$(HOME="$reader_test_home" CLAUDE_CODE_SESSION_ID= "$shell" -c "$cmd" 2>&1; echo "rc=$?")
  [ "$out" = "rc=1" ] || fail "$shell: empty id: $out"
done

[ "$fails" -eq 0 ] && echo "reader: all pass" || exit 1
