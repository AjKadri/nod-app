#!/usr/bin/env bash
# Put the latest CI-built APK on the website. The repo is private, so the page serves /nod.apk
# from the server itself. Needs the GitHub CLI (`gh auth login` once) and ssh access to the server.
#
#   bash scripts/publish-apk.sh root@relay.ajkadri.dev
#   NOD_SERVER=root@relay.ajkadri.dev bash scripts/publish-apk.sh
#
# Downloads nod.apk (and SHA256SUMS, BUILD.txt) from the build-artifacts branch, checks the checksum,
# copies them to /var/www/nod on the server with scp, and swaps nod.apk in place in one step.
# Options by environment: NOD_REPO=owner/name (default: the repo of this folder), NOD_SITE_DIR (default /var/www/nod).
set -euo pipefail

SERVER="${1:-${NOD_SERVER:-}}"
SITE_DIR="${NOD_SITE_DIR:-/var/www/nod}"
BRANCH="build-artifacts"
[ -n "$SERVER" ] || { echo "usage: bash scripts/publish-apk.sh user@server   (or set NOD_SERVER)"; exit 1; }
command -v gh >/dev/null || { echo "The GitHub CLI (gh) is not installed: https://cli.github.com"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Run: gh auth login"; exit 1; }

REPO="${NOD_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fetch() { # file in the branch -> local file (raw contents, works for private repos and large files)
  gh api -H "Accept: application/vnd.github.raw" "repos/$REPO/contents/$1?ref=$BRANCH" > "$WORK/$1" \
    || { echo "Could not download $1 from the $BRANCH branch of $REPO. Has a CI build finished?"; exit 1; }
}
echo "Downloading the latest build from $REPO ($BRANCH)"
fetch nod.apk
fetch SHA256SUMS
fetch BUILD.txt

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
EXPECTED="$(awk '$2 == "nod.apk" {print $1}' "$WORK/SHA256SUMS")"
ACTUAL="$(sha256 "$WORK/nod.apk")"
[ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || { echo "The downloaded nod.apk does not match SHA256SUMS. Nothing was uploaded."; exit 1; }
[ "$(wc -c < "$WORK/nod.apk")" -gt 1000000 ] || { echo "nod.apk is suspiciously small. Nothing was uploaded."; exit 1; }
echo "$(cat "$WORK/BUILD.txt")"
echo "nod.apk sha256 $ACTUAL"

echo "Uploading to $SERVER:$SITE_DIR"
scp -q "$WORK/nod.apk" "$SERVER:$SITE_DIR/.nod.apk.new"
# The branch's SHA256SUMS also lists the test wallet, which the site does not serve: publish a list of just nod.apk.
printf '%s  nod.apk\n' "$ACTUAL" > "$WORK/site-SHA256SUMS"
scp -q "$WORK/site-SHA256SUMS" "$SERVER:$SITE_DIR/.SHA256SUMS.new"
ssh "$SERVER" "cd '$SITE_DIR' && chmod 644 .nod.apk.new .SHA256SUMS.new && mv -f .nod.apk.new nod.apk && mv -f .SHA256SUMS.new SHA256SUMS"
echo "Published. Check: https://nod.ajkadri.dev/nod.apk"
