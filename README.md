# Nod

▶ Watch the 2-minute demo: <https://www.youtube.com/watch?v=oIHKND8kFog>

**Your agent asks. You nod.** An AI agent asks for a Solana transaction, your phone shows what it would really do, you nod, and your mobile wallet signs. The agent never holds your key.

## For judges: two ways to try Nod

**1. Fastest, no PC needed.** Install the APK from https://nod.ajkadri.dev/nod.apk, open Nod and tap **Try demo**. You get the approval card, the risky-transaction warning and the auto-approve rules without a wallet.

**2. Full loop, self-hosted.** You need Node 20 or newer, and Solflare set to devnet on the phone.

```
git clone https://github.com/AjKadri/nod-app.git nod
cd nod
npm install
npm run relay
```

Release builds only pair over HTTPS, and `npm run relay` listens on localhost, so put an HTTPS tunnel in front of it, for example `cloudflared tunnel --url http://localhost:8787`. Then pair the phone and send a devnet request with the demo script:

```
npm run pair -- --relay https://<your-tunnel-address>
NOD_DEMO_RECIPIENT=<DEVNET_ADDRESS> npm run demo:video
```

Details: [With the real phone app](#with-the-real-phone-app), [Replay the demo video](#replay-the-demo-video) and [docs/hosting.md](docs/hosting.md).

- Demo video: *link coming soon*
- Deck: *link coming soon*
- Site and APK: https://nod.ajkadri.dev
- X: https://x.com/nod_app

Built for the Solana Mobile CLOCK IN hackathon. Android, Solana devnet, MIT licensed.

## Try it in 60 seconds

No wallet, no laptop, no setup.

1. On an Android phone, open https://nod.ajkadri.dev and download the APK (`/nod.apk`; checksum at `/SHA256SUMS`). Allow installing from your browser when Android asks. It runs on 32-bit and 64-bit phones.
2. Open Nod and tap **Try demo**.
3. Open a request. You see the *simulated* result of the transaction, not what the agent claims. One sample request is a "tiny test payment" that really sends far more; the card shows the real amount.

Demo mode uses sample data. Nothing is signed or sent, and it never touches a wallet or the network.

## Run the whole thing

You need Node 20 or newer. No Android, no accounts, no internet after install.

```bash
git clone https://github.com/AjKadri/nod-app.git nod
cd nod
npm install
npm test          # about 190 tests
npm run demo      # the whole loop in four situations, printed step by step
```

`npm run demo` starts a relay, an offline Solana (the real Solana runtime, LiteSVM, behind a local RPC), a pretend phone and an agent, and walks through: an approved payment, a denied one, a slow approval whose transaction would have expired (it is refreshed), and a tricked agent whose "tiny test payment" really sends 0.9 SOL.

### Drive it by hand

Four terminals, still fully offline:

```bash
npm run local-rpc                                            # 1: offline Solana on :8899
npm run relay                                                # 2: the relay on :8787
npm run phone:sim -- --rpc http://127.0.0.1:8899 --airdrop   # 3: a terminal "phone" that asks y/n
node agent/request.js transfer --to <ANY_ADDRESS> --sol 0.001 --rpc http://127.0.0.1:8899   # 4: you are the agent
```

Use `node agent/request.js raw ...` to send a finished transaction instead of a description (how real swap APIs behave). Drop `--rpc` to use real devnet.

### With the real phone app

The app and the relay pair with a one-time code:

```bash
npm run relay            # on your laptop
npm run pair             # shows a QR code; in the app choose "Pair with laptop" and scan it
```

Release builds (the APK) only talk to **HTTPS** relays, so a local `http://` relay needs either a debug build (`cd mobile && npm install && npm run android`, with `adb reverse tcp:8787 tcp:8787`) or an HTTPS tunnel. To host your own relay see [docs/hosting.md](docs/hosting.md) (Fly.io) or [deploy/vps/](deploy/vps/) (one-script setup on a VPS with Caddy). The relay at `relay.ajkadri.dev` needs a registration key that only the author has.

Once paired, from the laptop:

```bash
node agent/request.js transfer --to <DEVNET_ADDRESS> --sol 0.001 --note "hello"
```

The request shows up on the phone, you approve, the wallet signs, and the signature prints on the laptop. `npm run pair -- --status` shows the pairing, `npm run pair -- --revoke` ends it. The laptop's key is kept in `~/.nod/agent.json`.

### Connect a real agent

Nod ships an MCP server (`agent/mcp-server.js`) with three tools: `get_wallet_address`, `request_transfer` and `request_transaction`. Short guides with the exact commands:

[Claude Code](docs/agents/claude-code.md) · [Cursor](docs/agents/cursor.md) · [Codex](docs/agents/codex.md) · [OpenClaw](docs/agents/openclaw.md)

Then ask the agent: "send 0.001 SOL to `<ADDRESS>` on devnet". `AGENT_NAME` (and optionally `AGENT_ICON`) set how the phone labels each agent.

### Replay the demo video

With the phone paired and a devnet address you own:

```bash
NOD_DEMO_RECIPIENT=<DEVNET_ADDRESS> npm run demo:video
```

It waits for you to press Enter before each of three requests: a normal 0.002 SOL one from "Research agent"; a "Trading agent" that says *tiny 0.001 SOL test payment* but sends 0.03 SOL; and a repeat 0.001 SOL payment that auto-approves. Before you start, switch on auto-approve in the app's Settings with a daily limit of about 0.01 SOL. Use `--only a,c` to run only some steps.

## How it fits together

```
 AI agent ──MCP──▶ Nod MCP server ──HTTPS──▶ relay ──WebSocket / push──▶ Nod app (phone)
 (Claude Code,      agent/mcp-server.js      relay/server.js                  │
  Cursor, Codex…)                                                            │ shows the simulated result,
                                                                             │ you nod
                                                                             ▼
                                              Solana (devnet) ◀── signs ── mobile wallet (Mobile Wallet Adapter)
```

1. The agent asks (by MCP tool, or `agent/request.js`) for a transfer or a finished transaction. It can only ask.
2. The relay holds the request until the phone answers. It only passes messages along.
3. The phone simulates the transaction against Solana and shows the balance change that would really happen, plus warnings.
4. You approve. The phone hands the transaction to your wallet through the Mobile Wallet Adapter and the wallet signs. The phone sends it, and the signature goes back to the agent.

The approval logic lives once, in `shared/`, and is mirrored into the app.

## Security model, in plain words

- **The agent never holds your keys.** Your keys stay in your wallet. The agent can only send a request; it cannot approve it.
- **The preview shows what would really happen.** The phone simulates the transaction and shows the result. The agent's note is only a claim, shown as a claim. A request labelled "tiny test payment" that moves 0.9 SOL shows as 0.9 SOL.
- **One phone per pairing.** A pairing is made with a one-time code, and a second phone cannot join it. One pairing cannot see another's requests.
- **Keys are stored hashed.** The relay keeps only SHA-256 hashes of the agent's and phone's keys. A hosted relay refuses to start without a registration key and accepts only HTTPS.
- **Pause everything.** One switch in the app makes the relay refuse every new request, and agents are told so rather than left hanging.
- **Daily limit.** You set a limit in SOL. It counts every payment through Nod, with network fees, and resets at local midnight.
- **Auto-approve is narrow.** A request skips Nod's card only if it is a plain SOL transfer to an address you approved by hand before, its simulation is clean, it fits in what is left of today's limit, nothing is paused, and Nod is open on screen. Anything else asks as usual. The limit, trusted addresses and spending record never leave the phone.
- **Stale transactions are refreshed.** If you are slow to approve, the blockhash is refreshed when the wallet is the only signer. Otherwise the transaction is passed through unchanged.
- **Withdraw on timeout.** If the agent stops waiting, its request is cancelled so it cannot be approved later with nobody listening.

## Honest limits

- **Devnet only.** Do not use real funds. The app and relay are not audited.
- **The wallet still asks for its own signature.** Auto-approve skips Nod's card, not the wallet's prompt, and Nod cannot know in advance whether your wallet will show one. If the wallet cannot sign without you, nothing is sent and the normal card appears.
- **Push notifications need Firebase set up.** The relay can push, but you must supply your own Firebase and Expo credentials. Without them requests still arrive over the app's WebSocket while Nod is open, but the phone is not woken for new ones.
- **Release builds need an HTTPS relay**, so running the APK against your own laptop needs a tunnel or a hosted relay.
- **Android only.** There is no iOS app. The APK is signed with the author's release key; a debug-signed build from this repo will not match the key published on the site.
- **Preview checked against devnet only.** Blockhash refresh only works when the wallet is the sole signer. The template's `react-native-quick-crypto` 0.7.17 has an open npm advisory and should be upgraded before real use.
- **Not tried on every phone and wallet.** The loop has been run end to end on a real phone with Solflare. Other wallets and Android versions are untested.

## What's next

Planned, not built into this release: a Mainnet option and token payments (SPL and Token-2022 tokens, with SKR first). Nod is Devnet only today.

## Repo layout

```
shared/     approval logic: validate, build, refresh blockhash, simulate, summarise, auto-approve
relay/      the relay server (HTTP + WebSocket)
agent/      client.js (library), request.js (CLI), mcp-server.js (MCP tools), pair.js
sim/        phone.js (terminal phone), local-rpc.js (offline Solana), demo.js
test/       end-to-end and unit tests
mobile/     the Expo app (Solana Mobile template + features/approvals)
site/       the one-page website and its assetlinks.json
deploy/     Fly.io config and the one-script VPS installer
docs/       agent guides, hosting, release, design reference, history of the first spike
scripts/    sync, release helpers, demo:video
```

Edit approval logic in `shared/`, then run `npm run sync`. `npm test` fails if the app's copy is out of date.

More: [docs/hosting.md](docs/hosting.md) · [docs/release.md](docs/release.md) · [docs/history/](docs/history/) (the first feasibility spike, not maintained).

## License

[MIT](LICENSE)
