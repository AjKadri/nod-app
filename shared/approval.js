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
const { NETWORKS, parseNetwork, networkMismatchMessage } = require("./network");
const tokens = require("./tokens");

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
  // Which network the agent means. Left out when missing or unknown: reviewRequest refuses those.
  const network = parseNetwork(payload.network);
  const withNetwork = (clean) => (network ? { ...clean, network } : clean);

  if (payload.type === "transfer") {
    const to = toPublicKey(payload.to, "to").toBase58();
    const lamports = payload.lamports;
    if (!Number.isSafeInteger(lamports) || lamports <= 0) {
      throw new ApprovalError("bad_request", "lamports must be a positive whole number");
    }
    return withNetwork({ type: "transfer", to, lamports, note, agent });
  }

  if (payload.type === "token_transfer") {
    const mint = toPublicKey(payload.mint, "mint").toBase58();
    const to = toPublicKey(payload.to, "to").toBase58();
    // The amount is a decimal string in whole tokens ("250", "0.5"). It is turned into the token's
    // smallest units on the phone, using the decimals read from the mint on chain.
    const amount = typeof payload.amount === "number" && Number.isFinite(payload.amount) ? String(payload.amount) : payload.amount;
    if (typeof amount !== "string" || !/^\d{1,24}(\.\d{1,30})?$/.test(amount.trim()) || !/[1-9]/.test(amount)) {
      throw new ApprovalError("bad_request", "amount must be a positive number of tokens, like 250 or 0.5");
    }
    return withNetwork({ type: "token_transfer", mint, to, amount: amount.trim(), note, agent });
  }

  if (payload.type === "raw") {
    const b64 = payload.transactionBase64;
    if (typeof b64 !== "string" || b64.length === 0) {
      throw new ApprovalError("bad_request", "transactionBase64 is missing");
    }
    if (b64.length > MAX_TX_BASE64_LENGTH || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
      throw new ApprovalError("bad_request", "transactionBase64 is not a valid base64 Solana transaction");
    }
    return withNetwork({ type: "raw", transactionBase64: b64, note, agent });
  }

  throw new ApprovalError("bad_request", `Unknown request type: ${String(payload.type)}`);
}

/**
 * Refuse a request that is not for the network this phone is on, and a phone whose RPC server is
 * not that network. Called before anything is shown or signed. Fails closed: a request that does
 * not name a network is refused, and so is a chain that cannot prove which network it is.
 */
async function assertNetwork(request, chain) {
  const phone = chain && chain.network;
  if (!NETWORKS[phone] || typeof chain.verifyNetwork !== "function") {
    throw new ApprovalError("no_network", "This phone could not tell which network it is on, so Nod refused the request. Nothing was signed.");
  }
  if (request.network !== phone) {
    throw new ApprovalError("wrong_network", networkMismatchMessage(request.network, phone));
  }
  await chain.verifyNetwork();
}

/**
 * Look up what building the request needs from the chain. Only a token transfer needs anything: the
 * mint's decimals and token program (read from the mint account, never assumed) and whether the
 * recipient already has a token account for it.
 */
