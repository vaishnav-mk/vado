#!/usr/bin/env bash
# Pin a new upstream release in <server>/build.sh and packages/box/Dockerfile, and check that its patches still apply.
# See https://vado-docs.vaishnav.one/docs/wasm
usage="usage: update.sh <valkey|redis> <version, e.g. 9.2.0>"
SERVER="${1:?$usage}" VERSION="${2:?$usage}"
case "$SERVER" in
  valkey) NAME=Valkey REPO=valkey-io/valkey ;;
  redis) NAME=Redis REPO=redis/redis ;;
  *) echo "$usage" >&2 && exit 2 ;;
esac
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$ ]] || { echo "bad version: $VERSION" >&2; exit 2; }
HERE="$(cd "$(dirname "$0")/$SERVER" && pwd)"
WASI_SDK="${WASI_SDK:-unused}" # common.sh wants it; nothing here compiles
. "$HERE/../common.sh"

VAR=$(echo "$SERVER" | tr a-z A-Z) BUILD="$HERE/build.sh"
SUM=$(download "$SERVER-$VERSION" "https://github.com/$REPO/archive/refs/tags/$VERSION.tar.gz")
OLD=$(sed -n "s/^${VAR}_VERSION=//p" "$BUILD")
sed -e "s/^${VAR}_VERSION=.*/${VAR}_VERSION=$VERSION/" -e "s/^${VAR}_SHA256=.*/${VAR}_SHA256=$SUM/" "$BUILD" >"$BUILD.tmp"
cat "$BUILD.tmp" >"$BUILD" && rm "$BUILD.tmp" # cat keeps build.sh's mode
echo "$SERVER/build.sh: $NAME $OLD -> $VERSION (sha256 $SUM)"
BOX="$HERE/../../box/Dockerfile"
sed -e "s/^ARG ${VAR}_VERSION=.*/ARG ${VAR}_VERSION=$VERSION/" -e "s/^ARG ${VAR}_SHA256=.*/ARG ${VAR}_SHA256=$SUM/" "$BOX" >"$BOX.tmp"
cat "$BOX.tmp" >"$BOX" && rm "$BOX.tmp"
echo "box/Dockerfile: $NAME $VERSION"
FLAVOURS="$HERE/../../server/src/catalog/flavours.ts"
sed -e "/^export const VERSIONS/,/^};/ s/^  $SERVER: .*/  $SERVER: \"$VERSION\",/" "$FLAVOURS" >"$FLAVOURS.tmp"
cat "$FLAVOURS.tmp" >"$FLAVOURS" && rm "$FLAVOURS.tmp"
echo "server/src/catalog/flavours.ts: $NAME $VERSION"

# Each patch applies on top of the ones before it; skip failures so one run lists them all.
TREE=$(mktemp -d)
trap 'rm -rf "$TREE"' EXIT
tar -xzf "$CACHE/$SERVER-$VERSION.tar.gz" -C "$TREE" --strip-components=1
fail=0
for p in "$HERE"/patches/*.patch; do
  if out=$(patch -p1 -F0 --dry-run -d "$TREE" -i "$p" 2>&1); then
    patch -s -p1 -F0 -d "$TREE" -i "$p" && echo "ok    $(basename "$p")"
  else
    echo "FAIL  $(basename "$p")" && printf '%s\n' "$out" | sed 's/^/      /' && fail=1
  fi
done
[ "$fail" = 0 ] && echo "all patches apply to $NAME $VERSION" || echo "some patches do not apply to $NAME $VERSION" >&2
exit "$fail"
