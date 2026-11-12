#!/bin/bash
# Construit l'application web (TypeScript -> dist/) puis la copie dans le dossier donné,
# embarqué ensuite par les apps Mac et iPhone.
# Usage : native/copy-web.sh <dossier>
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:?Usage : copy-web.sh <dossier>}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js est nécessaire pour construire l'app (https://nodejs.org ou : brew install node)." >&2
  exit 1
fi
( cd "$ROOT" && { [ -d node_modules/esbuild ] || npm ci --no-audit --no-fund --silent; } && node scripts/build.ts )
[ -d "$DEST" ] && rm -r "$DEST"
mkdir -p "$DEST"
cp -R "$ROOT/dist/." "$DEST/"
# Les cartes de source ne servent qu'au débogage : on ne les embarque pas.
find "$DEST" -name '*.map' -delete
