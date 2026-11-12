#!/bin/bash
# Compile Studio et l'installe directement sur l'iPhone branché, sans ouvrir Xcode.
# Seul prérequis (une fois) : ton identifiant Apple ajouté dans Xcode → Settings → Accounts.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NATIVE="$ROOT/native"
BUILD="$NATIVE/build"
export PATH="/opt/homebrew/bin:$PATH"

# 1. Équipe de signature (ton compte Apple gratuit)
TEAM="${CARNET_TEAM:-}"
if [ -z "$TEAM" ]; then
  TEAM="$(defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier 2>/dev/null | grep -Eo 'teamID = [A-Z0-9]{10}' | head -1 | awk '{print $3}' || true)"
fi
if [ -z "$TEAM" ]; then
  TEAM="$(defaults read com.apple.dt.Xcode IDEProvisioningTeams 2>/dev/null | grep -Eo 'teamID = [A-Z0-9]{10}' | head -1 | awk '{print $3}' || true)"
fi
if [ -z "$TEAM" ]; then
  echo "✗ Aucun compte Apple trouvé dans Xcode. Une seule fois :"
  echo "  open -a Xcode  →  menu Xcode → Settings… → Accounts → + → Apple ID"
  echo "  puis relance ./native/iphone.sh"
  exit 1
fi

# 2. iPhone branché
DEVICE="$(xcrun devicectl list devices 2>/dev/null | awk '/iPhone|iPad/ && /connected|available/ {print $3; exit}')"
if [ -z "$DEVICE" ]; then
  echo "✗ Aucun iPhone détecté : branche-le en câble, déverrouille-le, réponds « Se fier »."
  exit 1
fi

# Identifiant unique par compte, pour ne jamais être refusé par Apple
BUNDLE="app.carnet.notes.$(echo "$TEAM" | tr 'A-Z' 'a-z')"

echo "→ Fichiers de l'application"
[ -d "$BUILD/web" ] && rm -r "$BUILD/web"
mkdir -p "$BUILD/web"
cp -R "$ROOT/index.html" "$ROOT/manifest.webmanifest" "$ROOT/css" "$ROOT/js" "$ROOT/fonts" "$ROOT/icons" "$BUILD/web/"

command -v xcodegen >/dev/null || {
  if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ]; then arch -arm64 /opt/homebrew/bin/brew install xcodegen; else brew install xcodegen; fi
}
(cd "$NATIVE" && xcodegen generate --spec project.yml --quiet)

echo "→ Compilation (1 à 2 minutes la première fois)"
xcodebuild -project "$NATIVE/Studio.xcodeproj" -scheme Studio -configuration Release \
  -destination "id=$DEVICE" -derivedDataPath "$BUILD/dd" -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM" PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE" CODE_SIGN_STYLE=Automatic \
  -quiet build

echo "→ Installation sur l'iPhone"
xcrun devicectl device install app --device "$DEVICE" "$BUILD/dd/Build/Products/Release-iphoneos/Studio.app"

cat <<'TXT'
✓ Studio est sur ton iPhone.
  Première fois seulement : si l'app refuse de s'ouvrir,
  Réglages → Général → VPN et gestion de l'appareil → ton identifiant → Faire confiance.
  Si « Mode développeur » est demandé : Réglages → Confidentialité et sécurité → Mode développeur.
Tous les 7 jours (compte Apple gratuit) : rebranche l'iPhone et relance ./native/iphone.sh.
TXT
