#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../icons"
tmp=$(mktemp -t njf-icon).png
sips -s format png -c 460 460 logo.png --out "$tmp" >/dev/null
for size in 16 32 48 128; do
  sips -z "$size" "$size" "$tmp" --out "icon${size}.png" >/dev/null
  echo "icons/icon${size}.png"
done
rm -f "$tmp"
