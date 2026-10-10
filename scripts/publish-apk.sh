#!/usr/bin/env bash
# Put the latest CI-built APK on the website. The repo is public, so the SERVER downloads the files
# itself from GitHub; nothing is uploaded from your Mac. Needs only ssh access to the server
# (curl and sha256sum are on the server already).
#
#   bash scripts/publish-apk.sh root@relay.ajkadri.dev
#   NOD_SERVER=root@relay.ajkadri.dev bash scripts/publish-apk.sh
#
# On the server it downloads nod.apk, SHA256SUMS and BUILD.txt from
# https://github.com/AjKadri/nod-app/raw/build-artifacts/, checks nod.apk against SHA256SUMS, and only
# then swaps nod.apk (and a SHA256SUMS that lists just nod.apk) into /var/www/nod in one step.
# Options by environment: NOD_REPO=owner/name (default AjKadri/nod-app), NOD_SITE_DIR (default /var/www/nod).
set -euo pipefail

SERVER="${1:-${NOD_SERVER:-}}"
REPO="${NOD_REPO:-AjKadri/nod-app}"
SITE_DIR="${NOD_SITE_DIR:-/var/www/nod}"
BRANCH="build-artifacts"
[ -n "$SERVER" ] || { echo "usage: bash scripts/publish-apk.sh user@server   (or set NOD_SERVER)"; exit 1; }
# These go into a URL and a remote command, so only plain characters are accepted.
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "NOD_REPO must look like owner/name"; exit 1; }
[[ "$SITE_DIR" =~ ^/[A-Za-z0-9_./-]+$ ]] || { echo "NOD_SITE_DIR must be a plain absolute path"; exit 1; }

echo "Telling $SERVER to download the latest build from github.com/$REPO ($BRANCH)"
ssh "$SERVER" bash -s -- "$REPO" "$BRANCH" "$SITE_DIR" <<'REMOTE'
set -euo pipefail
REPO="$1"; BRANCH="$2"; SITE_DIR="$3"
command -v curl >/dev/null || { echo "curl is not installed on the server."; exit 1; }
[ -d "$SITE_DIR" ] || { echo "$SITE_DIR does not exist on the server. Run deploy/vps/setup.sh first."; exit 1; }
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

BASE="https://github.com/$REPO/raw/$BRANCH"
for file in nod.apk SHA256SUMS BUILD.txt; do
  curl -fsSL --retry 3 --connect-timeout 15 --max-time 300 -o "$WORK/$file" "$BASE/$file" \
    || { echo "Could not download $BASE/$file. Has a CI build finished?"; exit 1; }
done

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
EXPECTED="$(awk '$2 == "nod.apk" {print $1}' "$WORK/SHA256SUMS")"
ACTUAL="$(sha256 "$WORK/nod.apk")"
[ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || { echo "The downloaded nod.apk does not match SHA256SUMS. Nothing was published."; exit 1; }
[ "$(wc -c < "$WORK/nod.apk")" -gt 1000000 ] || { echo "nod.apk is suspiciously small. Nothing was published."; exit 1; }
cat "$WORK/BUILD.txt"
echo "nod.apk sha256 $ACTUAL"

# The branch's SHA256SUMS also lists the test wallet, which the site does not serve: publish just nod.apk.
printf '%s  nod.apk\n' "$ACTUAL" > "$WORK/site-SHA256SUMS"
cp "$WORK/nod.apk" "$SITE_DIR/.nod.apk.new"
cp "$WORK/site-SHA256SUMS" "$SITE_DIR/.SHA256SUMS.new"
chmod 644 "$SITE_DIR/.nod.apk.new" "$SITE_DIR/.SHA256SUMS.new"
mv -f "$SITE_DIR/.nod.apk.new" "$SITE_DIR/nod.apk"
mv -f "$SITE_DIR/.SHA256SUMS.new" "$SITE_DIR/SHA256SUMS"
echo "Published."
REMOTE
echo "Check: https://nod.ajkadri.dev/nod.apk"
