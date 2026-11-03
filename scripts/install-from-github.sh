#!/usr/bin/env bash
# dsh-local-delegate GitHub installer for macOS / Linux.
#
# Downloads a Release zip (or the source archive), validates it, and copies it
# into ~/.dsh/local-plugins/dsh-local-delegate-<version>. Registering the bundle
# stays with DSH: in a DSH session ask the agent to run
#   plugin_manager action=install_bundle target=<printed directory>
#
# Usage:
#   bash scripts/install-from-github.sh [latest|v0.4.1] [install-root]
#   FORCE=1 bash scripts/install-from-github.sh v0.4.1
set -euo pipefail

REPO="MythGreenLand/dsh-local-delegate"
VERSION="${1:-latest}"
INSTALL_ROOT="${2:-$HOME/.dsh/local-plugins}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "error: required command not found: $1" >&2; exit 1; }; }
need curl
need unzip
need tar

api="https://api.github.com/repos/$REPO"
if [ "$VERSION" = "latest" ]; then
  tag="$(curl -fsSL "$api/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
  if [ -z "$tag" ]; then
    echo "warning: cannot resolve the latest release; using the main branch archive" >&2
    tag=""
  fi
else
  case "$VERSION" in
    v*) tag="$VERSION" ;;
    *) tag="v$VERSION" ;;
  esac
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/dsh-local-delegate.XXXXXX")"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

downloaded=""
if [ -n "$tag" ]; then
  version="${tag#v}"
  asset="dsh-local-delegate-v${version}.zip"
  url="https://github.com/$REPO/releases/download/$tag/$asset"
  if curl -fL --retry 2 -o "$tmp/plugin.zip" "$url" 2>/dev/null; then
    downloaded="$tmp/plugin.zip"
    echo "download   : $url"
  else
    fallback="https://github.com/$REPO/archive/refs/tags/$tag.zip"
    echo "warning: release asset missing, downloading $fallback" >&2
    curl -fL --retry 2 -o "$tmp/plugin.zip" "$fallback"
    downloaded="$tmp/plugin.zip"
  fi
else
  url="https://github.com/$REPO/archive/refs/heads/main.zip"
  curl -fL --retry 2 -o "$tmp/plugin.zip" "$url"
  downloaded="$tmp/plugin.zip"
  echo "download   : $url"
fi

mkdir -p "$tmp/extract"
unzip -q "$downloaded" -d "$tmp/extract"

manifest="$(find "$tmp/extract" -name package.json -maxdepth 4 -type f -exec sh -c 'test -f "$(dirname "$1")/index.js" && echo "$1"' _ {} \; | head -1)"
if [ -z "$manifest" ]; then
  echo "error: downloaded archive does not look like dsh-local-delegate (package.json next to index.js not found)" >&2
  exit 1
fi
plugin_dir="$(dirname "$manifest")"
version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$manifest" | head -1)"
name="$(sed -n 's/.*"name": *"\([^"]*\)".*/\1/p' "$manifest" | head -1)"
if [ "$name" != "dsh-local-delegate" ]; then
  echo "error: unexpected package name in the archive: $name" >&2
  exit 1
fi
if [ -z "$version" ]; then
  echo "error: the archive package.json has no version" >&2
  exit 1
fi
if [ -n "$tag" ] && [ "$version" != "${tag#v}" ]; then
  echo "error: version mismatch: release $tag contains dsh-local-delegate $version" >&2
  exit 1
fi

target="$INSTALL_ROOT/dsh-local-delegate-$version"
if [ -e "$target" ]; then
  if [ "${FORCE:-0}" != "1" ]; then
    echo "error: install directory already exists: $target" >&2
    echo "       re-run with FORCE=1 to replace it, or pass a different install root." >&2
    exit 1
  fi
  echo "replacing   : $target"
  rm -rf "$target"
fi
mkdir -p "$target"
cp -R "$plugin_dir"/. "$target"/
for required in index.js client.js package.json cordis.patch.yml; do
  if [ ! -f "$target/$required" ]; then
    echo "error: installed copy is missing $required" >&2
    exit 1
  fi
done

cat <<EOF

installed  : $target
version    : dsh-local-delegate $version

Next (run in a DSH session; ask your agent):
  # upgrading an existing install first:
  plugin_manager action=remove_bundle target=dsh-local-delegate
  plugin_manager action=install_bundle target=$target

Then refresh the Web GUI. Verify Settings -> 本地模型 shows the
「本地 AI 介入程度」and「SlaveAgentTeams」cards, the composer shows
「本地 AI：默认 ▾」, and local_health reports the new version.
EOF
