"use strict";
/**
 * Tokens (SPL Token and Token-2022): what Nod knows about them, how it reads them, and how it builds
 * a plain token transfer.
 *
 * The rule that matters most: what a token payment does is READ FROM THE SIMULATION, as the
 * difference between the wallet's token accounts before and after. It is never read from the
 * instruction data and never from the agent's note. Decimals come from the mint account on chain.
 * The instruction data is looked at only to name what kind of instruction it is (and to catch the
 * dangerous kinds), never to say how much moves.
 */
const { Buffer } = require("buffer");
const { AddressLookupTableAccount, PublicKey, SystemProgram, TransactionInstruction } = require("@solana/web3.js");

const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const METAPLEX_METADATA_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

/** The official SKR mint, from solanamobile.com (https://solanamobile.com/blog/skr-is-live). */
const SKR_MINT = "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3";
const USDC_MINT = { mainnet: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", devnet: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" };

/** Most accounts one simulation is asked about. */
const MAX_WATCHED_ACCOUNTS = 100;

const isTokenProgram = (id) => id === TOKEN_PROGRAM_ID || id === TOKEN_2022_PROGRAM_ID;

// ------------------------------------------------------------------ who is who

/**
 * The tokens Nod calls by name on a network. Only these mints get a name; every other token is
 * shown by its shortened mint address, whatever it calls itself.
 *
 * SKR is recognised by its official mint and nothing else. On Devnet there is no real SKR, so
 * `testSkrMint` (a mint made for testing) stands in for it and is labelled "SKR (test)".
 *
 * @returns {{ network: string, tokens: Record<string, { symbol: string, label: string, logo: string | null, test?: boolean }> }}
 */
function tokenRegistry(network, { testSkrMint } = {}) {
  const tokens = {};
  if (network === "mainnet") {
    tokens[SKR_MINT] = { symbol: "SKR", label: "SKR", logo: "skr" };
    tokens[USDC_MINT.mainnet] = { symbol: "USDC", label: "USDC", logo: null };
  } else {
    tokens[USDC_MINT.devnet] = { symbol: "USDC", label: "USDC", logo: null };
    if (typeof testSkrMint === "string" && testSkrMint && testSkrMint !== SKR_MINT) {
      tokens[testSkrMint] = { symbol: "SKR", label: "SKR (test)", logo: "skr", test: true };
    }
  }
  return { network, tokens };
}

/** The mint that is the real thing for a symbol on this network (e.g. "SKR"), or null. */
function officialMintFor(registry, symbol) {
  const found = Object.entries((registry && registry.tokens) || {}).find(([, token]) => token.symbol === symbol);
  return found ? found[0] : null;
}

function shortMint(mint) {
  return typeof mint === "string" && mint.length > 10 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : String(mint);
}

/** "SKR" for the official mint, otherwise the shortened mint address. */
function tokenLabel(registry, mint) {
  const known = registry && registry.tokens && registry.tokens[mint];
  return known ? known.label : shortMint(mint);
}

/** Names that only the official mint may carry. */
function protectedSymbols(registry) {
  return [...new Set(Object.values((registry && registry.tokens) || {}).map((token) => token.symbol))];
}

// ------------------------------------------------------------------ amounts

/** A decimal string such as "250" or "0.5" -> whole units as a BigInt, or null if it does not fit the token. */
function parseTokenAmount(text, decimals) {
  if (typeof text !== "string" || !Number.isInteger(decimals) || decimals < 0 || decimals > 30) return null;
  const match = text.trim().match(/^(\d{1,24})(?:\.(\d{1,30}))?$/);
  if (!match) return null;
  const fraction = match[2] || "";
  if (fraction.length > decimals) return null;
  const raw = BigInt(match[1] + fraction.padEnd(decimals, "0"));
  return raw > 0n ? raw : null;
}

/** Raw whole units -> "250", "0.5", "1234.000001". Exact, never rounded. Negative numbers keep their sign. */
function formatTokenAmount(raw, decimals) {
  let value;
  try {
    value = BigInt(raw);
  } catch (_err) {
    return "?";
  }
  const sign = value < 0n ? "-" : "";
  if (value < 0n) value = -value;
  const digits = value.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals > 0 ? digits.slice(digits.length - decimals).replace(/0+$/, "") : "";
  return `${sign}${whole}${fraction ? "." + fraction : ""}`;
}

