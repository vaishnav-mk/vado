#!/usr/bin/env bash
# See https://vado-docs.vaishnav.one/docs/wasm
set -euo pipefail
export LC_ALL=C
VERSION="${1:?usage: update.sh <valkey version, e.g. 9.2.0>}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$ ]] || { echo "bad version: $VERSION" >&2; exit 2; }
HERE="$(cd "$(dirname "$0")" && pwd)"
CACHE="$HERE/../.cache" TGZ="$HERE/../.cache/valkey-$VERSION.tar.gz"

mkdir -p "$CACHE"
[ -f "$TGZ" ] || { curl -fsSL "https://github.com/valkey-io/valkey/archive/refs/tags/$VERSION.tar.gz" -o "$TGZ.part" && mv "$TGZ.part" "$TGZ"; }
SUM=$( (sha256sum "$TGZ" 2>/dev/null || shasum -a 256 "$TGZ") | cut -d' ' -f1)
OLD=$(sed -n 's/^VALKEY_VERSION=//p' "$HERE/build.sh")
sed -e "s/^VALKEY_VERSION=.*/VALKEY_VERSION=$VERSION/" -e "s/^VALKEY_SHA256=.*/VALKEY_SHA256=$SUM/" "$HERE/build.sh" >"$HERE/build.sh.tmp"
cat "$HERE/build.sh.tmp" >"$HERE/build.sh" && rm "$HERE/build.sh.tmp" # cat keeps build.sh's mode
echo "build.sh: Valkey $OLD -> $VERSION (sha256 $SUM)"

# Each patch applies on top of the ones before it; skip failures so one run lists them all.
TREE=$(mktemp -d)
trap 'rm -rf "$TREE"' EXIT
tar -xzf "$TGZ" -C "$TREE" --strip-components=1
fail=0
for p in "$HERE"/patches/*.patch; do
  if out=$(patch -p1 -F0 --dry-run -d "$TREE" -i "$p" 2>&1); then
    patch -s -p1 -F0 -d "$TREE" -i "$p" && echo "ok    $(basename "$p")"
  else
    echo "FAIL  $(basename "$p")" && printf '%s\n' "$out" | sed 's/^/      /' && fail=1
  fi
done
[ "$fail" = 0 ] && echo "all patches apply to Valkey $VERSION" || echo "some patches do not apply to Valkey $VERSION" >&2
exit "$fail"
