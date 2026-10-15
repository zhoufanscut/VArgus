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

[ "$fails" -eq 0 ] && echo "reader: all pass" || exit 1
