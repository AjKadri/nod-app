#!/usr/bin/env node
"use strict";
/**
 * Plays the agent for the on-device feasibility test and records what happened.
 * Started by scripts/phone-test.sh. It waits for the phone app to connect its
 * wallet to the relay, then sends four requests one after another. A person
 * (or Claude, through the emulator window) taps Approve or Deny on the phone.
 *
 * Writes: phone-test-logs/STATUS.txt (what to do right now)
 *         phone-test-logs/results.jsonl (one line per step)
 *
 * Env: RELAY_URL, RPC_URL, HOLD_SECONDS (default 180), STEP_TIMEOUT_SECONDS (default 900)
 */
const fs = require("fs");
const path = require("path");
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const { getWalletAddress, requestApproval, buildRawTransfer } = require("../agent/client");

const relay = (process.env.RELAY_URL || "http://localhost:8787").replace(/\/+$/, "");
const rpcUrl = process.env.RPC_URL || "https://api.devnet.solana.com";
const holdSeconds = Number(process.env.HOLD_SECONDS || 180);
const stepTimeoutMs = Number(process.env.STEP_TIMEOUT_SECONDS || 900) * 1000;
const logDir = process.env.LOG_DIR || path.join(__dirname, "..", "phone-test-logs");
fs.mkdirSync(logDir, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = () => new Date().toISOString().slice(11, 19);

function status(text) {
  const line = `[${stamp()}] ${text}`;
  fs.writeFileSync(path.join(logDir, "STATUS.txt"), line + "\n");
  fs.appendFileSync(path.join(logDir, "driver.log"), line + "\n");
  console.log(`[driver] ${text}`);
}

function record(entry) {
  fs.appendFileSync(path.join(logDir, "results.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

async function retry(label, fn, attempts = 5) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      await sleep(1500 * (i + 1));
    }
  }
  throw new Error(`${label}: ${lastError && lastError.message}`);
}

async function main() {
  const connection = new Connection(rpcUrl, "confirmed");
  const balanceOf = (address) => retry("getBalance", () => connection.getBalance(new PublicKey(address)));

  status("WAITING: open the app on the phone and press Connect (wallet not registered with the relay yet)");
  let wallet = null;
  while (!wallet) {
    wallet = await getWalletAddress({ relay }).catch(() => null);
    if (!wallet) await sleep(2000);
  }
  record({ step: "wallet", wallet });

  let balance = await balanceOf(wallet);
  if (balance < 0.05 * LAMPORTS_PER_SOL) {
    status(`Wallet ${wallet} has ${balance / LAMPORTS_PER_SOL} SOL. Asking the devnet faucet for 1 SOL...`);
    for (let attempt = 1; attempt <= 3 && balance < 0.05 * LAMPORTS_PER_SOL; attempt += 1) {
      try {
        await connection.requestAirdrop(new PublicKey(wallet), LAMPORTS_PER_SOL);
        await sleep(8000);
      } catch (err) {
        record({ step: "airdrop", attempt, error: String(err.message).slice(0, 200) });
        await sleep(4000);
      }
      balance = await balanceOf(wallet);
    }
  }
  while (balance < 0.05 * LAMPORTS_PER_SOL) {
    status(`NEEDS FUNDS: send devnet SOL to ${wallet} (https://faucet.solana.com). Checking again every 10s.`);
    await sleep(10000);
    balance = await balanceOf(wallet);
  }
  record({ step: "funded", wallet, lamports: balance });

  async function step(name, instruction, makePayload, expectStatus) {
    const before = await balanceOf(wallet);
    const payload = await makePayload();
    status(`STEP ${name}: ${instruction}`);
    const started = Date.now();
    let outcome;
    try {
      outcome = await requestApproval({ relay, payload, timeoutMs: stepTimeoutMs });
    } catch (err) {
      outcome = { status: "error", result: { reason: err.message } };
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    let confirmed = null;
    let after = before;
    if (outcome.status === "approved") {
      await sleep(3000);
      const statuses = await retry("getSignatureStatuses", () =>
        connection.getSignatureStatuses([outcome.result.signature], { searchTransactionHistory: true })
      ).catch(() => null);
      const found = statuses && statuses.value[0];
      confirmed = Boolean(found && !found.err && found.confirmationStatus);
      after = await balanceOf(wallet);
    }
    const entry = {
      step: name,
      expected: expectStatus,
      got: outcome.status,
      pass: outcome.status === expectStatus && (expectStatus !== "approved" || confirmed === true),
      seconds,
      signature: outcome.result && outcome.result.signature,
      reason: outcome.result && outcome.result.reason,
      refreshed: outcome.result && outcome.result.refreshed,
      confirmedOnChain: confirmed,
      walletChangeLamports: after - before,
    };
    record(entry);
    status(`STEP ${name} finished: ${outcome.status}${entry.pass ? " (as expected)" : " (NOT as expected)"}`);
    await sleep(2000);
    return entry;
  }

  const someone = () => Keypair.generate().publicKey.toBase58();
  const keeper = someone(); // one recipient reused so it stays rent-exempt after the first transfer

  await step("3a", "tap APPROVE on the phone (0.002 SOL transfer)", async () => ({
    type: "transfer", to: keeper, lamports: 2_000_000, note: "Test 3a: please APPROVE", agent: "phone-test",
  }), "approved");

  await step("3b", "tap DENY on the phone", async () => ({
    type: "transfer", to: keeper, lamports: 1_000_000, note: "Test 3b: please DENY", agent: "phone-test",
  }), "denied");

  await step("4", `tap APPROVE on the phone (this transaction was built ${holdSeconds}s ago)`, async () => {
    const built = await retry("buildRawTransfer", () => buildRawTransfer({ rpc: connection, from: wallet, to: keeper, lamports: 1_000_000 }));
    status(`STEP 4: built a transaction, now holding it ${holdSeconds}s so its blockhash goes stale. Nothing to tap yet.`);
    await sleep(holdSeconds * 1000);
    return { type: "raw", transactionBase64: built.transactionBase64, note: "Test 4: built minutes ago, please APPROVE", agent: "phone-test" };
  }, "approved");

  await step("5", "read the amount on the phone (should say 0.030005 SOL, not 0.001), then tap DENY", async () => {
    const built = await retry("buildRawTransfer", () => buildRawTransfer({ rpc: connection, from: wallet, to: keeper, lamports: 30_000_000 }));
    return { type: "raw", transactionBase64: built.transactionBase64, note: "tiny 0.001 SOL test payment", agent: "phone-test" };
  }, "denied");

  status("ALL STEPS DONE. See phone-test-logs/results.jsonl");
}

main().catch((err) => {
  status(`DRIVER CRASHED: ${err.message}`);
  process.exit(1);
});
