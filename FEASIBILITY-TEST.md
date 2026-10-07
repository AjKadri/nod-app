# Feasibility test: agent approvals on Seeker

> **Update, 7 October:** the laptop half of this plan is now built and tested, and the app project already exists in `mobile/`. Follow `README.md` for the current steps. This file is kept for the original reasoning, time boxes and go/no-go rule. You no longer need to create a project (Test 1) or write the relay, agent script or approval screen (Tests 3 to 5).

**When:** Wednesday 7 October. Target finish 15:00, hard stop 18:00 (Lagos time).
**Goal:** prove the one chain the whole product depends on, before building anything else.

> A script on the laptop asks for a transaction. The phone shows it. I approve. The wallet signs. The script gets the signature back.

No design, no polish, no extra screens. Ugly is fine. If this chain works on a real Android phone in a signed APK, the idea is buildable by the deadline (Monday 12 October, 12:59 GMT+1).

---

## Context for the AI coding agent

Paste this section to your agent before the first task.

- **Product:** an Android app that lets a person approve or deny transactions requested by AI agents running elsewhere (laptop, server). The agent never holds the user's key. The user's mobile wallet signs.
- **Today's scope:** a throwaway spike that proves the request, approve, sign, return loop. Do not build pairing, accounts, history, or styling.
- **Stack decisions (already made, do not change without saying why):**
  - React Native with Expo, using a custom development build. Expo Go does not work with Mobile Wallet Adapter.
  - Wallet library: `@wallet-ui/react-native-web3js` with `@solana/web3.js` v1. Reason: agents and swap APIs hand us pre-built serialized transactions, and this variant's `signAndSendTransactions(transaction, minContextSlot)` takes a built transaction directly. Solana Mobile recommends the `@solana/kit` variant for new apps, so flag it if kit turns out to handle pre-built versioned transactions just as easily.
  - Relay: one small Node server, in memory, HTTP plus WebSocket. No database.
  - Network: devnet only today.
- **Do not use:** Seeker Connect (web only for now), the Seed Vault SDK (it is for wallet developers), Expo Go.
- **Test device:** a regular Android phone over USB, with the Mock MWA Wallet installed. No Seeker is available.
- **Rules:** never put a real private key anywhere. The Mock MWA Wallet is a testing wallet and must not hold real funds.

### Verified references (checked 7 October 2026)

- Create a project: https://docs.solanamobile.com/get-started/react-native/create-solana-mobile-app
- Install wallet library: https://docs.solanamobile.com/get-started/react-native/installation
- Provider setup: https://docs.solanamobile.com/get-started/react-native/setup
- Hook usage (connect, sign, send): https://docs.solanamobile.com/get-started/react-native/quickstart
- Low-level sessions: https://docs.solanamobile.com/get-started/react-native/invoke-mwa-sessions-directly
- Test without a Seeker: https://docs.solanamobile.com/recipes/general/test-with-any-android-device
- Mock MWA Wallet: https://github.com/solana-mobile/mock-mwa-wallet
- Build and sign an APK: https://docs.solanamobile.com/dapp-store/build-and-sign-an-apk

---

## Before you start (30 minutes)

- [ ] Node 20 or newer, Android Studio with the Android SDK, JDK 17.
- [ ] Phone: developer options on, USB debugging on, `adb devices` shows it.
- [ ] A fingerprint or PIN set on the phone (the mock wallet asks for device authentication).
- [ ] Free Expo account, and `npm install -g eas-cli` then `eas login`.
- [ ] Signed up on the hackathon site, and joined the Radiants Discord for build help.

---

## The tests

Run them in order. Each has a time box. If a test runs over, stop and use its fallback or note it as failed.

### Test 1: toolchain (45 min)

Create the app and run it on the phone.

```bash
npm create solana-dapp@latest
# choose the Solana Mobile framework, then a React Native Expo template
cd <project>
npm install
npm run android
```

If the template does not already include them, add the wallet packages and polyfill:

```bash
npm install @wallet-ui/react-native-web3js @solana/web3.js \
  react-native-quick-crypto react-native-nitro-modules expo-dev-client
```

```js
// polyfill.js (project root)
import { install } from "react-native-quick-crypto";
install();
```

```js
// index.js (entry point, polyfill must come first)
import "./polyfill";
import "expo-router/entry";
```

Set `"main": "./index.js"` and `"android": "expo run:android"` in `package.json`.

**Pass:** the template app opens on the phone.

**As soon as this passes, start Test 7 in the background.** Cloud builds can queue.

### Test 2: wallet signs on devnet (60 min)

