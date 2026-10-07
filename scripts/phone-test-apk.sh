#!/bin/bash
# On-device test using APKs built in the cloud (no Android build on this Mac):
#   bash scripts/phone-test-apk.sh
# Expects apks/nod.apk and apks/mock-wallet.apk in the project folder.
# Installs both on the emulator, starts the relay and the test driver, opens the app.
# Logs go to phone-test-logs/. Stop with Ctrl+C.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
LOG="$ROOT/phone-test-logs"
mkdir -p "$LOG"
rm -f "$LOG/results.jsonl" "$LOG/STATUS.txt"

say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG/script.log"; echo "[$(date +%H:%M:%S)] $*" > "$LOG/STATUS.txt"; }
die() { say "FAILED: $*"; exit 1; }

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
PACKAGE="com.ajkadri.nod"

say "APK run: checking tools and files"
command -v node >/dev/null || die "Node.js is not installed"
command -v adb >/dev/null || die "adb not found in $ANDROID_HOME/platform-tools"
[ -f apks/nod.apk ] || die "apks/nod.apk is missing"
[ -f apks/mock-wallet.apk ] || die "apks/mock-wallet.apk is missing"

if ! adb devices | grep -qE "\tdevice$"; then
  AVD="$(emulator -list-avds 2>/dev/null | grep -v '^INFO' | head -1)"
  [ -n "$AVD" ] || die "No Android device attached and no emulator exists"
  say "Starting emulator $AVD"
  nohup emulator -avd "$AVD" -no-snapshot-save > "$LOG/emulator.log" 2>&1 &
fi
say "Waiting for the device to boot"
adb wait-for-device
for _ in $(seq 1 180); do
  [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break
  sleep 2
done
[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] || die "Device did not finish booting"
if adb devices -l | grep -q emulator; then
  adb shell locksettings set-pin 1234 >> "$LOG/script.log" 2>&1 || true
fi

say "Installing the Mock MWA Wallet"
adb install -r apks/mock-wallet.apk >> "$LOG/script.log" 2>&1 || die "Could not install apks/mock-wallet.apk, see phone-test-logs/script.log"
say "Installing Nod"
adb install -r apks/nod.apk >> "$LOG/script.log" 2>&1 || die "Could not install apks/nod.apk, see phone-test-logs/script.log"
adb shell pm list packages > "$LOG/packages.txt" 2>&1

[ -d node_modules ] || npm install --no-audit --no-fund > "$LOG/npm-root.log" 2>&1 || die "npm install failed, see phone-test-logs/npm-root.log"

say "Starting the relay and the test driver"
adb reverse tcp:8787 tcp:8787 >> "$LOG/script.log" 2>&1 || die "adb reverse failed"
[ -f "$LOG/pids" ] && xargs kill < "$LOG/pids" 2>/dev/null
node relay/server.js > "$LOG/relay.log" 2>&1 &
RELAY_PID=$!
sleep 1
LOG_DIR="$LOG" node scripts/phone-driver.js > "$LOG/driver.out" 2>&1 &
DRIVER_PID=$!
echo "$RELAY_PID $DRIVER_PID" > "$LOG/pids"
trap 'kill $RELAY_PID $DRIVER_PID 2>/dev/null; rm -f "$LOG/pids"' EXIT

adb logcat -c 2>/dev/null
adb logcat -v time '*:E' ReactNativeJS:V > "$LOG/logcat.log" 2>&1 &
LOGCAT_PID=$!
trap 'kill $RELAY_PID $DRIVER_PID $LOGCAT_PID 2>/dev/null; rm -f "$LOG/pids"' EXIT

say "Opening Nod on the device"
adb shell monkey -p "$PACKAGE" -c android.intent.category.LAUNCHER 1 >> "$LOG/script.log" 2>&1 || say "WARNING: could not launch $PACKAGE"
echo "Relay and driver are running. Follow phone-test-logs/STATUS.txt. Leave this window open; Ctrl+C to stop."
wait $DRIVER_PID
say "Driver finished. Results are in phone-test-logs/results.jsonl"
