#!/bin/bash
# Prépare et ouvre le projet Xcode de Studio pour iPhone / iPad.
# Prérequis : Xcode (App Store). XcodeGen est installé automatiquement via Homebrew s'il manque.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NATIVE="$ROOT/native"

if ! xcodebuild -version >/dev/null 2>&1; then
  echo "✗ Xcode est nécessaire pour installer une app sur iPhone."
  echo "  1. Installe Xcode depuis l'App Store (gratuit)."
  echo "  2. Puis : sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
  exit 1
fi
if ! xcrun simctl list runtimes >/dev/null 2>&1 || ! xcodebuild -showsdks 2>/dev/null | grep -q "iphoneos"; then
  echo "✗ Le SDK iOS manque : Xcode → Settings → Components → iOS → Get."
  exit 1
fi
if ! command -v xcodegen >/dev/null 2>&1; then
  echo "→ Installation de XcodeGen (génère le projet Xcode)"
  # Un terminal lancé sous Rosetta (x86_64) sur un Mac Apple Silicon : Homebrew doit tourner en ARM.
  if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ]; then
    arch -arm64 /opt/homebrew/bin/brew install xcodegen
  else
    brew install xcodegen
  fi
  export PATH="/opt/homebrew/bin:$PATH"
fi

echo "→ Fichiers de l'application"
"$NATIVE/copy-web.sh" "$NATIVE/build/web"

echo "→ Projet Xcode"
cd "$NATIVE"
xcodegen generate --spec project.yml --quiet
open "$NATIVE/Studio.xcodeproj"

cat <<'TXT'
✓ Projet ouvert dans Xcode. Pour installer sur ton iPhone :
  1. Branche l'iPhone (câble), et active le Mode développeur : Réglages → Confidentialité et sécurité.
  2. Dans Xcode : cible « Studio » → Signing & Capabilities → Team : ton identifiant Apple.
     (Si l'identifiant de paquet est refusé, remplace app.carnet.notes par un nom à toi.)
  3. En haut, choisis ton iPhone comme destination, puis ▶︎ (⌘R).
  4. Sur l'iPhone, la première fois : Réglages → Général → VPN et gestion de l'appareil → faire confiance.
Avec un identifiant Apple gratuit, l'app doit être réinstallée depuis Xcode tous les 7 jours
(limite d'Apple) ; avec le programme développeur (99 €/an), elle reste valable un an.
TXT
