#!/bin/sh
# Builds the release APK into dist/fantasybug.apk, signed with your key when keystore.properties names
# one (docs/RELEASING.md), else with the debug key.
#
#   [JAVA_HOME=/path/to/jdk-21] [ANDROID_HOME=/path/to/android-sdk] sh scripts/build-apk.sh
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if [ -z "${ANDROID_HOME:-}" ]; then
  for d in "$HOME/Library/Android/sdk" "$HOME/Android/Sdk" "/opt/android-sdk"; do
    [ -d "$d/platforms" ] && ANDROID_HOME=$d && break
  done
fi
[ -n "${ANDROID_HOME:-}" ] || { echo "Set ANDROID_HOME to your Android SDK."; exit 1; }
export ANDROID_HOME
if [ -z "${JAVA_HOME:-}" ] && [ -x /usr/libexec/java_home ]; then
  JAVA_HOME=$(/usr/libexec/java_home -v 21 2>/dev/null || true)
fi
[ -n "${JAVA_HOME:-}" ] || { echo "Set JAVA_HOME to a JDK 21."; exit 1; }
export JAVA_HOME
[ -f "$ROOT/keystore.properties" ] || echo "No keystore.properties: signing with the debug key (fine for testing, not for a release)."
"$ROOT/gradlew" -p "$ROOT" --no-daemon -q clean assembleRelease
mkdir -p "$ROOT/dist"
cp "$ROOT/app/build/outputs/apk/release/app-release.apk" "$ROOT/dist/fantasybug.apk"
echo "Built: $ROOT/dist/fantasybug.apk  sha256 $(shasum -a 256 "$ROOT/dist/fantasybug.apk" | cut -d' ' -f1)"
