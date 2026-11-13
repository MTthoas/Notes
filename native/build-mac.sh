#!/bin/bash
# Construit Studio.app pour macOS (Apple Silicon et Intel) avec les seuls outils en ligne de commande d'Apple.
#   ./native/build-mac.sh            -> native/build/Studio.app
#   ./native/build-mac.sh --install  -> et le copie dans /Applications
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/native/build"
APP="$BUILD/Studio.app"
VERSION="$(date +%Y.%m.%d)"

echo "→ Préparation"
[ -d "$APP" ] && rm -r "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "→ Fichiers de l'application"
"$ROOT/native/copy-web.sh" "$APP/Contents/Resources/web"

echo "→ Compilation (Swift)"
SOURCES=("$ROOT"/native/Shared/*.swift "$ROOT"/native/macOS/*.swift)
for ARCH in arm64 x86_64; do
  swiftc -O -target "$ARCH-apple-macos13.0" -parse-as-library -module-name Studio \
    -framework AppKit -framework WebKit -framework UserNotifications -framework Speech -framework AVFoundation -framework LocalAuthentication -framework Security "${SOURCES[@]}" -o "$BUILD/Studio-$ARCH"
done
lipo -create "$BUILD/Studio-arm64" "$BUILD/Studio-x86_64" -output "$APP/Contents/MacOS/Studio"
rm "$BUILD/Studio-arm64" "$BUILD/Studio-x86_64"

echo "→ Icône"
ICONSET="$BUILD/Studio.iconset"
[ -d "$ICONSET" ] && rm -r "$ICONSET"
mkdir -p "$ICONSET"
for S in 16 32 128 256 512; do
  sips -z "$S" "$S" "$ROOT/native/macOS/icon-1024.png" --out "$ICONSET/icon_${S}x${S}.png" >/dev/null
  D=$((S * 2))
  sips -z "$D" "$D" "$ROOT/native/macOS/icon-1024.png" --out "$ICONSET/icon_${S}x${S}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Studio.icns"
rm -r "$ICONSET"

echo "→ Info.plist"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Studio</string>
  <key>CFBundleDisplayName</key><string>Studio</string>
  <key>CFBundleIdentifier</key><string>app.carnet.notes</string>
  <key>CFBundleExecutable</key><string>Studio</string>
  <key>CFBundleIconFile</key><string>Studio</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleDevelopmentRegion</key><string>fr</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>© 2026 Matthias · Logiciel libre sous licence GNU AGPL-3.0. Vos notes restent sur vos appareils.</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>NSFaceIDUsageDescription</key><string>Studio utilise Face ID pour ouvrir ton coffre chiffré.</string>
  <key>NSMicrophoneUsageDescription</key><string>Studio utilise le micro pour tes notes vocales. La transcription est faite sur cet appareil.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>Studio transcrit tes notes vocales sur cet appareil, sans rien envoyer en ligne.</string>
  <key>NSLocalNetworkUsageDescription</key><string>Studio se connecte directement à vos autres appareils sur le même réseau pour synchroniser vos notes.</string>
</dict></plist>
PLIST

echo "→ Signature locale"
codesign --force --sign - --timestamp=none "$APP" >/dev/null

echo "✓ $APP"
if [ "${1:-}" = "--install" ]; then
  [ -d "/Applications/Studio.app" ] && rm -r "/Applications/Studio.app"
  [ -d "/Applications/Marge.app" ] && rm -r "/Applications/Marge.app" # nom précédent
  [ -d "/Applications/Carnet.app" ] && rm -r "/Applications/Carnet.app" # ancien nom de l'app (mêmes données : l'identifiant n'a pas changé)
  cp -R "$APP" /Applications/
  echo "✓ Installé dans /Applications/Studio.app"
fi
