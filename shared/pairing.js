"use strict";
/**
 * Pairing as the phone sees it (and the phone simulator, which runs the same code).
 *
 * The laptop shows a QR code holding   nod://pair?relay=<url>&id=<id>&secret=<code>
 * where <code> is a one-time claim code. The phone picks a key of its own,
 * claims the pairing at the relay and keeps  <id>.<phoneKey>  as its token.
 * The claim code is useless after that, and so is a photo of the QR code.
 */

class PairingError extends Error {
  /** @param code machine-readable reason, e.g. "invalid_code" */
  constructor(code, message) {
    super(message);
    this.name = "PairingError";
    this.code = code;
  }
}

const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{32,128}$/;
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url, without padding. Does not need Buffer, so it runs in React Native. */
function encodeBase64Url(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64URL[a >> 2] + B64URL[((a & 3) << 4) | (b >> 4)];
    if (i + 1 < bytes.length) out += B64URL[((b & 15) << 2) | (c >> 6)];
    if (i + 2 < bytes.length) out += B64URL[c & 63];
  }
  return out;
}

/** 32 random bytes as base64url. `cryptoImpl` needs getRandomValues (Node, and RN with the polyfill). */
function randomKey(cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl || typeof cryptoImpl.getRandomValues !== "function") {
    throw new PairingError("no_random", "This device has no secure random number source");
  }
  return encodeBase64Url(cryptoImpl.getRandomValues(new Uint8Array(32)));
}

/** The bearer token for relay calls. */
function makeToken(id, key) {
  return `${id}.${key}`;
}

function buildPairingUrl({ relay, id, secret }) {
  return `nod://pair?relay=${encodeURIComponent(relay)}&id=${encodeURIComponent(id)}&secret=${encodeURIComponent(secret)}`;
}

/** Read a pairing link. Throws PairingError("invalid_code") if it is not one of ours. */
function parsePairingUrl(text) {
  const bad = () => new PairingError("invalid_code", "That is not a Nod pairing code. Scan the code that `npm run pair` shows.");
  if (typeof text !== "string") throw bad();
  const trimmed = text.trim();
  const prefix = "nod://pair?";
  if (!trimmed.toLowerCase().startsWith(prefix)) throw bad();
  const params = {};
  for (const part of trimmed.slice(prefix.length).split("&")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    try {
      params[part.slice(0, eq)] = decodeURIComponent(part.slice(eq + 1));
    } catch (_err) {
      throw bad();
    }
  }
  const { relay, id, secret } = params;
  if (typeof relay !== "string" || !/^https?:\/\/[^\s/]+/i.test(relay)) throw bad();
  if (!ID_RE.test(String(id)) || !SECRET_RE.test(String(secret))) throw bad();
  return { relay: relay.replace(/\/+$/, ""), id, secret };
}

/**
 * Claim the pairing. Resolves with what the phone must keep:
 * { id, relay, label, key, token }. Throws PairingError with a message fit for the screen.
 * `allowInsecure` (default true, for laptops and tests) lets a plain http:// relay through;
 * the phone app passes false in release builds, because a pairing key sent over http can be read.
 */
async function claimPairing({ link, fetchImpl, cryptoImpl, allowInsecure = true }) {
  const { relay, id, secret } = typeof link === "string" ? parsePairingUrl(link) : link;
  if (!allowInsecure && !/^https:\/\//i.test(relay)) {
    throw new PairingError("insecure_relay", "This relay does not use HTTPS, so Nod will not pair with it. Ask for an https:// address.");
  }
  const key = randomKey(cryptoImpl);
  let response;
  try {
    response = await fetchImpl(`${relay}/pairings/${encodeURIComponent(id)}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ claim: secret, phoneKey: key }),
    });
  } catch (_err) {
    throw new PairingError("unreachable", `Could not reach the relay at ${relay}. Check that it is running and that this phone can reach it.`);
  }
  if (response.ok) {
    const body = await response.json().catch(() => ({}));
    return { id, relay, label: typeof body.label === "string" ? body.label : "Laptop", key, token: makeToken(id, key) };
  }
  if (response.status === 404) {
    throw new PairingError("expired", "This pairing code has expired or does not exist. Run the pairing command again.");
  }
  if (response.status === 409) {
    throw new PairingError("used", "This pairing code was already used. Run the pairing command again for a new one.");
  }
  if (response.status === 403) {
    throw new PairingError("wrong_code", "The pairing code was not accepted. Run the pairing command again.");
  }
  throw new PairingError("failed", `The relay refused the pairing (${response.status}).`);
}

module.exports = {
  PairingError,
  encodeBase64Url,
  randomKey,
  makeToken,
  buildPairingUrl,
  parsePairingUrl,
  claimPairing,
};
