# Nod

Your agent asks. You nod.

*(Feasibility spike for the Solana Mobile CLOCK IN hackathon.)*

An AI agent on your laptop asks for a transaction. Your phone shows what it would really do. You approve. Your mobile wallet signs. The agent gets a signature back. The agent never holds your key.

This folder is the feasibility test from `FEASIBILITY-TEST.md`, with everything that does not need a phone already built and tested.

## Where the feasibility tests stand

| Test | Status | What is left |
|---|---|---|
| 1 Toolchain | App project ready. It type-checks, lints, and its Android JavaScript bundle builds. **Never run on a device.** | `npm install` and `npm run android` in `mobile/` |
| 2 Wallet signs on devnet | Not run. The template has a "Sign transaction" button for exactly this. | Install the mock wallet, connect, tap the button |
| 3 Remote request loop | **Passes on the laptop** with a simulated phone. | Repeat with the real app |
| 4 Stale blockhash | **Passes on the laptop**, including a human who is slow to approve. | Repeat with the real app (`--hold 180`) |
| 5 Preview | **Passes on the laptop**: the previewed amount equals what left the wallet. | Confirm against real devnet (see the note below) |
| 6 Push | Relay side done and tested. App side not written. | Add `expo-notifications` in the app |
| 7 Signed APK | Not possible from the build machine. Build profile is in `mobile/eas.json`. | `eas build`, install, re-run Test 3 |
| 8 Real agent | **Passes on the laptop**: a real MCP client drives the loop through `agent/mcp-server.js`. | Point Codex, Claude Code or Cursor at it |
| 9 Delegation program on mainnet | Not checked. | The two `solana program show` commands |

"Passes on the laptop" means: real relay, real agent client, real MCP server, real `@solana/web3.js`, and the real Solana runtime (LiteSVM) behind a local RPC stand-in. The two stand-ins are the phone (a terminal program that signs with a test key instead of a mobile wallet) and devnet. The approval logic itself is the same code the phone app runs.

**So the open risk is only the Android part:** the app starting on a device, the Mobile Wallet Adapter hand-off to the wallet, the WebSocket from the phone to the relay, and the release build.

## Part 1: prove the loop on your laptop (2 minutes)

Needs Node 20 or newer. No Android, no internet after install.

```bash
npm install
npm test        # 24 tests, about 5 seconds
npm run demo    # the loop in four situations, printed step by step
```

To drive it by hand, use three terminals:

```bash
npm run local-rpc                                   # 1: offline Solana stand-in on :8899
npm run relay                                       # 2: relay on :8787
npm run phone:sim -- --rpc http://127.0.0.1:8899 --airdrop   # 3: pretend phone, asks y/n
```

Then, in a fourth terminal, be the agent:

```bash
node agent/request.js transfer --to <ANY_ADDRESS> --sol 0.001 --rpc http://127.0.0.1:8899
node agent/request.js raw      --to <ANY_ADDRESS> --sol 0.001 --rpc http://127.0.0.1:8899
```

