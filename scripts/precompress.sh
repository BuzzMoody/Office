#!/bin/sh
# Drop hosting notes the server never serves, then write .br and .gz copies next to
# the large static files. The server picks one per request from Accept-Encoding.
# Usage: precompress.sh <app dir>
set -eu
dir=$1
find "$dir" -type f \( -name '*.md' -o -name '_headers' -o -name '.htaccess' \) -delete
find "$dir" -type f \( -name '*.wasm' -o -name '*.js' -o -name '*.html' -o -name '*.svg' -o -name '*.ico' \) -size +1k -print0 \
  | xargs -0 -P "$(nproc)" -I{} sh -c 'gzip -9 -k -f "$1" && brotli -q 11 -k -f "$1"' _ {}
