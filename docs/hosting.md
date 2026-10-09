# Hosting the relay

The relay is a small Node server. Agents and phones both talk to it, so for a phone that is not on your laptop's network it has to live on the internet, behind HTTPS. This page deploys it to [Fly.io](https://fly.io); any host that can run a Docker image with one persistent volume works the same way.

**Cost and limits.** Fly asks for a card even for the free allowance. A free tier that sleeps, or has no disk (Render's free web service, for example), does not suit this: phones keep a WebSocket open, and pairings live in a file that must survive restarts. Run exactly **one** machine.

## What the relay refuses

- It will not start on a public address without `RELAY_REGISTRATION_KEY` (24 characters or more). Without it anyone could create pairings on your relay.
- It will not start without a place to keep its state (`RELAY_STATE_FILE`) that it can write to.
- On a public address it only accepts requests that came in over HTTPS (the host's proxy reports this in `X-Forwarded-Proto`), because pairing keys travel in headers.
- Its `/health` page returns only `{"ok":true}` when public (or when `RELAY_REQUIRE_HTTPS=1`).

## What it keeps on disk

One file, `RELAY_STATE_FILE`, readable only by the relay: the SHA-256 **hashes** of every pairing's keys (never the keys), each phone's push token and wallet address, and the requests (the transactions waiting to be signed, which are not secret). A restart or redeploy changes nothing for the phone: it stays paired and still sees what is waiting. If the file ever cannot be parsed, the relay renames it to `…corrupt-<time>` and starts empty rather than overwriting it. Back the volume up if the pairings matter to you; losing it only means pairing again.

## Deploy on Fly.io

You need the [`flyctl`](https://fly.io/docs/flyctl/install/) command and `fly auth login`.

```bash
# 1. Pick a unique app name and put it in deploy/fly.toml (the `app = ...` line), then:
fly apps create <your-app-name>
fly volumes create nod_data --size 1 --region <same region as primary_region> --app <your-app-name>

# 2. A long random registration key. Keep a copy: you need it every time you pair a laptop.
KEY=$(openssl rand -base64 36 | tr -d '/+=' | cut -c1-40)
echo "$KEY"
fly secrets set RELAY_REGISTRATION_KEY="$KEY" --app <your-app-name>

# 3. Deploy from the repo root.
fly deploy --config deploy/fly.toml --dockerfile deploy/Dockerfile --app <your-app-name>

# 4. Check it.
curl https://<your-app-name>.fly.dev/health        # {"ok":true}
fly logs --app <your-app-name>                      # "public mode: registration key required, HTTPS required"
```

Then pair your laptop and phone (the key is read from the environment, not stored):

```bash
RELAY_REGISTRATION_KEY="$KEY" npm run pair -- --relay https://<your-app-name>.fly.dev
```

Scan the QR code in the app. Check that it survives a restart: `fly machine restart <id>`, then `npm run pair -- --status` should still say the phone is paired.

## VPS (Hetzner/Ubuntu)

One small server (a Hetzner CX22 is plenty; any Ubuntu 22.04/24.04 or Debian machine works) with a script that installs everything: Node 22, the relay as a service that restarts on its own, Caddy for HTTPS with an automatic certificate, and a firewall that allows only SSH, HTTP and HTTPS. The relay listens on `127.0.0.1` behind Caddy, requires HTTPS, and keeps its state in `/var/lib/nod`.

1. **Point a name at the server.** Create an **A record** for a name you own (for example `relay.example.com`) pointing to the server's IPv4 address. No domain? Use `<ip>.sslip.io`: for a server at `203.0.113.7` the name is `203.0.113.7.sslip.io`, and it already points at that address. (sslip.io is a shared free service, so its certificates can hit rate limits; use your own domain for anything lasting.)
2. **Copy the script over:**
   ```bash
   scp deploy/vps/setup.sh root@<server-ip>:
   ```
3. **Run it on the server** (the first argument is the name from step 1):
   ```bash
   ssh root@<server-ip>
   sudo bash setup.sh relay.example.com
   ```
   It checks that the name points at this server, installs and starts everything, then prints the relay address and a freshly generated **registration key**. Copy the key somewhere safe; it is also in `/etc/nod/relay.env` (root only).
4. **Check and pair** from your computer:
   ```bash
   curl https://relay.example.com/health        # {"ok":true}
   RELAY_REGISTRATION_KEY=<key> npm run pair -- --relay https://relay.example.com
   ```

To update the relay later, pull the new code, copy `setup.sh` over again and re-run the same command. It replaces the relay, keeps the key and every pairing, and restarts the service. `setup.sh` carries its own copy of `relay/`: `node scripts/vps-bundle.js` refreshes that copy after you change the relay (`npm test` fails if it is out of date). Logs: `journalctl -u nod-relay -f` and `journalctl -u caddy -n 50`.

## Settings

| Variable | Meaning |
| --- | --- |
| `RELAY_REGISTRATION_KEY` | Secret. Required when `HOST` is not localhost. 24+ characters. |
| `RELAY_STATE_FILE` | Where state is kept. The image uses `/data/relay-state.json` (the volume). |
| `HOST`, `PORT` | `0.0.0.0` and `8787` in the image. |
| `RELAY_REQUIRE_HTTPS` | On by default for a public address. `0` turns it off (do not). Set to `1` behind a proxy on localhost (as the VPS script does) and `/health` also shows nothing but `ok`. |
| `EXPO_ACCESS_TOKEN` | Optional secret, only if you turn on "enhanced push security" in your Expo account. |

## Push notifications (needs you, once)

The relay sends a push through Expo when a request arrives. The phone side is built, but Android delivers pushes through Firebase, which needs two things only you can create:

1. A free Expo account and an EAS project: in `mobile/`, run `npx eas-cli login` then `npx eas-cli init`. This writes the project id into `app.json` (`extra.eas.projectId`). Without it the app skips push and says so in Settings.
2. A Firebase project with an Android app whose package name is `com.ajkadri.nod`. Download its `google-services.json` into `mobile/` (it is git-ignored), then upload the FCM credential to Expo: `npx eas-cli credentials` → Android → Google Service Account Key for push notifications.

**Builds from GitHub Actions.** The workflow in `.github/workflows/build.yml` builds the APK. To include push, add the contents of `google-services.json` as a repository secret named `GOOGLE_SERVICES_JSON` (Settings → Secrets and variables → Actions → New repository secret). When the secret exists the workflow writes it to `mobile/google-services.json` before building, and stops with a clear message if it is not valid JSON or is not for the package `com.ajkadri.nod`. Without the secret it builds as before, without push. (The project id from step 1 must be committed in `mobile/app.json`, since it is not secret.)

Then build the app (a development or release build; push does not work in Expo Go) and install it. The notification says which agent is waiting, never the amount or the agent's note, and tapping it opens that request.

## Running a relay on your own network (development)

`npm run relay` listens on `127.0.0.1` only and needs no key. The Android release build refuses plain `http://` relays; a debug build allows them. To test a release build against your laptop, put an HTTPS tunnel in front, for example `cloudflared tunnel --url http://localhost:8787`, and pair with the `https://…` address it prints.
