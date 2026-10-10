"use strict";
/**
 * Core approval logic. This one file is used by BOTH the phone app (React
 * Native) and the laptop tests, so what the tests prove is what the phone runs.
 *
 * It never touches a private key. Signing is done by whatever `signAndSend`
 * function the caller passes in: the mobile wallet on the phone, a throwaway
 * test key in the simulator.
 */
const { Buffer } = require("buffer");
const {
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} = require("@solana/web3.js");

const LAMPORTS_PER_SOL = 1_000_000_000;
const MAX_NOTE_LENGTH = 280;
// A serialized Solana transaction is at most 1232 bytes. Base64 of that is 1644 chars.
const MAX_TX_BASE64_LENGTH = 1644;

const KNOWN_PROGRAMS = {
  "11111111111111111111111111111111": "System Program",
  ComputeBudget111111111111111111111111111111: "Compute Budget",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "Token Program",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022 Program",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token Program",
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo Program",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter Aggregator v6",
};

class ApprovalError extends Error {
  /**
   * @param {string} code machine-readable reason, e.g. "wrong_fee_payer"
   * @param {string} message human-readable explanation
   */
  constructor(code, message) {
    super(message);
    this.name = "ApprovalError";
    this.code = code;
  }
}

function toPublicKey(value, field) {
  try {
    return value instanceof PublicKey ? value : new PublicKey(value);
  } catch (_err) {
    throw new ApprovalError("bad_address", `${field} is not a valid Solana address`);
  }
}

/**
 * Check a request payload that arrived from the relay. The phone must never
 * trust the relay or the agent, so everything is validated here again.
 * @returns a clean copy of the payload
 */
function validateRequest(payload) {
  if (!payload || typeof payload !== "object") {
    throw new ApprovalError("bad_request", "Request is empty or not an object");
  }
  const note = payload.note === undefined || payload.note === null ? "" : payload.note;
  if (typeof note !== "string" || note.length > MAX_NOTE_LENGTH) {
    throw new ApprovalError("bad_request", `note must be text of at most ${MAX_NOTE_LENGTH} characters`);
  }
  const agent = typeof payload.agent === "string" ? payload.agent.slice(0, 60) : "";

  if (payload.type === "transfer") {
    const to = toPublicKey(payload.to, "to").toBase58();
    const lamports = payload.lamports;
    if (!Number.isSafeInteger(lamports) || lamports <= 0) {
      throw new ApprovalError("bad_request", "lamports must be a positive whole number");
    }
    return { type: "transfer", to, lamports, note, agent };
  }

  if (payload.type === "raw") {
    const b64 = payload.transactionBase64;
    if (typeof b64 !== "string" || b64.length === 0) {
      throw new ApprovalError("bad_request", "transactionBase64 is missing");
    }
    if (b64.length > MAX_TX_BASE64_LENGTH || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
      throw new ApprovalError("bad_request", "transactionBase64 is not a valid base64 Solana transaction");
    }
    return { type: "raw", transactionBase64: b64, note, agent };
  }

  throw new ApprovalError("bad_request", `Unknown request type: ${String(payload.type)}`);
}

function emptySignatures(count) {
  return Array.from({ length: count }, () => new Uint8Array(64));
}

/**
 * Turn a request into a transaction that is ready for the wallet to sign.
 *
 * - "transfer": built here from scratch with the fresh blockhash.
 * - "raw": the agent's transaction is decoded, checked, and its blockhash is
 *   replaced with the fresh one so a slow human does not cause an expiry.
 *
 * The blockhash can only be replaced when the wallet is the ONLY signer.
 * If someone else has to sign too, their signature covers the old blockhash,
 * so the transaction is left untouched and `refreshed` is false.
 *
 * @param payload a request payload (validated again here)
 * @param walletAddress the phone wallet's address (PublicKey or base58)
 * @param {string} blockhash a recent blockhash fetched just now
 * @returns {{ transaction: VersionedTransaction, refreshed: boolean, signerCount: number }}
 */