/** Lamports rounded to at most 5 decimals for a short line, never showing a payment as zero. */
function formatSolShort(lamports) {
  const sol = lamports / 1_000_000_000;
  if (sol > 0 && sol < 0.00001) return "<0.00001";
  return String(Number(sol.toFixed(5)));
}

// ------------------------------------------------------------------ reading accounts

function readU64LE(bytes, offset) {
  let value = 0n;
  for (let i = 7; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[offset + i]);
  return value;
}

/**
 * A token account's mint, owner and balance, or null if the bytes are not a token account of that
 * program. `programId` is the program that owns the account.
 */
function parseTokenAccount(data, programId) {
  if (!data || !isTokenProgram(programId)) return null;
  if (programId === TOKEN_PROGRAM_ID ? data.length !== 165 : data.length < 165) return null;
  if (programId === TOKEN_2022_PROGRAM_ID && data.length > 165 && data[165] !== 2) return null;
  const state = data[108];
  if (state !== 1 && state !== 2) return null;
  return {
    mint: new PublicKey(data.slice(0, 32)).toBase58(),
    owner: new PublicKey(data.slice(32, 64)).toBase58(),
    amount: readU64LE(data, 64),
  };
}

/** A mint's decimals (and supply), or null if the bytes are not a mint of that program. */
function parseMint(data, programId) {
  if (!data || !isTokenProgram(programId) || data.length < 82) return null;
  if (programId === TOKEN_PROGRAM_ID && data.length !== 82) return null;
  if (programId === TOKEN_2022_PROGRAM_ID && data.length > 82 && (data.length < 166 || data[165] !== 1)) return null;
  if (data[45] !== 1) return null;
  return { decimals: data[44], supply: readU64LE(data, 36) };
}

function readBorshString(data, offset) {
  if (offset + 4 > data.length) return null;
  const length = data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24);
  if (length < 0 || offset + 4 + length > data.length || length > 200) return null;
  const text = Buffer.from(data.slice(offset + 4, offset + 4 + length)).toString("utf8").replace(/\0+$/g, "");
  return { text, next: offset + 4 + length };
}

/** The address of a mint's Metaplex metadata account. */
function metaplexMetadataAddress(mint) {
  const program = new PublicKey(METAPLEX_METADATA_PROGRAM_ID);
  return PublicKey.findProgramAddressSync([Buffer.from("metadata"), program.toBuffer(), new PublicKey(mint).toBuffer()], program)[0];
}

/** The symbol a mint's Metaplex metadata gives itself (a claim, not a fact), or null. */
function readMetaplexSymbol(account, mint) {
  if (!account || account.owner !== METAPLEX_METADATA_PROGRAM_ID || !account.data || account.data.length < 70) return null;
  const data = account.data;
  if (data[0] !== 4) return null;
  if (new PublicKey(data.slice(33, 65)).toBase58() !== mint) return null;
  const name = readBorshString(data, 65);
  if (!name) return null;
  const symbol = readBorshString(data, name.next);
  return symbol && symbol.text ? symbol.text.trim() : null;
}

/** The symbol a Token-2022 mint's own metadata extension gives itself (a claim), or null. */
function readToken2022Symbol(account, mint) {
  if (!account || account.owner !== TOKEN_2022_PROGRAM_ID || !account.data || account.data.length < 170 || account.data[165] !== 1) return null;
  const data = account.data;
  let offset = 166;
  while (offset + 4 <= data.length) {
    const type = data[offset] | (data[offset + 1] << 8);
    const length = data[offset + 2] | (data[offset + 3] << 8);
    const start = offset + 4;
    if (start + length > data.length) return null;
    if (type === 19 && length >= 68) {
      // TokenMetadata: update authority (32), mint (32), name, symbol, uri.
      if (new PublicKey(data.slice(start + 32, start + 64)).toBase58() !== mint) return null;
      const name = readBorshString(data.slice(start, start + length), 64);
      if (!name) return null;
      const symbol = readBorshString(data.slice(start, start + length), name.next);
      return symbol && symbol.text ? symbol.text.trim() : null;
    }
    offset = start + length;
  }
  return null;
}

