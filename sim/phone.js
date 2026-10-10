#!/usr/bin/env node
"use strict";
/**
 * A pretend phone that runs in your terminal. It uses the SAME approval logic
 * as the real app (shared/), but signs with a throwaway test key instead of a
 * mobile wallet. Use it to run the whole loop on a laptop before touching
 * Android.
 *
 *   node sim/phone.js --pair "nod://pair?..."   pair with a laptop first (once), using the link
 *                                          `node agent/pair.js` prints. Then:
 *   node sim/phone.js                      asks y/n for each request
 *   node sim/phone.js --auto approve       approves everything
 *   node sim/phone.js --auto deny
 *   node sim/phone.js --airdrop            ask the RPC for 1 test SOL first
 *
 * Options: --pair LINK  --rpc URL   Env: RPC_URL
 * The pairing is kept in sim/.test-pairing.json (test only).
 *
 * The test key is saved in sim/.test-wallet.json. It is for devnet or the
 * local stand-in only. Never send real funds to it.
 */
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const WebSocket = require("ws");
const { Connection, Keypair, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const { reviewRequest, formatSol } = require("../shared/approval");
const { rpcChain } = require("../shared/chain");
const { createRelayClient } = require("../shared/relayClient");
const { claimPairing } = require("../shared/pairing");
const { submitApproval, submitDenial, submitInvalid } = require("../shared/flow");

/**
 * @param decide async (review, request) => "approve" | "deny"
 * @param onEvent optional (event) => void, for logging and tests
 */
function createSimPhone({ relayUrl, rpcUrl, keypair, decide, token = "", network = "devnet", onEvent = () => {} }) {
  const connection = new Connection(rpcUrl, "confirmed");
  const chain = rpcChain(connection, network);
  const walletAddress = keypair.publicKey;
  let queue = Promise.resolve();
  // Requests the relay says are finished (answered, expired, or withdrawn by the agent).
  const finished = new Set();

  async function signAndSend(transaction) {
    transaction.sign([keypair]);
    return chain.sendRaw(transaction.serialize());
  }

  async function handle(request) {
    onEvent({ type: "received", request });
    if (finished.has(request.id)) return onEvent({ type: "skipped", request });
    let review;
    try {
      review = await reviewRequest({ payload: request.payload, walletAddress, chain });
    } catch (error) {
      const outcome = await submitInvalid({ request, relay, error });
      onEvent({ type: "done", request, outcome });
      return;
    }
    onEvent({ type: "reviewed", request, review });

    const choice = await decide(review, request);
    // The agent may have given up while the human was deciding. Never sign for nobody.
    if (finished.has(request.id)) return onEvent({ type: "skipped", request });
    const outcome =
      choice === "approve"
        ? await submitApproval({ request, walletAddress, chain, signAndSend, relay, confirmTimeoutMs: 30_000 })
        : await submitDenial({ request, relay });
    onEvent({ type: "done", request, review, outcome });
  }

  const relay = createRelayClient({
    baseUrl: relayUrl,
    token,
    WebSocketImpl: WebSocket,
    fetchImpl: fetch,
    reconnectMs: 500,
    onStatus: (status) => onEvent({ type: "status", status }),
    onResolved: (id) => finished.add(id),
    // One at a time, in arrival order, like a single approval screen.
    onRequest: (request) => {
      queue = queue.then(() => handle(request)).catch((err) => onEvent({ type: "error", error: err }));
    },
  });
  relay.setWallet(walletAddress.toBase58());

  return {
    address: walletAddress.toBase58(),
    connection,
    idle: () => queue,
    close: () => relay.close(),
  };
}

function loadOrCreateKeypair(file) {
  if (fs.existsSync(file)) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
  }
  const keypair = Keypair.generate();
  fs.writeFileSync(file, JSON.stringify([...keypair.secretKey]), { mode: 0o600 });
  return keypair;
}

