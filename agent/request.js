#!/usr/bin/env node
"use strict";
/**
 * Plays the part of an AI agent on your laptop.
 *
 *   node agent/request.js transfer --to <ADDRESS> --sol 0.001
 *   node agent/request.js raw      --to <ADDRESS> --sol 0.001
 *
 * "transfer" sends a description and lets the phone build the transaction.
 * "raw" builds the finished transaction here (what real agents and swap APIs
 * do) and sends that. Use --hold 180 with "raw" to wait 3 minutes before
 * sending, which makes the blockhash stale on purpose (feasibility Test 4).
 *
 * Options: --network devnet|mainnet (env NETWORK, default devnet)  --relay URL  --rpc URL  --note TEXT  --timeout SECONDS  --hold SECONDS
 *          --agent NAME  --icon NAME_OR_EMOJI   (how the phone shows this agent; env AGENT_NAME, AGENT_ICON)
 * Env:     RELAY_URL, RELAY_TOKEN, RPC_URL. Without them the pairing saved by agent/pair.js is used.
 */
const { getWalletAddress, requestApproval, buildRawTransfer } = require("./client");
const { resolveAgentConnection, resolveNetwork } = require("./credentials");
const { NETWORKS } = require("../shared/network");

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) args[arg.slice(2)] = true;
      else {
        args[arg.slice(2)] = next;
        i += 1;
      }
    } else args._.push(arg);
  }
  return args;
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args._[0];
  const { relay, token } = resolveAgentConnection({ relayArg: typeof args.relay === "string" ? args.relay : undefined });
  let network;
  try {
    network = resolveNetwork({ arg: args.network });
  } catch (err) {
    fail(err.message);
  }
  const rpc = args.rpc || process.env.RPC_URL || NETWORKS[network].rpc;
  const timeoutMs = Number(args.timeout || 300) * 1000;

  if (mode !== "transfer" && mode !== "raw") {
    fail("Usage: node agent/request.js <transfer|raw> --to <ADDRESS> --sol <AMOUNT> [--note TEXT] [--hold SECONDS]");
  }
  if (typeof args.to !== "string") fail("--to <ADDRESS> is required");
  const sol = Number(args.sol);
  if (!Number.isFinite(sol) || sol <= 0) fail("--sol must be a positive number, e.g. 0.001");
  const lamports = Math.round(sol * 1_000_000_000);
  const note = typeof args.note === "string" ? args.note : `from laptop agent (${mode})`;
  const agent = String(typeof args.agent === "string" ? args.agent : process.env.AGENT_NAME || "laptop-script").slice(0, 60);
  const icon = String(typeof args.icon === "string" ? args.icon : process.env.AGENT_ICON || "").trim().slice(0, 32);
  const identity = { agent, network, ...(icon ? { agentIcon: icon } : {}) };

  let payload;
  if (mode === "transfer") {
    payload = { type: "transfer", to: args.to, lamports, note, ...identity };
  } else {
    const from = await getWalletAddress({ relay, token });
    if (!from) fail("No phone wallet is registered with the relay yet. Open the app and connect the wallet first.");
    const built = await buildRawTransfer({ rpc, from, to: args.to, lamports });
    console.log(`Built an unsigned transaction for ${from} with blockhash ${built.blockhash}`);
    const hold = Number(args.hold || 0);
    if (hold > 0) {
      console.log(`Holding it for ${hold}s so the blockhash goes stale...`);
      await new Promise((resolve) => setTimeout(resolve, hold * 1000));
    }
    payload = { type: "raw", transactionBase64: built.transactionBase64, note, ...identity };
  }

  const started = Date.now();
  const outcome = await requestApproval({
    relay,
    token,
    payload,
    timeoutMs,
    onCreated: (request) => {
      console.log(`Request ${request.id} sent. Phones online: ${request.phonesOnline}. Waiting for the phone...`);
    },
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  if (outcome.status === "approved") {
    console.log(`APPROVED after ${seconds}s`);
    console.log(`signature: ${outcome.result.signature}`);
    if (outcome.result.refreshed === false) console.log("note: blockhash was not refreshed (multi-signer transaction)");
    return;
  }
  console.log(`${outcome.status.toUpperCase()} after ${seconds}s${outcome.result && outcome.result.reason ? `: ${outcome.result.reason}` : ""}`);
  process.exitCode = 1;
}

main().catch((err) => {
  if (err && err.code === "paused") {
    console.error(`PAUSED: ${err.message}`);
    process.exit(3);
  }
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
