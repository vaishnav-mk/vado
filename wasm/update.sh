#!/usr/bin/env bash
# Point build.sh at another official Valkey release and check the patches still
# apply. Does not build.
#
#   wasm/update.sh 9.2.0
#
# Rewrites VALKEY_VERSION and VALKEY_SHA256 in build.sh, then dry-runs every
# patch (patches/*.patch and patches/*/*.patch) against the new tree with the
# flags build.sh uses. Exits 1 if any patch fails; build.sh is updated anyway so
# the failing patches can be fixed against the new tree in wasm/.cache.
set -euo pipefail
export LC_ALL=C

VERSION="${1:?usage: update.sh <valkey version, e.g. 9.2.0>}"
# The version ends up in a URL, a sed replacement and a path.
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$ ]] || { echo "bad version: $VERSION" >&2; exit 2; }

HERE="$(cd "$(dirname "$0")" && pwd)"
CACHE="$HERE/.cache"
TGZ="$CACHE/valkey-$VERSION.tar.gz"
mkdir -p "$CACHE"
[ -f "$TGZ" ] || {
  curl -fsSL "https://github.com/valkey-io/valkey/archive/refs/tags/$VERSION.tar.gz" -o "$TGZ.part"
  mv "$TGZ.part" "$TGZ"
}
SUM=$( (sha256sum "$TGZ" 2>/dev/null || shasum -a 256 "$TGZ") | cut -d' ' -f1)

OLD=$(sed -n 's/^VALKEY_VERSION=//p' "$HERE/build.sh")
# sed -i differs between GNU and BSD; write a temp file instead.
sed -e "s/^VALKEY_VERSION=.*/VALKEY_VERSION=$VERSION/" \
  -e "s/^VALKEY_SHA256=.*/VALKEY_SHA256=$SUM/" "$HERE/build.sh" >"$HERE/build.sh.tmp"
cat "$HERE/build.sh.tmp" >"$HERE/build.sh" # keeps build.sh's mode
rm "$HERE/build.sh.tmp"
echo "build.sh: Valkey $OLD -> $VERSION (sha256 $SUM)"

# A fresh tree, the same way build.sh extracts it.
VK="$CACHE/valkey-$VERSION"
rm -rf "$VK"
mkdir -p "$VK"
tar -xzf "$TGZ" -C "$VK" --strip-components=1

# Patches apply in sequence, so each dry run must see the ones before it applied.
# Apply for real to a scratch copy; a failing patch is skipped and the rest
# still run, so one report lists every failure.
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cp -R "$VK" "$WORK/base"
fail=0
check() { # TREE PATCH...
  local tree=$1 p
  shift
  for p in "$@"; do
    # Not -s here: on failure the output names the file and hunk.
    if out=$(patch -p1 -F0 --dry-run -d "$tree" -i "$p" 2>&1); then
      patch -s -p1 -F0 -d "$tree" -i "$p"
      echo "ok    ${p#"$HERE"/}"
    else
      echo "FAIL  ${p#"$HERE"/}"
      printf '%s\n' "$out" | sed 's/^/      /'
      fail=1
    fi
  done
}
check "$WORK/base" "$HERE"/patches/*.patch
# Optional allocator patches go on top of the default set, as in build.sh.
for d in "$HERE"/patches/*/; do
  rm -rf "$WORK/opt"
  cp -R "$WORK/base" "$WORK/opt"
  check "$WORK/opt" "$d"*.patch
done

if [ "$fail" = 0 ]; then echo "all patches apply to Valkey $VERSION"; else echo "some patches do not apply to Valkey $VERSION" >&2; fi
exit "$fail"
