# Nod: handoff for the coding agent

Read this whole file before writing code. It is the brief for building Nod from the working spike to the hackathon submission.

**Nod in one line:** your AI agent asks, your phone shows what the transaction really does, you nod, your mobile wallet signs. The agent never holds the key.

**Deadline:** submission due **Mon 12 Oct 2026, 12:59 (Lagos, UTC+1)**. Target: submitted by 10:00 that morning. Judging: stickiness/product fit, UX, innovation, presentation/demo. Deliverables: APK, this GitHub repo (private for now), demo video, pitch deck.

---

## 1. What already works (do not rebuild it)

| Piece | Where | State |
|---|---|---|
| Approval logic: validate, build/normalise to `VersionedTransaction`, refresh blockhash, summarise, simulate preview, report | `shared/approval.js` (+ `.d.ts`) | Tested |
| Chain access (blockhash, balance, simulate, fee, send, confirm) | `shared/chain.js` | Tested |
| Phone-side relay client (WebSocket, reconnect, stops on close code 4000) | `shared/relayClient.js` | Tested |
| Approve / deny / invalid flows | `shared/flow.js` | Tested |
| Relay (HTTP + WebSocket, in memory, 127.0.0.1:8787) | `relay/server.js` | Tested, spike-grade (no auth, no TLS) |
| Agent client + CLI | `agent/client.js`, `agent/request.js` | Tested |
| MCP server: `get_wallet_address`, `request_transfer`, `request_transaction` | `agent/mcp-server.js` | Tested with a real MCP client |
| Simulated phone + offline Solana (LiteSVM) | `sim/` | Used by tests |
| 24 end-to-end tests | `test/loop.test.js` | `npm test`, ~5 s |
| Expo app (official Solana Mobile `web3js-expo-minimal` template + approvals feature) | `mobile/` | Runs on device; UI is a dev placeholder |
| Cloud build: tests, release APK (arm64), Mock MWA Wallet APK, publish to `build-artifacts` branch | `.github/workflows/build.yml` | Green |
| On-device test scripts | `scripts/phone-test-apk.sh`, `scripts/phone-driver.js` | Used on the emulator |

### What the on-device test (Android emulator, release APK) showed

- App launches; wallet connects through Mobile Wallet Adapter; phone stays connected to the relay through `adb reverse`; requests appear within seconds.
- The preview tells the truth: an agent note saying "tiny 0.001 SOL test payment" for a 0.03 SOL transfer showed **"You send 0.030005 SOL"**.
- Deny reaches the agent. A transaction held 180 s still reaches the wallet's sign screen (blockhash refresh works).
- **Not yet seen:** an approved transaction confirmed on devnet. Failures were all outside Nod: (a) a 12-hour-old wallet login was refused ("authorization request failed"); (b) the Mock MWA Wallet's own send was rejected by RPC preflight (-32002); (c) the overloaded emulator timed out the wallet session. The current build has Nod sign-only + broadcast by default and retries once after re-login. **Task 0 below closes this.**

---

## 2. Rules you must not break

1. **The phone screen shows simulated truth, never the agent's description.** The agent's note is shown as a quote, labelled as the agent's words. Amounts, recipients and warnings come from `reviewRequest()` only.
2. **One phone per relay pairing.** Two phones on one relay both signed the same request in testing and money moved twice. Keep "newest phone replaces older" (close code 4000) or stronger.
3. **Never sign for nobody.** If the request was withdrawn, expired or answered elsewhere, the phone must not sign it (see `onResolved` handling in the app and `sim/phone.js`).
4. **Blockhash refresh only when the wallet is the sole signer.** Multi-signer transactions pass through unchanged with a "approve soon or it expires" warning.
5. **Approval logic lives in `shared/`.** Edit it there, then `npm run sync` (copies into `mobile/features/approvals/lib`). `npm test` fails if the copies differ.
6. **`npm test` must stay green**, and the CI build must stay green, on every commit.
7. **No real funds, no real keys.** Devnet only. `sim/.test-wallet.json` and the Mock MWA Wallet are test-only. Never commit secrets; the release keystore stays out of git.
8. **The repo stays private** until the owner decides otherwise.
9. Commit messages end with the attribution lines the owner's tooling requires.

---

## 3. Tickets, in order

Each ticket lists what "done" means. Do them in order; stop and report if one takes more than its budget.

