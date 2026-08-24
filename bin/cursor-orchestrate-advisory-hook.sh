#!/bin/sh
# Cursor sessionStart frontend for orchestrate-advisory.
export DOTAGENTS_HOOK_HOST=cursor
invoked=$0
case "$invoked" in
  /*) ;;
  *) invoked="$(pwd -P)/$invoked" ;;
esac
source=$invoked
while [ -L "$source" ]; do
  target=$(/usr/bin/readlink "$source") || exit 0
  case "$target" in
    /*) source=$target ;;
    *) source="$(/usr/bin/dirname -- "$source")/$target" ;;
  esac
done
source_dir=$(CDPATH='' cd -P -- "$(/usr/bin/dirname -- "$source")" 2>/dev/null && pwd) || exit 0
sibling="$source_dir/orchestrate-advisory-hook.sh"
[ -f "$sibling" ] || exit 0
exec /bin/sh "$sibling"
