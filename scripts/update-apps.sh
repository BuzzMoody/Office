#!/usr/bin/env bash
# Refresh Docs/, Sheets/ and Slides/ from the latest upstream GitHub releases.
# Usage: scripts/update-apps.sh [docs|sheets|slides ...]   (default: all)
# Apps listed in scripts/pins.conf stay on their pinned release.
# Needs: gh (authenticated is not required for public repos), python3, sha256sum.
set -euo pipefail
cd "$(dirname "$0")/.."

declare -A REPO=( [Docs]=storytold/wordcraft [Sheets]=storytold/gridcraft [Slides]=storytold/deckcraft )
declare -A NAME=( [Docs]=wordcraft [Sheets]=gridcraft [Slides]=deckcraft )

want=("$@")
[ ${#want[@]} -eq 0 ] && want=(docs sheets slides)

# scripts/pins.conf holds "<slug>=<tag>" lines that override "latest".
pin_for() { sed -n "s/^$1=\\([^ #]*\\).*/\\1/p" scripts/pins.conf 2>/dev/null | head -n1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

for slug in "${want[@]}"; do
  dir=$(printf '%s' "${slug:0:1}" | tr a-z A-Z)${slug:1}
  repo=${REPO[$dir]:?unknown app $slug}
  name=${NAME[$dir]}
  tag=$(pin_for "$slug")
  if [ -n "$tag" ]; then echo "   (pinned to $tag in scripts/pins.conf)"; else tag=$(gh release view -R "$repo" --json tagName -q .tagName); fi
  ver=${tag#v}
  zip="$name-web-$ver.zip"
  echo "== $dir: $repo $tag"
  gh release download "$tag" -R "$repo" -p "$zip" -p SHA256SUMS.txt -D "$tmp/$dir" --clobber
  (cd "$tmp/$dir" && grep " $zip\$" SHA256SUMS.txt | sha256sum -c -)
  python3 -I -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$tmp/$dir/$zip" "$tmp/$dir/x"
  # Replace the directory contents wholesale so stale hashed files do not pile up.
  find "$dir" -mindepth 1 -delete
  cp -a "$tmp/$dir/x/$name-web-$ver/." "$dir/"
  printf 'repo=%s\ntag=%s\nasset=%s\nsha256=%s\n' "$repo" "$tag" "$zip" \
    "$(grep " $zip\$" "$tmp/$dir/SHA256SUMS.txt" | cut -d' ' -f1)" > "$dir/.upstream"
done

echo
echo "Updated. Now follow AGENTS.md > 'Upgrading the bundled apps' (re-test open/save with the shim)."