// ------------------------------------------------------------------ what a transaction does to token accounts

/**
 * Compare the wallet's token accounts before and after a simulation.
 * @param keys   the account addresses the transaction touches (PublicKey[])
 * @param pre    the account at each address before: { lamports, owner, data } or null
 * @param post   the account at each address after the simulation, same shape
 * @param wallet base58 address of this phone's wallet
 * @returns {{
 *   changes: { mint: string, preRaw: string, postRaw: string, deltaRaw: string }[],
 *   others: { account: string, owner: string, mint: string, deltaRaw: string }[],
 *   created: { address: string, owner: string, mint: string, rentLamports: number, own: boolean }[],
 * }}
 *   `changes`: the wallet's own balance per token. `others`: other people's token accounts whose
 *   balance changed (who receives). `created`: token accounts the transaction brings into being.
 */
function diffTokenAccounts({ keys, pre, post, wallet }) {
  const mine = new Map();
  const others = [];
  const created = [];
  for (let i = 0; i < keys.length; i += 1) {
    const before = pre[i] || null;
    const after = post[i] || null;
    const a0 = before ? parseTokenAccount(before.data, before.owner) : null;
    const a1 = after ? parseTokenAccount(after.data, after.owner) : null;
    if (!a0 && !a1) continue;
    const address = keys[i].toBase58();
    const mint = (a1 || a0).mint;
    const amount0 = a0 ? a0.amount : 0n;
    const amount1 = a1 ? a1.amount : 0n;

    // Count what is the wallet's before, and what is the wallet's after, separately: an account
    // handed to someone else counts as the wallet losing its balance.
    const entry = mine.get(mint) || { pre: 0n, post: 0n };
    if (a0 && a0.owner === wallet) entry.pre += amount0;
    if (a1 && a1.owner === wallet) entry.post += amount1;
    mine.set(mint, entry);

    const owner = (a1 || a0).owner;
    if (owner !== wallet && amount1 !== amount0) {
      others.push({ account: address, owner, mint, deltaRaw: (amount1 - amount0).toString() });
    }
    if (!before && after && a1) {
      created.push({ address, owner: a1.owner, mint, rentLamports: Number(after.lamports) || 0, own: a1.owner === wallet });
    }
  }
  const changes = [];
  for (const [mint, entry] of mine) {
    if (entry.pre === entry.post) continue;
    changes.push({ mint, preRaw: entry.pre.toString(), postRaw: entry.post.toString(), deltaRaw: (entry.post - entry.pre).toString() });
  }
  return { changes, others, created };
}

/**
 * All the account addresses a transaction touches, with address lookup tables resolved.
 * `complete` is false when some could not be known (a lookup table that cannot be read, or more
 * accounts than one simulation may report on).
 */
async function transactionAccountKeys(chain, transaction) {
  const message = transaction.message;
  let keys = message.staticAccountKeys.slice();
  let complete = true;
  const lookups = message.addressTableLookups || [];
  if (lookups.length > 0) {
    try {
      const tables = await chain.getAccounts(lookups.map((lookup) => lookup.accountKey));
      const resolved = lookups.map((lookup, index) => {
        const account = tables[index];
        if (!account) throw new Error("lookup table missing");
        return new AddressLookupTableAccount({ key: lookup.accountKey, state: AddressLookupTableAccount.deserialize(account.data) });
      });
      keys = message.getAccountKeys({ addressLookupTableAccounts: resolved }).keySegments().flat();
    } catch (_err) {
      complete = false;
    }
  }
  if (keys.length > MAX_WATCHED_ACCOUNTS) {
    keys = keys.slice(0, MAX_WATCHED_ACCOUNTS);
    complete = false;
  }
  return { keys, complete };
}

/**
 * Everything the review needs to know about tokens, from a simulation's before and after.
 * Adds each token's decimals (from its mint account) and the symbol its metadata gives itself.
 * Never throws: a problem is reported as `complete: false`.
 */
