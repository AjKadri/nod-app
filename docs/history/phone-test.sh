#!/bin/bash
# On-device feasibility test, one command:   bash scripts/phone-test.sh
#
# What it does on this Mac:
#   1. starts the Android emulator (if no device is attached)
#   2. installs dependencies, builds and installs the Mock MWA Wallet
#   3. starts the relay and a test driver that sends approval requests
#   4. builds, installs and opens the app (first build takes 10 to 25 minutes)
# Everything is logged in phone-test-logs/. Stop with Ctrl+C.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
LOG="$ROOT/phone-test-logs"
mkdir -p "$LOG"
rm -f "$LOG/results.jsonl" "$LOG/STATUS.txt"

say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG/script.log"; echo "[$(date +%H:%M:%S)] $*" > "$LOG/STATUS.txt"; }
die() { say "FAILED: $*"; exit 1; }

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
if [ -z "${JAVA_HOME:-}" ] && [ -d "/Applications/Android Studio.app/Contents/jbr/Contents/Home" ]; then
  export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
fi
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:${JAVA_HOME:+$JAVA_HOME/bin:}$PATH"

# The Android build tools used here (Gradle 8.13 and 9.0) do not run on Java 22 or newer,
# and current Android Studio bundles Java 25. Use a private JDK 17 in .jdk/ when needed.
java_major() { java -version 2>&1 | head -1 | sed -E 's/[^"]*"([0-9]+).*/\1/'; }
if [ ! -x "$ROOT/.jdk/Contents/Home/bin/java" ]; then
  MAJOR="$(java_major 2>/dev/null || echo 0)"
  if ! [ "$MAJOR" -ge 17 ] 2>/dev/null || [ "$MAJOR" -gt 21 ]; then
    say "Java ${MAJOR} does not work with this build. Downloading JDK 17 into .jdk/ (about 190 MB, one time)"
    ARCH="$(uname -m)"; [ "$ARCH" = "arm64" ] && ARCH=aarch64 || ARCH=x64
    curl -sSfL --retry 3 -o "$LOG/jdk17.tar.gz" "https://api.adoptium.net/v3/binary/latest/17/ga/mac/$ARCH/jdk/hotspot/normal/eclipse" 2>> "$LOG/script.log" \
      || die "Could not download JDK 17"
    rm -rf "$ROOT/.jdk" && mkdir -p "$ROOT/.jdk" && tar xzf "$LOG/jdk17.tar.gz" --strip-components 1 -C "$ROOT/.jdk" || die "Could not unpack JDK 17"
    rm -f "$LOG/jdk17.tar.gz"
  fi
fi
if [ -x "$ROOT/.jdk/Contents/Home/bin/java" ]; then
  export JAVA_HOME="$ROOT/.jdk/Contents/Home"
  export PATH="$JAVA_HOME/bin:$PATH"
fi

say "Checking tools"
{
  echo "node: $(node -v 2>&1)"; echo "npm: $(npm -v 2>&1)"; echo "git: $(git --version 2>&1)"
  echo "java: $(java -version 2>&1 | head -1)"; echo "JAVA_HOME=${JAVA_HOME:-unset}"; echo "ANDROID_HOME=$ANDROID_HOME"
  echo "adb: $(adb version 2>&1 | head -1)"; echo "avds: $(emulator -list-avds 2>&1 | tr '\n' ' ')"
  echo "sdk: $(ls "$ANDROID_HOME" 2>&1 | tr '\n' ' ')"; echo "platforms: $(ls "$ANDROID_HOME/platforms" 2>&1 | tr '\n' ' ')"
  echo "build-tools: $(ls "$ANDROID_HOME/build-tools" 2>&1 | tr '\n' ' ')"; echo "macOS: $(sw_vers -productVersion 2>&1) $(uname -m)"
  echo "free disk: $(df -h "$HOME" | tail -1 | awk '{print $4}')"
} > "$LOG/environment.txt" 2>&1
cat "$LOG/environment.txt"
command -v node >/dev/null || die "Node.js is not installed (need 20 or newer)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js $NODE_MAJOR is too old (need 20 or newer)"
command -v adb >/dev/null || die "adb not found in $ANDROID_HOME/platform-tools"
command -v java >/dev/null || die "No Java found. Is Android Studio in /Applications?"

