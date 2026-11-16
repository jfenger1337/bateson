#!/bin/bash
# Build bateson.app and install it to ~/Applications. No Xcode project: swiftc, a plist and an ad-hoc signature.
set -euo pipefail
cd "$(dirname "$0")"
APP=build/bateson.app
rm -rf build && mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

swiftc -O -parse-as-library -target "$(uname -m)-apple-macos14.0" \
  -framework AppKit -framework WebKit -framework Carbon -framework UserNotifications \
  -o "$APP/Contents/MacOS/Bateson" Sources/*.swift
cp Info.plist "$APP/Contents/Info.plist"
# The notification sound: a short rising pop, made for bateson (sine, 320 to 580 Hz, 0.2 s).
cp Notify.wav "$APP/Contents/Resources/Notify.wav"

# The icon: Bateson's mark in ink on the highlighter. AppIcon.png is AppIcon.svg rendered at 1024; render it
# again after changing the SVG (its inked edge is an SVG filter), e.g. with headless Chrome:
#   chrome --headless --default-background-color=00000000 --window-size=1024,1024 --screenshot=AppIcon.png AppIcon.svg
ICONSET=build/AppIcon.iconset && mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s AppIcon.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) AppIcon.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

codesign --force --sign - "$APP" >/dev/null 2>&1

if [ "${1:-}" = "--install" ]; then
  mkdir -p ~/Applications
  pkill -x Bateson 2>/dev/null || true
  rm -rf ~/Applications/bateson.app
  cp -R "$APP" ~/Applications/
  echo "Installed ~/Applications/bateson.app"
else
  echo "Built $APP"
fi
