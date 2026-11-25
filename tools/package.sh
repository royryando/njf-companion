#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(node -p "require('./manifest.json').version")
out="dist/njf-companion-${version}.zip"

mkdir -p dist
rm -f "$out"
zip -qr -X "$out" manifest.json src icons -x '*.DS_Store' 'icons/logo.png'
echo "$out"
unzip -l "$out" | tail -1
