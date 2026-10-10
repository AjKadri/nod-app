#!/usr/bin/env bash
# Make Nod's release signing key on YOUR computer, outside the repo, and publish its fingerprint.
#   bash scripts/make-release-key.sh
# Writes to ~/nod-keys (or $NOD_KEYS_DIR):
#   nod-release.jks          the key. Losing it means the app can never be updated in place.
#   nod-release.jks.base64   the same file as one line of text, for the GitHub secret
#   fingerprint.txt          the public SHA-256 fingerprint
# The password is asked for here and is never written to disk by this script. Keep it in a password manager.
set -euo pipefail

DIR="${NOD_KEYS_DIR:-$HOME/nod-keys}"
KEYSTORE="$DIR/nod-release.jks"
ALIAS="nod"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "$DIR" in "$REPO_DIR"|"$REPO_DIR"/*) echo "Refusing to put the key inside the repo ($REPO_DIR)."; exit 1;; esac
[ ! -e "$KEYSTORE" ] || { echo "$KEYSTORE already exists. Not overwriting it."; exit 1; }

KEYTOOL="$(command -v keytool || true)"
if [ -z "$KEYTOOL" ] && [ -x "/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/keytool" ]; then
  KEYTOOL="/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/keytool"
fi
[ -n "$KEYTOOL" ] || { echo "keytool not found. Install Java (brew install --cask temurin) or Android Studio, then run this again."; exit 1; }

read -r -s -p "Choose a key password (12 or more characters): " NOD_PW; echo
read -r -s -p "Type it again: " NOD_PW2; echo
[ "$NOD_PW" = "$NOD_PW2" ] || { echo "The passwords differ."; exit 1; }
[ "${#NOD_PW}" -ge 12 ] || { echo "Use at least 12 characters."; exit 1; }
export NOD_PW

umask 077
mkdir -p "$DIR"
"$KEYTOOL" -genkeypair -storetype PKCS12 -keystore "$KEYSTORE" -alias "$ALIAS" \
  -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Nod, O=Nod" \
  -storepass:env NOD_PW -keypass:env NOD_PW >/dev/null

base64 < "$KEYSTORE" | tr -d '\n' > "$DIR/nod-release.jks.base64"
FP="$("$KEYTOOL" -list -v -keystore "$KEYSTORE" -alias "$ALIAS" -storepass:env NOD_PW | awk '/SHA256:/{print $2; exit}')"
printf '%s\n' "$FP" > "$DIR/fingerprint.txt"
unset NOD_PW NOD_PW2

echo
echo "Key made: $KEYSTORE"
echo "SHA-256 fingerprint: $FP"
echo
if command -v node >/dev/null; then
  (cd "$REPO_DIR" && node scripts/set-fingerprint.js "$FP")
  echo "Now commit site/.well-known/assetlinks.json and deploy/vps/setup.sh."
else
  echo "Node not found. Later run: node scripts/set-fingerprint.js $FP"
fi
cat <<MSG

BACK UP NOW (a password manager and one offline copy):
  1. $KEYSTORE
  2. the password you just chose
Without both, a new APK can never replace the installed one; everyone would have to uninstall first.

ADD THESE GITHUB SECRETS (repository, Settings, Secrets and variables, Actions), or with the gh tool:
  gh secret set ANDROID_KEYSTORE_BASE64 < "$DIR/nod-release.jks.base64"
  gh secret set ANDROID_KEY_ALIAS --body $ALIAS
  gh secret set ANDROID_KEYSTORE_PASSWORD        (it asks for the password; type or paste it)
Never commit the key, the .base64 file or the password.
MSG
