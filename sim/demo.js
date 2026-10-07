#!/usr/bin/env node
"use strict";
/**
 * The whole loop on one laptop, offline, in about two seconds:
 *   node sim/demo.js
 *
 * Starts the relay, a local Solana stand-in and a pretend phone, then plays an
 * agent through four situations. Nothing here touches a real network or wallet.
 */
const { Keypair, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const { createRelay } = require("../relay/server");
const { createLocalRpc } = require("./local-rpc");
const { createSimPhone } = require("./phone");
const { requestApproval, buildRawTransfer } = require("../agent/client");
const { formatSol } = require("../shared/approval");

async function main() {
  const rpc = createLocalRpc({ port: 0 });
  const rpcUrl = (await rpc.listen()).url;
  const relay = createRelay({ port: 0 });
  const relayUrl = (await relay.listen()).url;

  const wallet = Keypair.generate();
  rpc.airdrop(wallet.publicKey, LAMPORTS_PER_SOL);
  let humanSays = "approve";
  let beforeDeciding = () => {};
  const phone = createSimPhone({
    relayUrl,
    rpcUrl,
    keypair: wallet,
    decide: async (review) => {
      console.log(`   phone shows : ${review.headline}`);
      if (review.request.note) console.log(`   agent's note: "${review.request.note}"`);
      beforeDeciding();
      console.log(`   human taps  : ${humanSays.toUpperCase()}`);
      return humanSays;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 200));

  const show = (outcome) =>
    console.log(
      `   agent gets  : ${outcome.status}${outcome.result && outcome.result.signature ? ` ${outcome.result.signature.slice(0, 20)}...` : ""}${outcome.result && outcome.result.reason ? ` (${outcome.result.reason})` : ""}`
    );
  const balance = () => console.log(`   wallet now  : ${formatSol(rpc.balance(wallet.publicKey))}\n`);
  const someone = () => Keypair.generate().publicKey.toBase58();

  console.log(`\nPhone wallet ${phone.address} starts with ${formatSol(rpc.balance(wallet.publicKey))}\n`);

  console.log("1. Agent asks to send 0.001 SOL. Human approves.");
  show(await requestApproval({ relay: relayUrl, payload: { type: "transfer", to: someone(), lamports: 1_000_000, note: "pay for the API call" } }));
  balance();

  console.log("2. Agent asks again. Human denies.");
  humanSays = "deny";
  show(await requestApproval({ relay: relayUrl, payload: { type: "transfer", to: someone(), lamports: 1_000_000 } }));
  balance();

  console.log("3. Agent sends a finished transaction. The human is slow and its blockhash expires first.");
  humanSays = "approve";
  beforeDeciding = () => {
    rpc.expireBlockhash();
    console.log("   ...time passes, the agent's blockhash is now expired...");
  };
  const slow = await buildRawTransfer({ rpc: rpcUrl, from: phone.address, to: someone(), lamports: 2_000_000 });
  show(await requestApproval({ relay: relayUrl, payload: { type: "raw", transactionBase64: slow.transactionBase64 } }));
  balance();

  console.log('4. A tricked agent says "tiny test payment" but its transaction sends 0.9 SOL.');
  humanSays = "deny";
  beforeDeciding = () => {};
  const trick = await buildRawTransfer({ rpc: rpcUrl, from: phone.address, to: someone(), lamports: 900_000_000 });
  show(await requestApproval({ relay: relayUrl, payload: { type: "raw", transactionBase64: trick.transactionBase64, note: "tiny 0.001 SOL test payment" } }));
  balance();

  phone.close();
  await relay.close();
  await rpc.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
