"use strict";
/**
 * Agent-side helper: ask the phone to approve something and wait for the answer.
 * The agent never holds the user's key. It only gets back a signature or a "no".
 */
const {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} = require("@solana/web3.js");

const { DEFAULT_NETWORK } = require("../shared/network");

const POLL_WAIT_SECONDS = 25;

function headers(token) {
  const base = { "content-type": "application/json" };
  if (token) base.authorization = `Bearer ${token}`;
  return base;
}

async function readJson(response) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch (_err) {
    body = { error: text };
  }
  if (response.status === 423) {
    // The user pressed "Pause everything" on their phone. Not an error to retry through.
    throw Object.assign(new Error(body.error || "Approvals are paused on the phone."), { code: "paused", status: 423 });
  }
  if (!response.ok) {
    const hint = response.status === 401 ? ' Pair this laptop with your phone first: node agent/pair.js' : "";
    throw new Error(`Relay error ${response.status}: ${body.error || text}.${hint}`.replace("..", "."));
  }
  return body;
}

/** The address of the wallet on the paired phone, or null if no phone has connected yet. */
async function getWalletAddress({ relay, token = "" }) {
  const body = await readJson(await fetch(`${relay}/wallet`, { headers: headers(token) }));
  return body.address || null;
}

/**
 * Send a request to the phone and wait until it is approved, denied, failed or expired.
 * If nobody answers within timeoutMs the request is withdrawn from the phone.
 * @param network "devnet" (default) or "mainnet": which network the request is for.
 * @param payload { type: "transfer", to, lamports, note?, agent?, agentIcon? } or { type: "raw", transactionBase64, note?, agent?, agentIcon? }
 * Throws an error with `code: "paused"` if the user has paused approvals on the phone.
 * @returns {{ id, status, result }} status is approved | denied | failed | expired | timeout
 */
async function requestApproval({ relay, token = "", payload, network = DEFAULT_NETWORK, timeoutMs = 5 * 60 * 1000, onCreated }) {
  const deadline = Date.now() + timeoutMs;
  // Every request names its network. A payload that already says so keeps its own.
  if (!payload.network) payload = { ...payload, network };
  let request = await readJson(
    await fetch(`${relay}/requests`, { method: "POST", headers: headers(token), body: JSON.stringify(payload) })
  );
  if (onCreated) onCreated(request);

  while (request.status === "pending") {
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    if (remaining <= 0) {
      // Withdraw the request so it cannot be approved after we stop listening.
      const cancelled = await readJson(
        await fetch(`${relay}/requests/${request.id}/cancel`, { method: "POST", headers: headers(token) })
      ).catch(() => null);
      // If the phone answered in the same instant, report that real answer.
      if (cancelled && cancelled.status !== "cancelled") {
        return { id: cancelled.id, status: cancelled.status, result: cancelled.result };
      }
      return { id: request.id, status: "timeout", result: null };
    }
    const wait = Math.min(POLL_WAIT_SECONDS, remaining);
    request = await readJson(
      await fetch(`${relay}/requests/${request.id}?wait=${wait}`, { headers: headers(token) })
    );
  }
  return { id: request.id, status: request.status, result: request.result };
}

/**
 * Build an unsigned SOL transfer the way a real agent would: a finished
 * transaction with the phone wallet as fee payer, serialized to base64.
 */
async function buildRawTransfer({ rpc, from, to, lamports }) {
  const connection = typeof rpc === "string" ? new Connection(rpc, "confirmed") : rpc;
  const payer = new PublicKey(from);
  const { blockhash } = await connection.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey(to), lamports })],
  }).compileToLegacyMessage();
  const transaction = new VersionedTransaction(message);
  return { transactionBase64: Buffer.from(transaction.serialize()).toString("base64"), blockhash };
}

module.exports = { getWalletAddress, requestApproval, buildRawTransfer };