async function describeTokenChanges({ chain, keys, pre, post, wallet, complete }) {
  const result = { complete, changes: [], others: [], created: [], error: null };
  try {
    const diff = diffTokenAccounts({ keys, pre, post, wallet });
    result.created = diff.created;
    const mints = [...new Set([...diff.changes.map((c) => c.mint), ...diff.others.map((o) => o.mint)])];
    const mintInfo = new Map();
    if (mints.length > 0) {
      const metadata = mints.map((mint) => metaplexMetadataAddress(mint));
      const accounts = await chain.getAccounts([...mints.map((mint) => new PublicKey(mint)), ...metadata]);
      mints.forEach((mint, index) => {
        const account = accounts[index];
        const parsed = account ? parseMint(account.data, account.owner) : null;
        if (!parsed) {
          result.complete = false;
          return;
        }
        const claimed = readToken2022Symbol(account, mint) || readMetaplexSymbol(accounts[mints.length + index], mint);
        mintInfo.set(mint, { decimals: parsed.decimals, program: account.owner, claimedSymbol: claimed });
      });
    }
    const describe = (item) => {
      const info = mintInfo.get(item.mint);
      return info ? { ...item, decimals: info.decimals, program: info.program, claimedSymbol: info.claimedSymbol } : null;
    };
    result.changes = diff.changes.map(describe).filter(Boolean);
    result.others = diff.others.map(describe).filter(Boolean);
  } catch (err) {
    result.complete = false;
    result.error = err && err.message ? err.message : String(err);
  }
  return result;
}

// ------------------------------------------------------------------ naming instructions (never amounts)

/**
 * What kind of token instruction this is, from its program and first byte. Used to recognise a plain
 * transfer and to catch the dangerous kinds. It does NOT read any amount.
 * @returns { kind: "transfer" | "createAta" | "dangerous" | "other", danger?: string } | null
 */
function classifyTokenInstruction(programId, data) {
  if (isTokenProgram(programId)) {
    const tag = data.length > 0 ? data[0] : -1;
    if (tag === 3 && data.length === 9) return { kind: "transfer" };
    if (tag === 12 && data.length === 10) return { kind: "transfer" };
    if (tag === 4 || tag === 13) return { kind: "dangerous", danger: "This transaction lets another address spend your tokens." };
    if (tag === 6) return { kind: "dangerous", danger: "This transaction changes who controls a token account or a token." };
    return { kind: "other" };
  }
  if (programId === ASSOCIATED_TOKEN_PROGRAM_ID) {
    const tag = data.length === 0 ? 0 : data[0];
    if (data.length <= 1 && (tag === 0 || tag === 1)) return { kind: "createAta" };
    return { kind: "other" };
  }
  return null;
}

// ------------------------------------------------------------------ building a token transfer

function associatedTokenAddress(owner, mint, tokenProgram) {
  return PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), new PublicKey(tokenProgram).toBuffer(), new PublicKey(mint).toBuffer()],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
  )[0];
}

function createAtaIdempotentInstruction({ payer, ata, owner, mint, tokenProgram }) {
  return new TransactionInstruction({
    programId: new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: new PublicKey(payer), isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(owner), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(tokenProgram), isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

function transferCheckedInstruction({ source, mint, destination, authority, amount, decimals, tokenProgram }) {
  const data = Buffer.alloc(10);
  data[0] = 12;
  let rest = BigInt(amount);
  for (let i = 0; i < 8; i += 1) {
    data[1 + i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  data[9] = decimals;
  return new TransactionInstruction({
    programId: new PublicKey(tokenProgram),
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(authority), isSigner: true, isWritable: false },
    ],
    data,
  });
}

module.exports = {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  METAPLEX_METADATA_PROGRAM_ID,
  SKR_MINT,
  USDC_MINT,
  MAX_WATCHED_ACCOUNTS,
  isTokenProgram,
  tokenRegistry,
  officialMintFor,
  shortMint,
  tokenLabel,
  protectedSymbols,
  parseTokenAmount,
  formatTokenAmount,
  formatSolShort,
  parseTokenAccount,
  parseMint,
  metaplexMetadataAddress,
  readMetaplexSymbol,
  readToken2022Symbol,
  diffTokenAccounts,
  transactionAccountKeys,
  describeTokenChanges,
  classifyTokenInstruction,
  associatedTokenAddress,
  createAtaIdempotentInstruction,
  transferCheckedInstruction,
};