function printReview(review, request) {
  const { summary, preview } = review;
  console.log("\n================ APPROVAL REQUEST ================");
  console.log(`From agent : ${review.request.agent || "(unnamed)"}`);
  console.log(`Note       : ${review.request.note || "(none)"}`);
  console.log(`Request id : ${request.id}`);
  console.log(`Effect     : ${review.headline}`);
  if (preview.ok && typeof preview.feeLamports === "number") {
    console.log(`Network fee: ${formatSol(preview.feeLamports)}`);
  }
  for (const transfer of summary.transfers) {
    console.log(`Transfer   : ${formatSol(transfer.lamports)} to ${transfer.to}`);
  }
  console.log(`Programs   : ${summary.programs.map((p) => p.name || p.id).join(", ")}`);
  if (!review.refreshable) {
    console.log("Warning    : other signers are involved, so this must be approved before it expires");
  }
  console.log("==================================================");
}

async function main() {
  const args = process.argv.slice(2);
  const value = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };
  const pairFile = path.join(__dirname, ".test-pairing.json");
  let pairing = null;
  try {
    pairing = JSON.parse(fs.readFileSync(pairFile, "utf8"));
  } catch (_err) {
    // Not paired yet.
  }
  const link = value("pair", "");
  if (link) {
    pairing = await claimPairing({ link, fetchImpl: fetch });
    fs.writeFileSync(pairFile, JSON.stringify(pairing), { mode: 0o600 });
    console.log(`[phone] paired with "${pairing.label}"`);
  }
  if (!pairing) {
    console.error('Not paired. Run `node agent/pair.js`, then: node sim/phone.js --pair "<the nod://pair link>"');
    process.exit(1);
  }
  const relayUrl = pairing.relay;
  const rpcUrl = value("rpc", process.env.RPC_URL || "https://api.devnet.solana.com");
  const auto = value("auto", "");
  const keypair = loadOrCreateKeypair(path.join(__dirname, ".test-wallet.json"));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question) => new Promise((resolve) => rl.question(question, resolve));

  const phone = createSimPhone({
    relayUrl,
    rpcUrl,
    keypair,
    token: pairing.token,
    decide: async (review, request) => {
      printReview(review, request);
      if (auto === "approve" || auto === "deny") {
        console.log(`(auto ${auto})`);
        return auto;
      }
      const answer = (await ask("Approve? [y/N] ")).trim().toLowerCase();
      return answer === "y" || answer === "yes" ? "approve" : "deny";
    },
    onEvent: (event) => {
      if (event.type === "status") console.log(`[phone] relay ${event.status}`);
      if (event.type === "error") console.log(`[phone] error: ${event.error.message}`);
      if (event.type === "skipped") console.log(`[phone] request ${event.request.id} was withdrawn, nothing signed`);
      if (event.type === "done") {
        const { outcome } = event;
        console.log(
          `[phone] ${outcome.status}${outcome.signature ? ` ${outcome.signature}` : ""}${outcome.reason ? ` (${outcome.reason})` : ""}`
        );
      }
    },
  });

  console.log(`[phone] test wallet ${phone.address}`);
  console.log(`[phone] relay ${relayUrl}   rpc ${rpcUrl}`);
  if (args.includes("--airdrop")) {
    try {
      await phone.connection.requestAirdrop(keypair.publicKey, LAMPORTS_PER_SOL);
      console.log("[phone] requested 1 test SOL");
    } catch (err) {
      console.log(`[phone] airdrop failed: ${err.message}`);
    }
  }
  try {
    const balance = await phone.connection.getBalance(keypair.publicKey);
    console.log(`[phone] balance ${formatSol(balance)}${balance === 0 ? "  <- fund this address before approving anything" : ""}`);
  } catch (err) {
    console.log(`[phone] could not reach the RPC: ${err.message}`);
  }
  console.log("[phone] waiting for requests. Ctrl+C to stop.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { createSimPhone };