1. Build the Mock MWA Wallet from source in Android Studio and install it on the phone (see its README).
2. Open the mock wallet and press **Authenticate**. This enables signing for 15 minutes, so press it again if signing later fails.
3. In the app, connect with `useMobileWallet().connect`, show the wallet address, and fund it with devnet SOL (`solana airdrop 1 <ADDRESS> --url devnet`, or https://faucet.solana.com).
4. Add one button that sends 0.001 SOL to any other devnet address using `signAndSendTransactions(transaction, minContextSlot)`. Get the blockhash with `connection.getLatestBlockhashAndContext()` so you have the slot to pass.

**Pass:** the transaction shows as confirmed on a devnet explorer.
**Fallback:** if the mock wallet signs but fails to send, sign only and broadcast from the app with `connection.sendRawTransaction`.

### Test 3: the remote request loop (90 min) — the core test

Build three throwaway pieces:

- **Relay** (`relay/server.js`): `POST /requests` creates a request and holds the HTTP response open (or lets the caller poll `GET /requests/:id`). A WebSocket pushes new requests to the connected phone. `POST /requests/:id/result` stores `{ status: "approved", signature }` or `{ status: "denied" }`.
- **Agent script** (`agent/request.js`): posts `{ type: "transfer", to, lamports, note: "from laptop agent" }`, waits, prints the result.
- **App screen:** connects to the relay over WebSocket, shows the incoming request with **Approve** and **Deny**. Approve builds the transfer, signs and sends it with the wallet, then posts the signature back. Deny posts `denied`.

For the phone to reach the laptop during the spike: `adb reverse tcp:8787 tcp:8787` and point the app at `http://localhost:8787`.

**Pass:** running the script makes the request appear on the phone within 2 seconds, approving prints a confirmed signature on the laptop within 60 seconds, and denying prints `denied`.

### Test 4: pre-built transaction with a stale blockhash (45 min)

Real agents send a finished transaction, not a description. Prove the app can sign one that was built earlier.

1. Change the agent script to build an unsigned transaction itself (fee payer set to the phone wallet's address), serialize it to base64, and post `{ type: "raw", transactionBase64 }`.
2. In the app, on Approve: deserialize it, replace the recent blockhash with a fresh one, then sign and send.
3. Send a request, **wait 3 minutes**, then approve.

**Pass:** the delayed approval still confirms. This proves the blockhash refresh works and that slow humans do not break the flow.
**Note:** refreshing the blockhash only works when the user is the only signer. Record this as a known limit.

### Test 5: preview before signing (45 min)

Before showing Approve, simulate the transaction and display what it will do.

- Call `connection.simulateTransaction` with `sigVerify: false` and `replaceRecentBlockhash: true`, requesting the user's account in the `accounts` option so you get its post-simulation balance.
- Show the SOL change for the user's wallet, for example "You send 0.001 SOL (plus fee)".

**Pass:** the number shown matches what actually leaves the wallet.
**Fallback:** list the program IDs the transaction calls. Less friendly, still honest.

### Test 6: wake the phone with a push (120 min, not blocking)

With the app in the background, a new request should raise a notification, and tapping it should open that request.

- Use `expo-notifications` with Firebase Cloud Messaging (needs a free Firebase project and `google-services.json`). The relay sends the push when a request arrives.

**Pass:** app in background, run the script, notification arrives within 10 seconds, tap opens the request, approve works.
**If it fails in the time box:** note it and move on. The product still demos with the app open on a desk. It is a weaker demo, not a dead idea.

### Test 7: signed release APK (start early, about 60 min of waiting)

Add to `eas.json`:

```json
{
  "build": {
    "dapp-store": {
      "android": { "buildType": "apk" }
    }
  }
}
```

```bash
eas build --platform android --profile dapp-store
# or add --local to build on your machine (needs Android SDK and NDK)
apksigner verify --print-certs <downloaded>.apk
adb install <downloaded>.apk
```

Let EAS generate the keystore on the first build, then **back it up**. Every later build must use the same key.

**Pass:** the APK verifies, installs, and Test 3 still passes in the release build. Debug builds hide problems that release builds reveal, so do not skip the re-test.

### Test 8 (stretch, 30 min): a real agent makes the request

Wrap the agent script as an MCP tool named `request_transaction` and call it from Claude Code or Cursor with "send 0.001 SOL to <address> on devnet".

**Pass:** the phone prompts, and the agent reports the signature in its reply.

### Test 9 (stretch, 5 min): is the delegation program on mainnet?

```bash
solana program show De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44 --url mainnet-beta
solana program show De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44 --url devnet
```

Just record the answer. It decides whether the on-chain spending limit is a possible Saturday stretch goal.

---

## Go or no-go

| Result | Decision |
|---|---|
| Tests 1, 2, 3, 4 and 7 pass | **Go.** Build agent approvals. |
| Test 1, 2 or 7 fails | Toolchain problem that would hit any app idea. Ask in the Radiants Discord, do not switch ideas. |
| Test 3 or 4 fails after the time box | Stop and report exactly what broke before building further. |
| Test 5 or 6 fails | Still go. Use the fallbacks. |

## What this test does not cover

- Pairing a phone to an agent securely (QR plus shared secret). The spike relay has no authentication and must never be exposed publicly.
- Mainnet, real swaps, and real wallets. Planned for Saturday.
- Linking with SeekerClaw or OpenClaw. Planned for Thursday or Friday, after Test 8 shows the tool works.
- A real Seeker and Seed Vault. Not available; the mock wallet stands in.

## Report back

Fill this in and send it over. It decides the plan for Thursday to Sunday.

| Test | Pass / fail | Time taken | Notes |
|---|---|---|---|
| 1 Toolchain | | | |
| 2 Wallet signs on devnet | | | |
| 3 Remote request loop | | | |
| 4 Stale blockhash | | | |
| 5 Preview | | | |
| 6 Push | | | |
| 7 Signed APK | | | |
| 8 Real agent (stretch) | | | |
| 9 Delegation program on mainnet (stretch) | | | |
