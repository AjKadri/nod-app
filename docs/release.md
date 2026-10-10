# Releasing Nod

## One-time: the signing key

Run this **on your Mac**, from the repo folder. The key is made in `~/nod-keys/`, outside the repo.

```sh
bash scripts/make-release-key.sh
```

It asks for a password (12+ characters), makes the key, and prints its SHA-256 fingerprint. It also writes that fingerprint into `site/.well-known/assetlinks.json` and refreshes the copy of the site inside `deploy/vps/setup.sh`: commit both.

**Back up, in two places (a password manager and an offline copy):**

1. `~/nod-keys/nod-release.jks`
2. the password you chose

Lose either and a new APK can never replace an installed one: everyone would have to uninstall first, and lose their pairings. `nod-release.jks.base64` and `fingerprint.txt` can be recreated from the key, so they do not need a backup. Never commit any of these files.

**GitHub secrets** (repository, Settings, Secrets and variables, Actions, New repository secret):

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | the contents of `~/nod-keys/nod-release.jks.base64` (`pbcopy < ~/nod-keys/nod-release.jks.base64`, then paste) |
| `ANDROID_KEY_ALIAS` | `nod` |
| `ANDROID_KEYSTORE_PASSWORD` | the password you chose |

Or: `gh secret set ANDROID_KEYSTORE_BASE64 < ~/nod-keys/nod-release.jks.base64`, `gh secret set ANDROID_KEY_ALIAS --body nod`, `gh secret set ANDROID_KEYSTORE_PASSWORD`.

Without these secrets CI still builds, signs with the debug key, and prints a warning. With them it checks that they open the key, signs the APK, and prints the signing certificate's SHA-256 in the "Verify signature" step: it must equal the fingerprint in `assetlinks.json`.

**Switching keys.** An APK signed with the debug key cannot be updated by one signed with the release key: uninstall the old Nod once, then install the new one (the wallet and the pairing have to be set up again). After that, every build is signed with the same key and installs over the last. CI numbers each build (`versionCode` = the run number) so a newer APK always counts as an update.

## The web page and the relay (one VPS)

Point two A records at the server: `relay.ajkadri.dev` and `nod.ajkadri.dev` (no domain? `<ip-with-dashes>.sslip.io` works, for example `203-0-113-7.sslip.io`).

```sh
scp deploy/vps/setup.sh root@<server>:
ssh root@<server> 'bash setup.sh relay.ajkadri.dev nod.ajkadri.dev'
```

Run it again after any change to `relay/` or `site/`: it updates both, keeps the registration key and the relay's state, and remembers the site domain. `npm test` and CI fail if the copies inside `setup.sh` are out of date; the fix is `node scripts/vps-bundle.js`, then commit.

**Publishing the APK.** The repo is public, and the page's download button points at `/nod.apk` on the server itself, so the server fetches the build. After a CI build finishes, from your Mac (only ssh access is needed):

```sh
bash scripts/publish-apk.sh root@relay.ajkadri.dev
```

The server downloads `nod.apk`, `SHA256SUMS` and `BUILD.txt` from `https://github.com/AjKadri/nod-app/raw/build-artifacts/`, checks `nod.apk` against `SHA256SUMS`, and swaps it into `/var/www/nod` in one step. Nothing is uploaded from your Mac, and a failed or mismatching download leaves the APK that is already there. `NOD_REPO=owner/name` points it at a fork. Running `setup.sh` again keeps the APK.

The page is `site/index.html` (a demo video goes in the marked slot; a `demo.mp4` you put in `/var/www/nod/` on the server survives re-runs). Check the app link file with `curl https://nod.ajkadri.dev/.well-known/assetlinks.json`: it must list your fingerprint.

## What the wallet sees

The app tells wallets (Mobile Wallet Adapter) it is **Nod**, at `https://nod.ajkadri.dev`, with the icon `https://nod.ajkadri.dev/icon.png`. Wallets that check the identity read `assetlinks.json` on that site for the signing key of `com.ajkadri.nod`. The wallet's authorization token is saved on the phone (AsyncStorage, key `authorization-cache`) and sent on every sign, so the wallet should only ask to trust Nod once. Changing the name, address or icon makes it ask once more.
