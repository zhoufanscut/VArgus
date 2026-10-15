#!/bin/sh
# The reader (DESIGN, "The reader"): the statusLine command, run as Claude Code
# runs it, against line files this test writes. Also checks that the setup
# skill and README.md carry the same command.
# Run: sh tests/reader.test.sh   (exits 1 on a failure)
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
fails=0
fail() { echo "FAIL: $*"; fails=$((fails + 1)); }

# The command as the skill writes it, ${CLAUDE_PLUGIN_DATA} still in place.
template='cat "${CLAUDE_PLUGIN_DATA}/$CLAUDE_CODE_SESSION_ID/line" 2>/dev/null'
grep -qxF "$template" "$root/skills/vargus-setup/SKILL.md" || fail "skill command differs"
grep -qF '"command": "cat \"${CLAUDE_PLUGIN_DATA}/$CLAUDE_CODE_SESSION_ID/line\" 2>/dev/null",' \
  "$root/skills/vargus-setup/SKILL.md" || fail "skill JSON entry differs from its command"
grep -qF '"command": "cat \"$HOME/.claude/plugins/data/vargus-vargus/$CLAUDE_CODE_SESSION_ID/line\" 2>/dev/null",' \
  "$root/README.md" || fail "README JSON entry differs from the skill's command"

# The blankStopped reader: the skill's command, and each JSON entry (skill,
# README) decoded back to it.
template2='f="${CLAUDE_PLUGIN_DATA}/$CLAUDE_CODE_SESSION_ID/line"; [ -n "$(find "$f" -mmin -2 2>/dev/null)" ] && cat "$f"'
grep -qxF "$template2" "$root/skills/vargus-setup/SKILL.md" || fail "skill blankStopped command differs"
if ! command -v node >/dev/null; then fail "no node: the JSON entries are not checked"
else out=$(node --input-type=module -e '
import { readFileSync } from "node:fs"
const [root, want] = process.argv.slice(1)
const entry = file => {
  const line = readFileSync(root + "/" + file, "utf8").split("\n").find(l => l.trim().startsWith("\"command\": \"f="))
  try { return line && JSON.parse("{" + line.trim().replace(/,$/, "") + "}").command } catch (e) { return "not JSON: " + e.message }
}
if (entry("skills/vargus-setup/SKILL.md") !== want) console.log("skill blankStopped JSON entry differs")
const readme = want.replace("${CLAUDE_PLUGIN_DATA}", "$HOME/.claude/plugins/data/vargus-vargus")
if (entry("README.md") !== readme) console.log("README blankStopped JSON entry differs")
' "$root" "$template2" 2>&1) || { fail "node check: $out"; out=; }
[ -z "$out" ] || fail "$out"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
data="$tmp/data dir"
mkdir -p "$data/S1"
# A line with colour codes and wide characters, no trailing newline.
printf '\033[38;2;1;2;3m~/proj\033[0m | 中文 ✓' > "$data/S1/line"
cmd=$(printf '%s' "$template" | sed "s|\${CLAUDE_PLUGIN_DATA}|$data|")

for shell in sh bash; do
  command -v "$shell" >/dev/null || { echo "skip: no $shell"; continue; }
  out=$(CLAUDE_CODE_SESSION_ID=S1 "$shell" -c "$cmd"; echo "rc=$?")
  want=$(printf '\033[38;2;1;2;3m~/proj\033[0m | 中文 ✓rc=0')
  [ "$out" = "$want" ] || fail "$shell: present line: $out"
  out=$(CLAUDE_CODE_SESSION_ID=S2 "$shell" -c "$cmd" 2>&1; echo "rc=$?")
  [ "$out" = "rc=1" ] || fail "$shell: missing file: $out"
  out=$(CLAUDE_CODE_SESSION_ID= "$shell" -c "$cmd" 2>&1; echo "rc=$?")
  [ "$out" = "rc=1" ] || fail "$shell: empty id: $out"
done

# The blankStopped reader prints the file only while it is under two minutes
# old (GNU find; BSD find rounds the age up to whole minutes: under one).
cmd2=$(printf '%s' "$template2" | sed "s|\${CLAUDE_PLUGIN_DATA}|$data|")
ago() { date -d "-$1 seconds" +%Y%m%d%H%M.%S 2>/dev/null || date -v-"$1"S +%Y%m%d%H%M.%S; }
for shell in sh bash; do
  command -v "$shell" >/dev/null || continue
  touch "$data/S1/line"
  out=$(CLAUDE_CODE_SESSION_ID=S1 "$shell" -c "$cmd2"; echo "rc=$?")
  [ "$out" = "$want" ] || fail "$shell: blankStopped, fresh line: $out"
  touch -t "$(ago 180)" "$data/S1/line"
  out=$(CLAUDE_CODE_SESSION_ID=S1 "$shell" -c "$cmd2" 2>&1; echo "rc=$?")
  [ "$out" = "rc=1" ] || fail "$shell: blankStopped, 3 min old: $out"
  out=$(CLAUDE_CODE_SESSION_ID=S2 "$shell" -c "$cmd2" 2>&1; echo "rc=$?")
  [ "$out" = "rc=1" ] || fail "$shell: blankStopped, missing file: $out"
  out=$(CLAUDE_CODE_SESSION_ID= "$shell" -c "$cmd2" 2>&1; echo "rc=$?")
  [ "$out" = "rc=1" ] || fail "$shell: blankStopped, empty id: $out"
done

[ "$fails" -eq 0 ] && echo "reader: all pass" || exit 1