### Task 0. Prove an approved payment lands (owner's phone, 30 min)
Owner installs the APK on their own Android phone with a real wallet (Solflare or Phantom, set to devnet, funded from faucet.solana.com). Point the app at the relay (Task 3 makes this easy; until then use `adb reverse tcp:8787 tcp:8787` over USB).
**Done:** one approved 0.001 SOL transfer from `node agent/request.js transfer --to <ADDR> --sol 0.001` shows a signature on the laptop and confirms on explorer.solana.com (devnet). Record in `README.md`'s report table.

### Task 1. Nod UI (Fri, biggest task, ~1 day)
Replace the template's dev screen with Nod's own screens. Spec in **section 4**. Remove from the app: Sign In / Sign Message / Sign Transaction / Network cards, "App Config" card, and the "Sending: ..." toggle (keep the setting in code, default Nod sends).
Screens:
1. **Welcome / pair:** logo, one line ("Your agent asks. You nod."), Connect wallet, Pair with laptop (Task 2).
2. **Inbox (home):** pending requests first (newest on top), then recent history. Header: `nod.` wordmark, network pill ("Solana · Devnet"), Pause switch (Task 4).
3. **Approval card:** exactly the reference layout (section 4). Primary "Continue to wallet", secondary "Reject". "See transaction details" expands programs, accounts, raw warnings.
4. **Result:** approved (signature, link to explorer), rejected, failed (plain-language reason from `explainError`).
5. **Settings:** paired laptops (revoke), limit (Task 5), theme (System / Light / Dark), network.
**Done:** every state reachable with the simulated agent; works in light and dark; no template leftovers; screenshot of each screen in `docs/design/screens/`.

### Task 2. Pairing by QR (Fri, ~3 h)
Laptop runs `npx nod pair` (or `node agent/pair.js`): creates a random 32-byte secret + pairing id, prints a QR with `nod://pair?relay=<url>&id=<id>&secret=<b64>`. Phone scans (use `expo-camera`), stores secret in `expo-secure-store`. All relay calls carry `Authorization: Bearer <HMAC or derived token>`; relay rejects unknown pairings. Revoke from Settings.
**Done:** a second, unpaired client cannot create requests or see the phone; tests added in `test/`.

### Task 3. Hosted relay over HTTPS + push (Fri–Sat, ~3 h)
Deploy `relay/` (Fly.io, Render or Railway free tier) behind HTTPS. Remove `usesCleartextTraffic` from `mobile/app.json` once the app talks only HTTPS. Add `expo-notifications`: phone registers its Expo push token (`POST /push-token` exists); relay sends a push on new request. Tapping the notification opens that request.
**Done:** phone off the laptop's network still receives a request in under 5 s with the app closed; tapping opens the card.

### Task 4. One inbox for all agents + Pause everything (Sat, ~2 h)
Each request carries `agent` (name) and optional `agentIcon`; MCP server reads `AGENT_NAME`. Inbox groups by time, shows the agent's name and icon. "Pause everything" on the phone makes the relay refuse new requests (`423 paused`) and agents get a clear error.
**Done:** two MCP clients with different names show distinct rows; pause blocks both; unpause resumes.

### Task 5. Small vs big (Sat, ~3 h)
User sets a daily limit (e.g. 0.05 SOL). Requests under the remaining limit, plain SOL transfers only, to an address already approved before, are **auto-approved on the phone** (still signed by the wallet, so the phone must be awake: show them as "auto-approved" in history; if the wallet needs a prompt, show the card anyway). Anything else always asks.
Stretch only if time remains: an on-chain allowance (delegated spending) so small payments need no phone at all. Do not start it before Tasks 0–6 are done.
**Done:** limit editable in Settings; auto-approved items visible and marked in history; tests for the limit arithmetic.

### Task 6. Agent setup guides (Sat, ~2 h)
`docs/agents/` with one page each for Claude Code, Cursor, Codex and OpenClaw: config snippet for `agent/mcp-server.js`, env vars (`RELAY_URL`, `RELAY_TOKEN`, `AGENT_NAME`), and a one-line test prompt ("send 0.001 SOL to <ADDR> on devnet").
**Done:** each guide followed once for real and the request appeared on the phone.

### Task 7. Polish and release (Sun morning)
- Wallet login refresh: on "authorization request failed", reconnect once (already in code) and show "Reconnecting to wallet..." instead of an error.
- Upgrade `react-native-quick-crypto` from 0.7.17 (npm advisory) if the template allows; otherwise note it.
- App icon and splash in the brand colours. App name "Nod".
- Release signing: generate a keystore (or EAS-managed), back it up outside the repo, sign the submission APK, `apksigner verify --print-certs`.
**Done:** signed APK installs clean on the owner's phone and passes Task 0 again.

