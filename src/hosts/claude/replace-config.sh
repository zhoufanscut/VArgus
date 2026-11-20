#!/bin/sh
# A Claude picker edit stages a replacement before the native save. Publish
# only after Claude accepts it and while the original bytes still match.
set -eu
operation=$1
file=$2
stage=$file.$3.vargus-tmp
lock=$file.vargus-lock
umask 077
trap 'exit 1' HUP INT TERM
clean_stage() { rm -f "$stage/before" "$stage/after"; rmdir "$stage"; }

case "$operation" in
  save)
    # The private picker backup can be the first file in the plugin data folder.
    mkdir -p "${file%/*}"
    sh "$0" prepare "$file" "$3" "$4"
    exec sh "$0" commit "$file" "$3"
    ;;
  prepare)
    mkdir "$stage"
    trap 'clean_stage' EXIT
    size=$4
    if [ "$size" -ge 0 ]; then
      dd bs=1 count="$size" of="$stage/before" 2>/dev/null
      cp -p "$file" "$stage/after"
    fi
    cat > "$stage/after"
    trap - EXIT
    ;;
  commit)
    trap 'clean_stage' EXIT
    mkdir "$lock" 2>/dev/null || { echo "Cannot lock $file for editing." >&2; exit 75; }
    trap 'rmdir "$lock"; clean_stage' EXIT
    if [ -f "$stage/before" ]; then
      cmp -s "$stage/before" "$file" || exit 75
    else
      [ ! -e "$file" ] && [ ! -L "$file" ] || exit 75
    fi
    mv -f "$stage/after" "$file"
    ;;
  cancel) [ ! -d "$stage" ] || clean_stage ;;
  *) exit 1 ;;
esac