function prepareTransaction(payload, walletAddress, blockhash) {
  const request = validateRequest(payload);
  const wallet = toPublicKey(walletAddress, "wallet");
  if (typeof blockhash !== "string" || blockhash.length === 0) {
    throw new ApprovalError("no_blockhash", "A recent blockhash is required");
  }

  if (request.type === "transfer") {
    const to = new PublicKey(request.to);
    if (to.equals(wallet)) {
      throw new ApprovalError("bad_request", "Transfer destination is the wallet itself");
    }
    const message = new TransactionMessage({
      payerKey: wallet,
      recentBlockhash: blockhash,
      instructions: [
        SystemProgram.transfer({ fromPubkey: wallet, toPubkey: to, lamports: request.lamports }),
      ],
    }).compileToLegacyMessage();
    return { transaction: new VersionedTransaction(message), refreshed: true, signerCount: 1 };
  }

  let transaction;
  try {
    // Handles both legacy and v0 transactions.
    transaction = VersionedTransaction.deserialize(Buffer.from(request.transactionBase64, "base64"));
  } catch (_err) {
    throw new ApprovalError("bad_transaction", "Could not decode the transaction the agent sent");
  }

  const message = transaction.message;
  const signerCount = message.header.numRequiredSignatures;
  const signers = message.staticAccountKeys.slice(0, signerCount);
  if (signerCount < 1 || signers.length !== signerCount) {
    throw new ApprovalError("bad_transaction", "Transaction has no valid signer list");
  }
  if (!signers[0].equals(wallet)) {
    // The first signer pays the fee. If that is not this wallet, the agent
    // built the transaction for someone else (or is confused about who we are).
    throw new ApprovalError(
      "wrong_fee_payer",
      `Transaction fee payer is ${signers[0].toBase58()}, not this wallet`
    );
  }

  if (signerCount === 1) {
    message.recentBlockhash = blockhash;
    transaction.signatures = emptySignatures(1);
    return { transaction, refreshed: true, signerCount };
  }

  // Multi-signer: keep the agent's blockhash and any signatures already present.
  if (transaction.signatures.length !== signerCount) {
    transaction.signatures = emptySignatures(signerCount);
  }
  return { transaction, refreshed: false, signerCount };
}