if ! adb devices | grep -qE "\tdevice$"; then
  AVD="$(emulator -list-avds 2>/dev/null | grep -v '^INFO' | head -1)"
  [ -n "$AVD" ] || die "No Android device attached and no emulator exists. Create one in Android Studio > Virtual Device Manager."
  say "Starting emulator $AVD"
  nohup emulator -avd "$AVD" -no-snapshot-save > "$LOG/emulator.log" 2>&1 &
fi
say "Waiting for the device to boot (up to 6 minutes)"
adb wait-for-device
for _ in $(seq 1 180); do
  [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break
  sleep 2
done
[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] || die "Device did not finish booting"
adb devices -l >> "$LOG/environment.txt"
echo "android: $(adb shell getprop ro.build.version.release | tr -d '\r') api $(adb shell getprop ro.build.version.sdk | tr -d '\r')" >> "$LOG/environment.txt"
# The mock wallet needs a screen lock for its Authenticate button. Emulator only.
if adb devices -l | grep -q emulator; then
  adb shell locksettings set-pin 1234 >> "$LOG/script.log" 2>&1 || true
fi

say "Installing laptop-side dependencies"
[ -d node_modules ] || npm install --no-audit --no-fund > "$LOG/npm-root.log" 2>&1 || die "npm install failed, see phone-test-logs/npm-root.log"
say "Running the laptop tests"
npm test > "$LOG/npm-test.log" 2>&1 && say "Laptop tests pass" || say "WARNING: laptop tests failed, see phone-test-logs/npm-test.log"

say "Installing app dependencies"
[ -d mobile/node_modules/expo ] || (cd mobile && npm install --no-audit --no-fund > "$LOG/npm-mobile.log" 2>&1) || die "npm install in mobile/ failed, see phone-test-logs/npm-mobile.log"

if adb shell pm list packages 2>/dev/null | grep -qi "mockmwawallet\|mock.mwa\|mwallet"; then
  say "Mock MWA Wallet already installed"
else
  say "Building the Mock MWA Wallet (a few minutes the first time)"
  if [ ! -d "$ROOT/.mock-mwa-wallet" ]; then
    git clone --depth 1 https://github.com/solana-mobile/mock-mwa-wallet.git "$ROOT/.mock-mwa-wallet" > "$LOG/mock-wallet.log" 2>&1 \
      || { mkdir -p "$ROOT/.mock-mwa-wallet" && curl -sSL https://github.com/solana-mobile/mock-mwa-wallet/archive/refs/heads/main.tar.gz | tar xz --strip-components 1 -C "$ROOT/.mock-mwa-wallet"; } \
      || die "Could not download the Mock MWA Wallet"
  fi
  echo "sdk.dir=$ANDROID_HOME" > "$ROOT/.mock-mwa-wallet/local.properties"
  if (cd "$ROOT/.mock-mwa-wallet" && chmod +x gradlew && ./gradlew installDebug >> "$LOG/mock-wallet.log" 2>&1); then
    say "Mock MWA Wallet installed"
  else
    say "WARNING: Mock MWA Wallet build failed, see phone-test-logs/mock-wallet.log. Continuing; the app's Connect button needs a wallet."
  fi
fi
adb shell pm list packages > "$LOG/packages.txt" 2>&1

say "Starting the relay and the test driver"
adb reverse tcp:8787 tcp:8787 >> "$LOG/script.log" 2>&1 || die "adb reverse failed"
adb reverse tcp:8081 tcp:8081 >> "$LOG/script.log" 2>&1 || true
[ -f "$LOG/pids" ] && xargs kill < "$LOG/pids" 2>/dev/null
node relay/server.js > "$LOG/relay.log" 2>&1 &
RELAY_PID=$!
sleep 1
LOG_DIR="$LOG" node scripts/phone-driver.js > "$LOG/driver.out" 2>&1 &
DRIVER_PID=$!
echo "$RELAY_PID $DRIVER_PID" > "$LOG/pids"
trap 'kill $RELAY_PID $DRIVER_PID 2>/dev/null; rm -f "$LOG/pids"' EXIT

say "Building and installing the app (first build takes 10 to 25 minutes). Metro stays running afterwards; leave this window open."
cd mobile
npx expo run:android 2>&1 | tee "$LOG/expo.log"
