#!/usr/bin/env node
"use strict";
/**
 * Pair this laptop with your phone.
 *
 *   node agent/pair.js                  show a QR code, wait for the phone to scan it
 *   node agent/pair.js --status         is the pairing alive, is the phone online?
 *   node agent/pair.js --revoke         end the pairing from the laptop
 *
 * Options: --relay URL  --label NAME  --env (print RELAY_URL / RELAY_TOKEN lines)
 * Env:     RELAY_URL (default http://localhost:8787), RELAY_REGISTRATION_KEY
 *
 * After the phone scans the code, the relay address and an agent key are saved in
 * ~/.nod/agent.json (override the folder with NOD_CONFIG_DIR). The MCP server and
 * agent/request.js read it, so they need no further setup.
 */
const os = require("os");
const { createPairing, pairingStatus, revokePairing } = require("./pairing");
const {
  clearAgentCredentials,
  loadAgentCredentials,
  resolveAgentConnection,
  saveAgentCredentials,
} = require("./credentials");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = {};
  const rest = argv[0] === "pair" ? argv.slice(1) : argv; // allows `nod pair`
  for (let i = 0; i < rest.length; i += 1) {
    if (!rest[i].startsWith("--")) continue;
    const name = rest[i].slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) args[name] = true;
    else {
      args[name] = next;
      i += 1;
    }
  }
  return args;
}

function isLocal(relay) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(relay);
}

async function showQr(text) {
  try {
    const qrcode = require("qrcode-terminal");
    await new Promise((resolve) => qrcode.generate(text, { small: true }, (art) => resolve(console.log(art))));
  } catch (_err) {
    console.log("(Could not draw the QR code here. Paste the link below into the app instead.)");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { relay } = resolveAgentConnection({ relayArg: typeof args.relay === "string" ? args.relay : undefined });

  if (args.status || args.revoke) {
    const saved = loadAgentCredentials();
    if (!saved) {
      console.error("This laptop is not paired. Run: node agent/pair.js");
      process.exit(1);
    }
    if (args.status) {
      const status = await pairingStatus({ relay: saved.relay, token: saved.token }).catch((err) => {
        console.error(
          err.status === 401 ? "The pairing no longer exists on the relay (revoked or expired). Pair again." : err.message
        );
        process.exit(1);
      });
      console.log(`Pairing ${status.id} (${status.label}): ${status.state}, phone ${status.phoneOnline ? "online" : "offline"}`);
      return;
    }
    await revokePairing({ relay: saved.relay, token: saved.token }).catch((err) => {
      console.error(`Could not tell the relay (${err.message}). Removing the saved key anyway.`);
    });
    clearAgentCredentials();
    console.log("Pairing revoked. The phone is disconnected and the saved key is gone.");
    return;
  }

  if (!isLocal(relay) && !/^https:/i.test(relay)) {
    console.error(`Refusing to pair over plain http with ${relay}: the pairing key would travel unencrypted. Use https.`);
    process.exit(1);
  }
  const label = typeof args.label === "string" ? args.label : os.hostname().replace(/\.local$/, "");
  const created = await createPairing({
    relay,
    label,
    registrationKey: process.env.RELAY_REGISTRATION_KEY || "",
  }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });

  console.log(`\nPairing "${label}" with your phone via ${relay}\n`);
  await showQr(created.pairingUrl);
  console.log("Open Nod on your phone, choose Pair with laptop and scan this code.");
  console.log("No camera? Paste this link into the app instead:\n");
  console.log(created.pairingUrl);
  console.log(`\nThe code works once and expires in ${Math.round((created.expiresAt - Date.now()) / 60000)} minutes.\n`);

  while (Date.now() < created.expiresAt) {
    await sleep(1000);
    const status = await pairingStatus({ relay: created.relay, token: created.agentToken }).catch(() => null);
    if (!status) break; // dropped by the relay
    if (status.state === "active") {
      const file = saveAgentCredentials({
        relay: created.relay,
        token: created.agentToken,
        id: created.id,
        label,
      });
      console.log("Paired. Your phone can now approve what your agents ask for.");
      console.log(`Saved the agent key to ${file}. The MCP server and agent/request.js use it automatically.`);
      if (args.env) {
        console.log(`\nFor agents that need explicit config:\nRELAY_URL=${created.relay}\nRELAY_TOKEN=${created.agentToken}`);
      }
      console.log(`Saved key can only ask, never approve. Revoke any time: node agent/pair.js --revoke (or in the app).`);
      return;
    }
  }
  console.error("The code expired before the phone scanned it. Run the command again.");
  process.exit(1);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