function readU32LE(bytes, offset) {
  return (
    (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
  );
}

function readU64LEAsNumber(bytes, offset) {
  // Lamport amounts above 2^53 cannot be exact in a JS number; return null then.
  let value = 0n;
  for (let i = 7; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[offset + i]);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

/**
 * Describe a transaction in plain terms WITHOUT running it: which programs it
 * calls and any plain SOL transfers it contains. This is the fallback when
 * simulation is unavailable, and a cross-check when it is.
 */
function summarizeTransaction(transaction) {
  const message = transaction.message;
  const keys = message.staticAccountKeys;
  const programs = [];
  const transfers = [];
  const systemProgram = SystemProgram.programId.toBase58();

  for (const ix of message.compiledInstructions) {
    const programKey = keys[ix.programIdIndex];
    const programId = programKey ? programKey.toBase58() : "unknown";
    if (!programs.some((p) => p.id === programId)) {
      programs.push({ id: programId, name: KNOWN_PROGRAMS[programId] || null });
    }
    const data = ix.data;
    const isSystemTransfer =
      programId === systemProgram && data.length === 12 && readU32LE(data, 0) === 2;
    if (isSystemTransfer) {
      const from = keys[ix.accountKeyIndexes[0]];
      const to = keys[ix.accountKeyIndexes[1]];
      transfers.push({
        from: from ? from.toBase58() : "unknown (lookup table)",
        to: to ? to.toBase58() : "unknown (lookup table)",
        lamports: readU64LEAsNumber(data, 4),
      });
    }
  }

  return {
    programs,
    transfers,
    instructionCount: message.compiledInstructions.length,
    signerCount: message.header.numRequiredSignatures,
    usesLookupTables: (message.addressTableLookups || []).length > 0,
    unknownPrograms: programs.filter((p) => !p.name).map((p) => p.id),
  };
}

/**
 * Simulate the transaction and report what it would do to the wallet's SOL
 * balance. Never throws for a failing simulation: it returns ok=false so the
 * screen can still show the summary and let the user deny.
 *
 * @param chain see rpcChain() in ./chain.js
 */
async function previewTransaction(chain, transaction, walletAddress) {
  const wallet = toPublicKey(walletAddress, "wallet");
  const result = {
    ok: false,
    preLamports: null,
    postLamports: null,
    deltaLamports: null,
    feeLamports: null,
    error: null,
    logs: [],
  };
  try {
    const [pre, sim, fee] = await Promise.all([
      chain.getBalance(wallet),
      chain.simulate(transaction, wallet),
      chain.getFee(transaction.message).catch(() => null),
    ]);
    result.preLamports = pre;
    result.feeLamports = fee;
    result.logs = sim.logs || [];
    if (sim.err) {
      result.error = typeof sim.err === "string" ? sim.err : JSON.stringify(sim.err);
      return result;
    }
    if (typeof sim.postLamports !== "number") {
      result.error = "Simulation did not return the wallet balance";
      return result;
    }
    result.postLamports = sim.postLamports;
    result.deltaLamports = sim.postLamports - pre;
    result.ok = true;
    return result;
  } catch (err) {
    result.error = err && err.message ? err.message : String(err);
    return result;
  }
}

function formatSol(lamports) {
  if (typeof lamports !== "number") return "?";
  const sign = lamports < 0 ? "-" : "";
  const abs = Math.abs(lamports);
  const whole = Math.floor(abs / LAMPORTS_PER_SOL);
  const frac = String(abs % LAMPORTS_PER_SOL).padStart(9, "0").replace(/0+$/, "");
  return `${sign}${whole}${frac ? "." + frac : ""} SOL`;
}

/** One sentence for the approval screen, e.g. "You send 0.001005 SOL (network fee included)". */
function describePreview(preview) {
  if (!preview || !preview.ok) {
    return `Could not simulate: ${preview && preview.error ? preview.error : "unknown error"}`;
  }
  const delta = preview.deltaLamports;
  if (delta < 0) return `You send ${formatSol(-delta)} (network fee included)`;
  if (delta > 0) return `You receive ${formatSol(delta)}`;
  return "No change to your SOL balance";
}

/**
 * Step 1, when a request arrives: build the transaction and work out what it
 * does, for display. Nothing is signed.
 */
async function reviewRequest({ payload, walletAddress, chain }) {
  const request = validateRequest(payload);
  const latest = await chain.getLatestBlockhash();
  const prepared = prepareTransaction(request, walletAddress, latest.blockhash);
  const summary = summarizeTransaction(prepared.transaction);
  const preview = await previewTransaction(chain, prepared.transaction, walletAddress);
  return {
    request,
    summary,
    preview,
    headline: describePreview(preview),
    refreshable: prepared.refreshed,
    signerCount: prepared.signerCount,
  };
}

/**
 * Step 2, when the user taps Approve: rebuild with a blockhash fetched right
 * now (the user may have taken minutes to decide), then hand it to the wallet.
 *
 * @param signAndSend async (transaction, minContextSlot) => base58 signature
 * @returns {{ signature: string, refreshed: boolean }}
 */
async function approveRequest({ payload, walletAddress, chain, signAndSend }) {
  const latest = await chain.getLatestBlockhash();
  const prepared = prepareTransaction(payload, walletAddress, latest.blockhash);
  const signature = await signAndSend(prepared.transaction, latest.slot);
  if (typeof signature !== "string" || signature.length === 0) {
    throw new ApprovalError("no_signature", "The wallet did not return a transaction signature");
  }
  return { signature, refreshed: prepared.refreshed };
}

module.exports = {
  ApprovalError,
  KNOWN_PROGRAMS,
  LAMPORTS_PER_SOL,
  validateRequest,
  prepareTransaction,
  summarizeTransaction,
  previewTransaction,
  describePreview,
  formatSol,
  reviewRequest,
  approveRequest,
};