### Not coding (owner + reviewer, Sun afternoon onward)
Demo video, pitch deck, README rewrite for judges. The demo moment: the agent claims "tiny 0.001 SOL test payment", the phone says **You send 0.030005 SOL**, the user rejects; then a real request gets approved and confirmed.

---

## 4. UI spec

Reference: `docs/design/approval-card-reference.png` (the "Quiet receipt" concept). Follow its structure exactly; change only the colours noted below.

### Approval card, top to bottom
1. Header row: `nod.` wordmark (left), network label "Solana · Devnet" (right, muted).
2. Agent row: device icon, agent name (primary), "From your paired laptop" (muted), time (right, muted).
3. Eyebrow: `REQUEST TO REVIEW` (small caps, letter-spaced, muted).
4. Headline: the agent's purpose in plain words, max 2 lines (from the request note, shown as the agent's claim). If there is no note: "Send SOL" / "Approve a transaction".
5. **Amount: big number + unit** from the simulated preview (what actually leaves the wallet). If the agent's note mentions a different amount, show a red warning row under the amount: "The agent said 0.001 SOL. This sends 0.030005 SOL."
6. Details panel (raised surface, rounded): Recipient (shortened address), Action (Token transfer / SOL transfer / Program call), Network fee, Preview ("Simulation completed" or the failure in red).
7. "See transaction details" disclosure: programs, unknown-program warnings, multi-signer warning.
8. Helper text: "Your wallet will ask you to sign."
9. Buttons: **Reject** (secondary, left, compact) and **Continue to wallet** (primary, right, wide).

### Colour
Use theme tokens everywhere (one file, e.g. `mobile/constants/theme.ts`), never hex values in components. Follow the system setting by default with a manual override in Settings.

The owner's change from the reference: the **primary button and the dot in `nod.`** use a green that matches the dark green panel, instead of the pale mint in the reference.

| Token | Dark | Light | Use |
|---|---|---|---|
| `bg` | `#151816` | `#F3F5F1` | Screen background |
| `surface` | `#1C201D` | `#FFFFFF` | Cards |
| `raised` | `#27302A` | `#E6ECE5` | Details panel, secondary button |
| `line` | `#343D37` | `#D3DBD2` | Dividers, card border |
| `text` | `#EEF1EC` | `#161A17` | Primary text |
| `muted` | `#98A29A` | `#5B655D` | Labels, secondary text |
| `accent` | `#3E6B4D` | `#2F5A3E` | Primary button, dot in `nod.`, links |
| `onAccent` | `#F3F6F1` | `#FFFFFF` | Text on primary button |
| `danger` | `#E8776E` | `#B3261E` | Mismatch warnings, failed preview, Reject in history |
| `warn` | `#E3B25C` | `#8A5A00` | "Approve soon" warnings |

Check text contrast is at least 4.5:1 for body and 3:1 for the large amount; adjust the token, not the component.

### Type and spacing
System font (Inter-like). Amount 64–72 sp, headline 30–34 sp, body 16 sp, labels 13–14 sp. 24 dp screen padding, 28 dp radius for the outer card, 16 dp for the panel, buttons 56 dp tall with 16 dp radius. Generous whitespace; one primary action per screen.

### Motion and feedback
Haptic tick when a request arrives and on approve/reject. Card slides up on arrival. No spinners longer than needed; "Waiting for wallet..." text while the wallet is open.

---

## 5. How to work

```bash
npm install && npm test                 # laptop side, 24 tests
cd mobile && npm install && npx tsc --noEmit && npm run lint
```

- Fast UI loop without building an APK: `cd mobile && npx expo start` needs a dev build. If no Android build tools are available locally, push to `main` and let CI build: the APK lands on the `build-artifacts` branch (`nod.apk`, `mock-wallet.apk`, `SHA256SUMS`).
- Simulated agent for UI work: `npm run relay`, then `node agent/request.js transfer --to <ADDR> --sol 0.001 --note "..."`.
- Emulator test: `bash scripts/phone-test-apk.sh` (expects `apks/nod.apk`, `apks/mock-wallet.apk`). Emulator PIN is 1234 (test only).
- Mock MWA Wallet: press **Authenticate** in it before approving (valid 15 minutes).

## 6. Known issues to keep in mind
- Mock MWA Wallet fails its own devnet send; Nod defaults to sign-only + broadcast. Keep that default for the demo unless Task 0 shows the real wallet's send works.
- API 37 preview emulator is slow and throws "isn't responding" dialogs; prefer the owner's real phone for anything timing-sensitive.
- Template pins `react-native-quick-crypto@0.7.17` (npm advisory).
- Relay is in memory: restarting it drops pending requests and pairings until Task 2/3 persist them.
