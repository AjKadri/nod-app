# Hosting the relay

The relay is a small Node server. Agents and phones both talk to it, so for a phone that is not on your laptop's network it has to live on the internet, behind HTTPS. This page deploys it to [Fly.io](https://fly.io); any host that can run a Docker image with one persistent volume works the same way.

**Cost and limits.** Fly asks for a card even for the free allowance. A free tier that sleeps, or has no disk (Render's free web service, for example), does not suit this: phones keep a WebSocket open, and pairings live in a file that must survive restarts. Run exactly **one** machine.

## What the relay refuses

- It will not start on a public address without `RELAY_REGISTRATION_KEY` (24 characters or more). Without it anyone could create pairings on your relay.
- It will not start without a place to keep its state (`RELAY_STATE_FILE`) that it can write to.
- On a public address it only accepts requests that came in over HTTPS (the host's proxy reports this in `X-Forwarded-Proto`), because pairing keys travel in headers.
- Its `/health` page returns only `{"ok":true}` when public.

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

## Settings

| Variable | Meaning |
| --- | --- |
| `RELAY_REGISTRATION_KEY` | Secret. Required when `HOST` is not localhost. 24+ characters. |
| `RELAY_STATE_FILE` | Where state is kept. The image uses `/data/relay-state.json` (the volume). |
| `HOST`, `PORT` | `0.0.0.0` and `8787` in the image. |
| `RELAY_REQUIRE_HTTPS` | On by default for a public address. `0` turns it off (do not). |
| `EXPO_ACCESS_TOKEN` | Optional secret, only if you turn on "enhanced push security" in your Expo account. |

## Push notifications (needs you, once)

The relay sends a push through Expo when a request arrives. The phone side is built, but Android delivers pushes through Firebase, which needs two things only you can create:

1. A free Expo account and an EAS project: in `mobile/`, run `npx eas-cli login` then `npx eas-cli init`. This writes the project id into `app.json` (`extra.eas.projectId`). Without it the app skips push and says so in Settings.
2. A Firebase project with an Android app whose package name is `com.ajkadri.nod`. Download its `google-services.json` into `mobile/` (it is git-ignored), then upload the FCM credential to Expo: `npx eas-cli credentials` → Android → Google Service Account Key for push notifications.

Then build the app (a development or release build; push does not work in Expo Go) and install it. The notification says which agent is waiting, never the amount or the agent's note, and tapping it opens that request.

## Running a relay on your own network (development)

`npm run relay` listens on `127.0.0.1` only and needs no key. The Android release build refuses plain `http://` relays; a debug build allows them. To test a release build against your laptop, put an HTTPS tunnel in front, for example `cloudflared tunnel --url http://localhost:8787`, and pair with the `https://…` address it prints.