Drop `--rpc ...` everywhere to use real devnet (the pretend phone prints a test address to fund at https://faucet.solana.com).

## Part 2: the phone (what is left of the feasibility test)

Prerequisites are the same as `FEASIBILITY-TEST.md`: Android Studio with the SDK, JDK 17, a phone with USB debugging (or an emulator), and the Mock MWA Wallet built from https://github.com/solana-mobile/mock-mwa-wallet and installed.

```bash
cd mobile
npm install
adb reverse tcp:8787 tcp:8787     # lets "localhost:8787" on the phone reach your laptop
npm run android                   # Test 1 passes when the app opens
```

In another terminal, from this folder: `npm run relay`, then pair the phone with this laptop:

```bash
npm run pair      # shows a QR code (add --relay http://<laptop-ip>:8787 for a phone that is not on adb reverse)
```

In the app choose **Pair with laptop** and scan the code (or paste the `nod://pair…` line). The code works once and expires after 10 minutes. `npm run pair -- --status` shows whether the phone is connected, and `npm run pair -- --revoke` ends the pairing from the laptop. In the app, **Settings → Paired laptops → Unpair** ends it from the phone. The laptop keeps its key in `~/.nod/agent.json`; agents started by the MCP server pick it up on their own.

1. **Test 2.** In the mock wallet press **Authenticate** (valid for 15 minutes). In the app press **Connect**, fund the shown address with devnet SOL, press **Sign transaction**. Pass: it confirms on a devnet explorer.
2. **Test 3.** The app's Approvals card should say `Relay online`. Run `node agent/request.js transfer --to <ADDRESS> --sol 0.001`. Pass: the request appears within 2 seconds, Approve prints a signature on the laptop, Deny prints `DENIED`.
3. **Test 4.** Run `node agent/request.js raw --to <ADDRESS> --sol 0.001 --hold 180`, then approve. Pass: it still confirms.
4. **Test 5.** Compare the app's "You send ..." line with the wallet's balance change on the explorer.
5. **Test 7.** `eas build --platform android --profile dapp-store`, then `apksigner verify --print-certs`, `adb install`, and repeat Test 3. Back up the keystore EAS creates.

If the wallet signs but fails to send (the Test 2 fallback), start the app with `EXPO_PUBLIC_WALLET_SENDS=1 npm run android`: the wallet then signs and sends (Nod broadcasts by default).

If the phone cannot reach the relay: check `adb reverse --list`, and `curl http://localhost:8787/health` on the laptop.

### Connecting a real agent (Test 8)

Add this to the agent's MCP config, with the real path:

```json
{
  "mcpServers": {
    "phone-approvals": {
      "command": "node",
      "args": ["/absolute/path/to/agent/mcp-server.js"],
      "env": { "RELAY_URL": "http://localhost:8787", "AGENT_NAME": "codex" }
    }
  }
}
```

`AGENT_NAME` is what the phone shows on each request, so give every agent its own (`claude-code`, `cursor`, `codex`). Optionally add `AGENT_ICON`: one of `code`, `terminal`, `sparkles`, `chat`, `search`, `globe`, `flash`, `cube`, or a single emoji. Anything else (a web address, plain text) is ignored; the agent chooses its own label, so the phone treats it as a claim, not as proof of who is asking. Without them the request shows as "Unnamed agent" with a laptop icon.

**Pause everything.** The switch at the top of the app's inbox makes the relay refuse every new request from your paired laptops with `423`. Each agent is told "paused all approvals … do not retry" instead of hanging or guessing, and `node agent/request.js` exits with code 3. Requests already waiting stay answerable. It lasts until you switch it off, including across a relay restart, and the switch only shows what the relay has confirmed: if a laptop cannot be reached, the app says so and offers to try again.

Then ask it: "send 0.001 SOL to <ADDRESS> on devnet". Tools: `get_wallet_address`, `request_transfer`, `request_transaction`.

## What the tests found that matters for the real build

- **One phone per relay.** With two phones connected, both saw the same request and both signed it, so the money moved twice. The relay now keeps only the newest phone connection. Pairing now fixes this: a second phone cannot join an existing pairing.
- **Withdraw on timeout.** If the agent stops waiting, the request is cancelled so the phone cannot approve it afterwards with nobody listening.
- **The agent's note cannot be trusted.** The screen shows the simulated balance change, not the agent's description. A request labelled "tiny test payment" that sends 0.9 SOL shows as 0.9 SOL.
- **Blockhash refresh works only when the wallet is the sole signer.** Multi-signer transactions are passed through unchanged and must be approved before they expire.
- **Release builds block plain HTTP.** `mobile/app.json` turns it back on for the spike so the app can reach `http://localhost:8787`. The real relay must be HTTPS and this setting removed.

## Not verified, please check on the device

- **The fee in the preview.** In LiteSVM the simulated balance already includes the network fee, so the screen says "(network fee included)". Real devnet should behave the same, but that is Test 5's job to confirm.
- **`signAndSendTransaction` with the mock wallet.** Written against the library's type definitions, never executed.
- **The template's crypto polyfill.** npm flags `react-native-quick-crypto@0.7.17` (pinned by the official template) with a security advisory and recommends 1.0 or newer. Fine for the spike; upgrade before a real release.

## Security limits of this spike

- Pairing: each laptop and phone get their own secret, stored on the relay only as a hash. Anyone without a pairing is refused, and one pairing cannot see another's requests. A relay on a public address refuses to start without `RELAY_REGISTRATION_KEY`, accepts only HTTPS, and saves pairings (hashes), push tokens and pending requests to disk so a restart does not unpair the phone. See `docs/hosting.md` to deploy it. The local relay (`npm run relay`) still speaks plain HTTP on localhost; never expose it as it is.
- The Android release build no longer allows plain `http://` and the app refuses to pair with a non-HTTPS relay. For a local test of a release build, put an HTTPS tunnel in front of the relay (see `docs/hosting.md`); debug builds still accept a local `http://` relay.
- The pairing code in the QR is a one-time password, so do not photograph it or share it.
- A laptop whose pairing is revoked while offline learns about it on its next call. The phone treats a refused key as revoked and drops it.
- `sim/.test-wallet.json` is a throwaway key for devnet or the local stand-in. Never fund it with real SOL.
- The Mock MWA Wallet is a testing wallet. Never use it with real funds.

## Layout

```
shared/     approval logic: validate, build, refresh blockhash, summarise, preview, report
relay/      the relay server (HTTP + WebSocket, in memory)
agent/      client.js (library), request.js (CLI), mcp-server.js (MCP tools)
sim/        phone.js (terminal phone), local-rpc.js (offline Solana), demo.js
test/       end-to-end tests
mobile/     the Expo app: official Solana Mobile template + features/approvals
scripts/    sync-shared.js copies shared/ into mobile/features/approvals/lib
```

Edit approval logic in `shared/`, then run `npm run sync`. `npm test` fails if the app's copy is out of date.

## Report back

| Test | Pass / fail | Time taken | Notes |
|---|---|---|---|
| 1 App opens on the device | | | |
| 2 Wallet signs on devnet | | | |
| 3 Remote request loop on the device | | | |
| 4 Stale blockhash on the device | | | |
| 5 Preview matches on devnet | | | |
| 6 Push | | | |
| 7 Signed APK, Test 3 repeated | | | |
| 8 Real agent | | | |
| 9 Delegation program on mainnet | | | |
