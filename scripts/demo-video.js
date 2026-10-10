#!/usr/bin/env node
"use strict";
/**
 * Demo script for recording the video. Run:  npm run demo:video
 *
 * It plays three agent requests against your phone, one at a time, and waits
 * for you to press Enter before each one, so you control the pacing:
 *
 *   a) Research agent: a normal 0.002 SOL payment.
 *   b) Trading agent: the note says "tiny 0.001 SOL test payment" but the
 *      request really sends 0.03 SOL. The phone shows the simulated truth.
 *   c) Payments agent: a repeat 0.001 SOL payment to the address you approved
 *      in (a). With auto-approve on, it goes through without a card.
 *
 * Uses the pairing saved by `npm run pair` (~/.nod/agent.json).
 * Required: NOD_DEMO_RECIPIENT, a devnet address to pay (use a wallet you own).
 * Optional: --relay URL, --only a,c (run just some steps), --timeout SECONDS.
 */
const readline = require("node:readline");
const { PublicKey } = require("@solana/web3.js");
const { requestApproval } = require("../agent/client");
const { resolveAgentConnection } = require("../agent/credentials");

const LAMPORTS_PER_SOL = 1_000_000_000;

const STEPS = [
  {
    id: "a",
    title: "A normal request",
    agent: "Research agent",
    icon: "🔎",
    sol: 0.002,
    note: "Pay for a data report",
    before: [
      "The Research agent asks for 0.002 SOL. Nothing odd here.",
      "On the phone: open the card and tap the approve button, then approve in the wallet.",
      "This also marks the recipient as approved by hand, which step c needs.",
    ],
  },
  {
    id: "b",
    title: "The risky one",
    agent: "Trading agent",
    icon: "📈",
    sol: 0.03,
    note: "tiny 0.001 SOL test payment",
    before: [
      "The Trading agent SAYS it is a tiny 0.001 SOL test payment, but it really sends 0.03 SOL.",
      "On the phone: show that the card lists the simulated 0.03 SOL, not the note. Then deny it.",
    ],
  },
  {
    id: "c",
    title: "Auto-approve",
    agent: "Payments agent",
    icon: "🔁",
    sol: 0.001,
    note: "Repeat payment",
    before: [
      "A repeat 0.001 SOL payment to the address you approved in step a.",
      "With auto-approve on and room left in the daily limit, the phone should approve it by itself.",
      "(The wallet may still ask for its own signature.)",
    ],
  },
];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[argv[i].slice(2)] = true;
    else {
      args[argv[i].slice(2)] = next;
      i += 1;
    }
  }
  return args;
}

function validateRecipient(value) {
  if (!value) {
    throw new Error(
      "NOD_DEMO_RECIPIENT is not set. Set it to a devnet address you own, e.g.\n  NOD_DEMO_RECIPIENT=<ADDRESS> npm run demo:video"
    );
  }
  try {
    const key = new PublicKey(value);
    if (!PublicKey.isOnCurve(key.toBytes())) throw new Error("off curve");
    return key.toBase58();
  } catch {
    throw new Error(`NOD_DEMO_RECIPIENT is not a valid Solana address: ${value}`);
  }
}

function selectSteps(only) {
  if (!only) return STEPS;
  const ids = String(only).toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !STEPS.some((s) => s.id === id));
  if (unknown.length || !ids.length) throw new Error(`--only takes a, b or c (comma separated), got: ${only}`);
  return STEPS.filter((s) => ids.includes(s.id));
}

/**
 * Runs the steps. Everything it touches is passed in so tests can stub it.
 * @returns {Array<{ id, status, seconds }>}
 */
async function runDemo({ relay, token, recipient, steps = STEPS, timeoutMs = 5 * 60 * 1000, ask, log = console.log, request = requestApproval, now = Date.now }) {
  const results = [];
  log(`Recipient: ${recipient}\nRelay:     ${relay}\n`);
  for (const step of steps) {
    log(`\n=== Step ${step.id.toUpperCase()}: ${step.title} ===`);
    step.before.forEach((line) => log(`  ${line}`));
    await ask(`\nPress Enter to send step ${step.id.toUpperCase()} (${step.agent}, ${step.sol} SOL)... `);
    const payload = {
      type: "transfer",
      to: recipient,
      lamports: Math.round(step.sol * LAMPORTS_PER_SOL),
      note: step.note,
      agent: step.agent,
      agentIcon: step.icon,
    };
    const started = now();
    let outcome;
    try {
      outcome = await request({
        relay,
        token,
        payload,
        timeoutMs,
        onCreated: (r) => log(`  Sent. Phones online: ${r.phonesOnline}. Waiting for the phone...`),
      });
    } catch (err) {
      if (err && err.code === "paused") {
        log(`  PAUSED: ${err.message}\n  Turn "Pause everything" off in the app, then run the step again with --only ${step.id}.`);
        results.push({ id: step.id, status: "paused", seconds: 0 });
        continue;
      }
      throw err;
    }
    const seconds = (now() - started) / 1000;
    results.push({ id: step.id, status: outcome.status, seconds });
    const shown = seconds.toFixed(1);
    if (outcome.status === "approved") {
      log(`  APPROVED after ${shown}s`);
      if (outcome.result && outcome.result.signature) log(`  signature: ${outcome.result.signature}`);
      if (step.id === "c" && seconds > 8) {
        log("  Note: that took a while, so it probably needed a tap. Check that auto-approve is on and step a was approved by hand.");
      }
    } else {
      const reason = outcome.result && outcome.result.reason ? `: ${outcome.result.reason}` : "";
      log(`  ${outcome.status.toUpperCase()} after ${shown}s${reason}`);
      if (step.id === "a" && outcome.status !== "approved") {
        log("  Step c needs this recipient to be approved by hand first.");
      }
    }
  }
  log("\nDone.");
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let recipient;
  let steps;
  try {
    recipient = validateRecipient(process.env.NOD_DEMO_RECIPIENT);
    steps = selectSteps(args.only);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const { relay, token } = resolveAgentConnection({ relayArg: typeof args.relay === "string" ? args.relay : undefined });
  if (!token) {
    console.error("No saved pairing found. Run `npm run pair -- --relay <URL>` first (see the README).");
    process.exit(2);
  }
  console.log(
    [
      "Before you record, on the phone:",
      "  - Settings: turn auto-approve on and set a daily limit of about 0.01 SOL.",
      "    (That is enough for steps a and c, and too small for the 0.03 SOL in step b.)",
      "  - Pause everything is off. Nod is open and in the foreground.",
      "  - Use a recipient the phone has not approved yet, so step a shows a card.",
      "",
    ].join("\n")
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("close", () => {});
  const ask = (prompt) =>
    new Promise((resolve, reject) => {
      const onClose = () => reject(new Error("Input closed before the demo finished."));
      rl.once("close", onClose);
      rl.question(prompt, () => {
        rl.removeListener("close", onClose);
        resolve();
      });
    });
  try {
    await runDemo({ relay, token, recipient, steps, timeoutMs: Number(args.timeout || 300) * 1000, ask });
  } finally {
    rl.close();
  }
}

module.exports = { STEPS, parseArgs, validateRecipient, selectSteps, runDemo };

if (require.main === module) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
