#!/bin/bash
# Copie les fichiers de l'application web dans le dossier donné (embarqué ensuite par les apps Mac et iPhone).
# Usage : native/copy-web.sh <dossier>
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:?Usage : copy-web.sh <dossier>}"
[ -d "$DEST" ] && rm -r "$DEST"
mkdir -p "$DEST"
cp -R "$ROOT/index.html" "$ROOT/manifest.webmanifest" "$ROOT/css" "$ROOT/js" "$ROOT/fonts" "$ROOT/icons" "$DEST/"
