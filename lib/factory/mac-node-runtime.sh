#!/usr/bin/env bash
# Factory standard Node for product CI on the Mac runner, in non-overwriting generations under
# <base>/factory-node[.N]/v<version>-<sha16>/gN (base defaults to /Users/Shared, 1777 sticky).
# ESET allows inbound LAN per exact executable path and its chooser cannot reach the 0700 runner home.
# No exclusive cache or prior-consumer exit handoff exists, so a tree another job may run is never
# replaced, renamed over or deleted: a generation is reserved with mkdir, built in place, published by a marker.
# Generalised from Lattice scripts/ci-macos-node-runtime.sh @5751bea2. Contract: docs/feature-map/mac-node-runtime.md.
# Host copy: /usr/local/libexec/dotagents/factory-node-runtime.sh <version> <sha256> (the pair must be pinned below)
set -euo pipefail
umask 022
version=${1:?node version required}
sha256=${2:?official darwin-arm64 archive sha256 required}
# Pinned factory Nodes: one "<version> <official darwin-arm64 archive sha256>" pattern per line.
case "$version $sha256" in
  "24.22.0 6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5") ;;
  *) echo "factory-node-runtime: $version $sha256 is not a pinned factory Node" >&2; exit 2 ;;
esac
base=${FACTORY_NODE_BASE:-/Users/Shared}
case "$base" in /*) ;; *) exit 2 ;; esac
[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]]
identity="v$version-${sha256:0:16}"
uid=$(id -u)
marker_line="version=$version sha256=$sha256 uid=$uid"

# Called under `!`/`if`, where errexit is off: every check must return on its own.
verify() {
  [[ $("$1/bin/node" -p 'process.versions.node' 2>/dev/null) == "$version" ]] || return 1
  "$1/bin/node" -e 'const fs = require("node:fs"), assert = require("node:assert/strict"), info = fs.statSync(process.execPath); assert.equal(info.uid, process.getuid()); assert.equal(info.mode & 0o022, 0);'
}

# A root is used only if it is a real directory owned by this UID with no group/other write.
safe_root() {
  [[ -d $1 && ! -L $1 ]] || return 1
  [[ $(stat -f %u "$1") == "$uid" ]] || return 1
  (( (8#$(stat -f %Lp "$1") & 8#022) == 0 ))
}

# Numeric suffixes of existing "<prefix><N>" entries, ascending.
suffixes() {
  local entry
  for entry in "$1"*; do
    [[ -e $entry || -L $entry ]] || continue
    entry=${entry#"$1"}
    [[ $entry =~ ^[0-9]+$ ]] && printf '%s\n' "$entry"
  done | sort -n
}

# Unsafe (squatted) root names are skipped and never modified.
root=
for n in 1 $(suffixes "$base/factory-node."); do
  name="$base/factory-node"; [[ $n == 1 ]] || name+=".$n"
  if safe_root "$name"; then root=$name; break; fi
done
if [[ -z $root ]]; then
  n=$(suffixes "$base/factory-node." | tail -n 1); n=$(( ${n:-1} + 1 ))
  [[ -e $base/factory-node || -L $base/factory-node ]] || n=1
  for (( ; ; n++ )); do
    name="$base/factory-node"; [[ $n == 1 ]] || name+=".$n"
    if mkdir -m 755 "$name" 2>/dev/null || safe_root "$name"; then root=$name; break; fi
    [[ -e $name || -L $name ]] || { echo "cannot create runtime root $name" >&2; exit 1; }
  done
fi

identity_dir="$root/$identity"
mkdir -m 755 "$identity_dir" 2>/dev/null || [[ -d $identity_dir && ! -L $identity_dir ]]

selected=
for n in $(suffixes "$identity_dir/g"); do
  candidate="$identity_dir/g$n"
  [[ -f $candidate/.factory-complete && $(<"$candidate/.factory-complete") == "$marker_line" ]] || continue
  if verify "$candidate" 2>/dev/null; then selected=$candidate; break; fi
  echo "complete generation $candidate failed verification; left untouched" >&2
done

if [[ -z $selected ]]; then
  n=$(suffixes "$identity_dir/g" | tail -n 1); n=$(( ${n:-0} + 1 ))
  until mkdir -m 755 "$identity_dir/g$n" 2>/dev/null; do
    [[ -e $identity_dir/g$n ]] || { echo "cannot reserve $identity_dir/g$n" >&2; exit 1; }
    n=$(( n + 1 ))
  done
  generation="$identity_dir/g$n"
  echo "reserved $generation" >&2
  # Only this process's own unpublished generation is removed; nothing else ever is.
  trap 'rm -rf "$generation"' EXIT
  archive="$generation/node.tar.gz"
  curl --fail --location --silent --show-error --output "$archive" "https://nodejs.org/dist/v$version/node-v$version-darwin-arm64.tar.gz"
  printf '%s  %s\n' "$sha256" "$archive" | shasum --algorithm 256 --check --status
  tar --extract --gzip --file "$archive" --directory "$generation" --strip-components=1 --no-same-owner
  rm "$archive"
  verify "$generation"
  printf '%s\n' "$marker_line" > "$generation/.factory-complete.tmp"
  mv -f "$generation/.factory-complete.tmp" "$generation/.factory-complete"
  trap - EXIT
  selected=$generation
fi

verify "$selected"
"$selected/bin/node" -e '
  const fs = require("node:fs");
  const info = fs.statSync(process.execPath);
  console.log(JSON.stringify({ node: process.versions.node, execPath: process.execPath,
    identity: process.argv[1], generation: process.argv[2], sha256: process.argv[3],
    uid: info.uid, mode: (info.mode & 0o7777).toString(8), marker: process.argv[4] }));
' "$identity" "$(basename "$selected")" "$sha256" "$selected/.factory-complete"
if [[ -n ${GITHUB_OUTPUT:-} ]]; then
  printf 'directory=%s\nnode=%s\n' "$selected" "$selected/bin/node" >> "$GITHUB_OUTPUT"
fi