async function resolveRequestContext(request, walletAddress, chain) {
  if (request.type !== "token_transfer") return {};
  const wallet = toPublicKey(walletAddress, "wallet");
  const to = new PublicKey(request.to);
  if (to.equals(wallet)) throw new ApprovalError("bad_request", "Transfer destination is the wallet itself");
  const mint = new PublicKey(request.mint);
  const [mintAccount] = await chain.getAccounts([mint]);
  if (!mintAccount) {
    throw new ApprovalError("bad_token", `That token does not exist on ${NETWORKS[chain.network].label}. Nothing was signed.`);
  }
  const parsed = tokens.parseMint(mintAccount.data, mintAccount.owner);
  if (!parsed) {
    throw new ApprovalError("bad_token", "That address is not a token mint (SPL Token or Token-2022). Nothing was signed.");
  }
  const amountRaw = tokens.parseTokenAmount(request.amount, parsed.decimals);
  if (amountRaw === null || amountRaw > 0xffffffffffffffffn) {
    throw new ApprovalError("bad_request", `That amount does not fit this token, which has ${parsed.decimals} decimal places`);
  }
  const tokenProgram = mintAccount.owner;
  const senderAta = tokens.associatedTokenAddress(wallet, mint, tokenProgram);
  const recipientAta = tokens.associatedTokenAddress(to, mint, tokenProgram);
  const [recipientAccount] = await chain.getAccounts([recipientAta]);
  return {
    token: {
      tokenProgram,
      decimals: parsed.decimals,
      amountRaw,
      senderAta,
      recipientAta,
      createRecipientAta: !recipientAccount,
    },
  };
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
 * @param context what resolveRequestContext() found out (needed for "token_transfer" only)
 * @returns {{ transaction: VersionedTransaction, refreshed: boolean, signerCount: number }}
 */
function prepareTransaction(payload, walletAddress, blockhash, context) {
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

  if (request.type === "token_transfer") {
    const t = context && context.token;
    if (!t) throw new ApprovalError("bad_request", "The token details were not looked up");
    const instructions = [];
    if (t.createRecipientAta) {
      instructions.push(
        tokens.createAtaIdempotentInstruction({ payer: wallet, ata: t.recipientAta, owner: request.to, mint: request.mint, tokenProgram: t.tokenProgram }),
      );
    }
    instructions.push(
      tokens.transferCheckedInstruction({
        source: t.senderAta,
        mint: request.mint,
        destination: t.recipientAta,
        authority: wallet,
        amount: t.amountRaw,
        decimals: t.decimals,
        tokenProgram: t.tokenProgram,
      }),
    );
    const message = new TransactionMessage({ payerKey: wallet, recentBlockhash: blockhash, instructions }).compileToLegacyMessage();
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
  const tokenInstructions = [];
  const tokenDangers = [];
  const systemProgram = SystemProgram.programId.toBase58();

  for (const ix of message.compiledInstructions) {
    const programKey = keys[ix.programIdIndex];
    const programId = programKey ? programKey.toBase58() : "unknown";
    if (!programs.some((p) => p.id === programId)) {
      programs.push({ id: programId, name: KNOWN_PROGRAMS[programId] || null });
    }
    const data = ix.data;
    const tokenKind = tokens.classifyTokenInstruction(programId, data);
    if (tokenKind) {
      tokenInstructions.push(tokenKind.kind);
      if (tokenKind.danger && !tokenDangers.includes(tokenKind.danger)) tokenDangers.push(tokenKind.danger);
    }
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
    /** The kind of each instruction that belongs to a token program: transfer, createAta, dangerous, other. */
    tokenInstructions,
    /** Plain-words descriptions of token instructions that hand over control (approve, set authority). */
    tokenDangers,
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
    /**
     * What happens to the wallet's token accounts, from the simulation (see tokens.js). Null when
     * this chain cannot look up accounts. Otherwise { complete, changes, others, created, error }.
     */
    tokens: null,
  };
  try {
    // Token accounts can sit anywhere in the transaction, so look at every account it touches:
    // their state now, and their state after the simulation.
    const watch = typeof chain.getAccounts === "function" ? await tokens.transactionAccountKeys(chain, transaction) : null;
    const [pre, sim, fee, accountsBefore] = await Promise.all([
      chain.getBalance(wallet),
      chain.simulate(transaction, wallet, watch ? watch.keys : []),
      chain.getFee(transaction.message).catch(() => null),
      watch ? chain.getAccounts(watch.keys).catch(() => null) : null,
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
    if (watch) {
      result.tokens =
        accountsBefore && Array.isArray(sim.accounts)
          ? await tokens.describeTokenChanges({
              chain,
              keys: watch.keys,
              pre: accountsBefore,
              post: sim.accounts,
              wallet: wallet.toBase58(),
              complete: watch.complete,
            })
          : { complete: false, changes: [], others: [], created: [], error: "Could not read the token accounts" };
    }
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

/**
 * One sentence for the approval screen, e.g. "You send 0.001005 SOL (network fee included)" or
 * "You send 250 SKR and 0.000005 SOL (network fee included)".
 */
function describePreview(preview, registry) {
  if (!preview || !preview.ok) {
    return `Could not simulate: ${preview && preview.error ? preview.error : "unknown error"}`;
  }
  const parts = { send: [], receive: [] };
  for (const change of (preview.tokens && preview.tokens.changes) || []) {
    const raw = BigInt(change.deltaRaw);
    const text = `${tokens.formatTokenAmount(raw < 0n ? -raw : raw, change.decimals)} ${tokens.tokenLabel(registry, change.mint)}`;
    (raw < 0n ? parts.send : parts.receive).push(text);
  }
  const delta = preview.deltaLamports;
  if (delta < 0) parts.send.push(formatSol(-delta));
  if (delta > 0) parts.receive.push(formatSol(delta));
  const sentences = [];
  if (parts.send.length) sentences.push(`You send ${parts.send.join(" and ")}${delta < 0 ? " (network fee included)" : ""}`);
  if (parts.receive.length) sentences.push(`${sentences.length ? "you receive" : "You receive"} ${parts.receive.join(" and ")}`);
  return sentences.length ? sentences.join(", ") : "No change to your SOL balance";
}

/**
 * Step 1, when a request arrives: build the transaction and work out what it
 * does, for display. Nothing is signed.
 */
async function reviewRequest({ payload, walletAddress, chain, registry }) {
  const request = validateRequest(payload);
  await assertNetwork(request, chain);
  const known = registry || tokens.tokenRegistry(chain.network);
  const context = await resolveRequestContext(request, walletAddress, chain);
  const latest = await chain.getLatestBlockhash();
  const prepared = prepareTransaction(request, walletAddress, latest.blockhash, context);
  const summary = summarizeTransaction(prepared.transaction);
  const preview = await previewTransaction(chain, prepared.transaction, walletAddress);
  return {
    request,
    network: chain.network,
    /** The tokens Nod calls by name on this network (see tokens.js). */
    registry: known,
    summary,
    preview,
    headline: describePreview(preview, known),
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
  const request = validateRequest(payload);
  await assertNetwork(request, chain);
  const context = await resolveRequestContext(request, walletAddress, chain);
  const latest = await chain.getLatestBlockhash();
  const prepared = prepareTransaction(request, walletAddress, latest.blockhash, context);
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
  assertNetwork,
  resolveRequestContext,
  prepareTransaction,
  summarizeTransaction,
  previewTransaction,
  describePreview,
  formatSol,
  reviewRequest,
  approveRequest,
};
