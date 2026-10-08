"use strict";
/**
 * Laptop side of pairing: make the keys, register them with the relay, and
 * (for tests and the simulator) play the phone's part in one call.
 *
 * The relay only ever receives hashes of the agent key and the claim code.
 */
const crypto = require("crypto");
const { buildPairingUrl, claimPairing, makeToken } = require("../shared/pairing");

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const randomB64 = (bytes) => crypto.randomBytes(bytes).toString("base64url");

async function readError(response) {
  const text = await response.text().catch(() => "");
  try {
    return JSON.parse(text).error || text;
  } catch (_err) {
    return text;
  }
}

/**
 * Register a new pairing. Resolves with
 * { id, relay, label, agentToken, pairingUrl, expiresAt }.
 * Show `pairingUrl` to the phone as a QR code.
 */
async function createPairing({ relay, label = "Laptop", registrationKey = "", fetchImpl = fetch }) {
  const base = relay.replace(/\/+$/, "");
  const id = randomB64(16);
  const agentKey = randomB64(32);
  const secret = randomB64(32);
  const headers = { "content-type": "application/json" };
  if (registrationKey) headers["x-nod-registration-key"] = registrationKey;
  let response;
  try {
    response = await fetchImpl(`${base}/pairings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id, agentKeyHash: sha256(agentKey), claimHash: sha256(secret), label }),
    });
  } catch (err) {
    throw new Error(`Could not reach the relay at ${base}: ${err.message}. Is it running?`);
  }
  if (!response.ok) throw new Error(`The relay refused the pairing (${response.status}): ${await readError(response)}`);
  const body = await response.json();
  return {
    id,
    relay: base,
    label,
    agentToken: makeToken(id, agentKey),
    pairingUrl: buildPairingUrl({ relay: base, id, secret }),
    expiresAt: body.expiresAt,
  };
}

/** Ask the relay about this pairing. Resolves with { state, phoneOnline, ... } or throws with the status. */
async function pairingStatus({ relay, token, fetchImpl = fetch }) {
  const response = await fetchImpl(`${relay.replace(/\/+$/, "")}/pairing`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const error = new Error(`Relay error ${response.status}: ${await readError(response)}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

/** Revoke from the laptop. The phone is dropped and anything waiting is cancelled. */
async function revokePairing({ relay, token, fetchImpl = fetch }) {
  const response = await fetchImpl(`${relay.replace(/\/+$/, "")}/pairing`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Relay error ${response.status}: ${await readError(response)}`);
}

/**
 * Pair and claim in one step, for tests and the simulator.
 * @returns {{ id, relay, agentToken, phoneToken }}
 */
async function pairForTesting({ relay, label = "Test laptop", registrationKey = "" }) {
  const created = await createPairing({ relay, label, registrationKey });
  const claimed = await claimPairing({ link: created.pairingUrl, fetchImpl: fetch });
  return { id: created.id, relay: created.relay, agentToken: created.agentToken, phoneToken: claimed.token };
}

module.exports = { createPairing, pairingStatus, revokePairing, pairForTesting };
