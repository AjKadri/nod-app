# Nod

**Your agent asks. You nod.** An AI agent asks for a Solana transaction, your phone shows what it would really do, you nod, and your mobile wallet signs. The agent never holds your key.

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

Nod ships an MCP server (`agent/mcp-server.js`) with four tools: `get_wallet_address`, `request_transfer`, `request_token_transfer` and `request_transaction`. Short guides with the exact commands:

[Claude Code](docs/agents/claude-code.md) · [Cursor](docs/agents/cursor.md) · [Codex](docs/agents/codex.md) · [OpenClaw](docs/agents/openclaw.md)

Then ask the agent: "send 0.001 SOL to `<ADDRESS>` on devnet", or "send 250 SKR to `<ADDRESS>`" (see [Mainnet and tokens](#mainnet-and-tokens-skr)). `AGENT_NAME` (and optionally `AGENT_ICON`) set how the phone labels each agent.

### Replay the demo video

With the phone paired and a devnet address you own:

```bash
NOD_DEMO_RECIPIENT=<DEVNET_ADDRESS> npm run demo:video
```

It waits for you to press Enter before each of three requests: a normal 0.002 SOL one from "Research agent"; a "Trading agent" that says *tiny 0.001 SOL test payment* but sends 0.03 SOL; and a repeat 0.001 SOL payment that auto-approves. Before you start, switch on auto-approve in the app's Settings with a daily limit of about 0.01 SOL. Use `--only a,c` to run only some steps.

## Mainnet and tokens (SKR)

**Network.** Settings → Network switches between Devnet (default) and Mainnet. Turning Mainnet on shows “Real money. Transactions here are final.” and asks you to confirm; the card's network pill then shows “Mainnet” in the warning colour. Each network keeps its own wallet login, daily limits and trusted addresses. The RPC servers are the public ones; replace them in Settings if they are slow. For the agent side, `node agent/request.js ... --network mainnet` or `NETWORK=mainnet` for the MCP server.

**Tokens.** `request_token_transfer` takes a mint, a recipient and an amount in whole tokens. SPL Token and Token-2022 both work, and so does creating the recipient's token account (the card says “Creates the recipient’s token account: +0.00204 SOL rent”). From the CLI: `node agent/request.js token --mint <MINT> --to <ADDRESS> --amount 250`.

**SKR.** Nod recognises exactly one mint as SKR, `SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3` (the address on [solanamobile.com/skr](https://solanamobile.com/skr)), and shows its logo slot. Any other token that calls itself SKR gets a red warning. The daily limit can be set for SOL and SKR separately.

**Trying it without real SKR.** Devnet has no SKR, so:

```bash
npm run devnet:skr-test -- --to <YOUR_PHONE_WALLET>   # makes a test token and sends you 1000
# put the printed EXPO_PUBLIC_TEST_SKR_MINT=... line in mobile/.env and rebuild the app
npm run check:skr                                      # reads the real SKR mint on Mainnet, sends nothing
```

The test token shows as “SKR (test)”. Demo mode also has an official-SKR card and a fake-SKR card.

## How it fits together

```
 AI agent ──MCP──▶ Nod MCP server ──HTTPS──▶ relay ──WebSocket / push──▶ Nod app (phone)
 (Claude Code,      agent/mcp-server.js      relay/server.js                  │
  Cursor, Codex…)                                                            │ shows the simulated result,
                                                                             │ you nod
                                                                             ▼
                                              Solana (devnet or mainnet) ◀── signs ── mobile wallet (Mobile Wallet Adapter)
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
- **Daily limits, per token.** You set a limit in SOL and one in SKR. Each counts every payment of that asset through Nod, and the SOL network fees count against the SOL limit. Both reset at local midnight.
- **The right network, always.** Every request names its network and the phone refuses one for the other network, before showing anything. It also checks that the RPC server really is that network (by its genesis hash), so a wrong RPC address cannot make it sign for the wrong chain.
- **Token amounts come from the simulation.** The card shows what the simulated transaction does to your token accounts, with decimals read from the mint on-chain. It never reads an amount from the agent's note or from instruction data. A token that merely calls itself SKR gets a red warning; only the official mint is SKR.
- **Auto-approve is narrow.** A request skips Nod's card only if it is a plain SOL or SKR transfer (nothing else in the transaction, no new token account to pay for) to an address you approved by hand before, its simulation is clean, it fits in what is left of today's limit for that asset, nothing is paused, and Nod is open on screen. Anything else asks as usual. The limit, trusted addresses and spending record never leave the phone.
- **Stale transactions are refreshed.** If you are slow to approve, the blockhash is refreshed when the wallet is the only signer. Otherwise the transaction is passed through unchanged.
- **Withdraw on timeout.** If the agent stops waiting, its request is cancelled so it cannot be approved later with nobody listening.

## Honest limits

- **Mainnet moves real money.** Devnet is the default; Mainnet is a switch in Settings → Network. The app and relay are not audited, so start with amounts you can lose. Transactions are final.
- **The wallet still asks for its own signature.** Auto-approve skips Nod's card, not the wallet's prompt, and Nod cannot know in advance whether your wallet will show one. If the wallet cannot sign without you, nothing is sent and the normal card appears.
- **Push notifications need Firebase set up.** The relay can push, but you must supply your own Firebase and Expo credentials. Without them requests still arrive over the app's WebSocket while Nod is open, but the phone is not woken for new ones.
- **Release builds need an HTTPS relay**, so running the APK against your own laptop needs a tunnel or a hosted relay.
- **Android only.** There is no iOS app. The APK is signed with the author's release key; a debug-signed build from this repo will not match the key published on the site.
- **Mainnet and real SKR not tested end to end.** The Mainnet path and SKR display were tested with the Solana runtime in-process and a Devnet test token (“SKR (test)”). Real SKR is checked by reading its mint (`npm run check:skr`), not by sending. Blockhash refresh only works when the wallet is the sole signer. The template's `react-native-quick-crypto` 0.7.17 has an open npm advisory and should be upgraded before real use.
- **Not tried on every phone and wallet.** The loop has been run end to end on a real phone with Solflare. Other wallets and Android versions are untested.

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
