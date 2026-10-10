"use strict";
/**
 * Test helpers: put token mints and token accounts straight into the local Solana stand-in
 * (LiteSVM), exactly as the real SPL Token / Token-2022 programs lay them out, so tests do not
 * need a long chain of setup transactions.
 */
const { Keypair, PublicKey } = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  METAPLEX_METADATA_PROGRAM_ID,
  associatedTokenAddress,
  metaplexMetadataAddress,
} = require("../../shared/tokens");

function writeU64(buffer, offset, value) {
  let rest = BigInt(value);
  for (let i = 0; i < 8; i += 1) {
    buffer[offset + i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
}

function borshString(text, padTo = 0) {
  const body = Buffer.from(text, "utf8");
  const padded = padTo > body.length ? Buffer.concat([body, Buffer.alloc(padTo - body.length)]) : body;
  const length = Buffer.alloc(4);
  length.writeUInt32LE(padded.length);
  return Buffer.concat([length, padded]);
}

/** Token-2022 TokenMetadata extension (TLV type 19) holding a name and symbol. */
function token2022MetadataExtension(mint, name, symbol) {
  const value = Buffer.concat([Buffer.alloc(32), new PublicKey(mint).toBuffer(), borshString(name), borshString(symbol), borshString("")]);
  const header = Buffer.alloc(4);
  header.writeUInt16LE(19, 0);
  header.writeUInt16LE(value.length, 2);
  return Buffer.concat([header, value]);
}

/**
 * Create a mint. `symbol` (optional) is what its metadata calls it: a Metaplex metadata account for
 * the SPL Token program, or the built-in metadata extension for Token-2022.
 * @returns {string} the mint address
 */
function createMint(rpc, { decimals = 6, program = TOKEN_PROGRAM_ID, symbol, name = "Test token", mint } = {}) {
  const address = mint || Keypair.generate().publicKey.toBase58();
  let data = Buffer.alloc(82);
  data.writeUInt32LE(1, 0); // has a mint authority
  Keypair.generate().publicKey.toBuffer().copy(data, 4);
  writeU64(data, 36, 1_000_000_000_000n);
  data[44] = decimals;
  data[45] = 1;
  if (program === TOKEN_2022_PROGRAM_ID && symbol) {
    const extension = token2022MetadataExtension(address, name, symbol);
    data = Buffer.concat([data, Buffer.alloc(165 - 82), Buffer.from([1]), extension]);
  }
  const { PublicKey: PK } = require("@solana/web3.js");
  rpc.svm.setAccount(new PK(address), {
    lamports: 5_000_000n,
    data: new Uint8Array(data),
    owner: new PK(program),
    executable: false,
  });
  if (program === TOKEN_PROGRAM_ID && symbol) {
    const metadata = Buffer.concat([
      Buffer.from([4]),
      Keypair.generate().publicKey.toBuffer(),
      new PublicKey(address).toBuffer(),
      borshString(name, 32),
      borshString(symbol, 10),
      borshString("", 200),
    ]);
    rpc.svm.setAccount(metaplexMetadataAddress(address), {
      lamports: 5_000_000n,
      data: new Uint8Array(metadata),
      owner: new PublicKey(METAPLEX_METADATA_PROGRAM_ID),
      executable: false,
    });
  }
  return address;
}

/** Give `owner` a token account for `mint` holding `amount` whole units (raw), at the standard address. */
function giveTokens(rpc, { owner, mint, amount, program = TOKEN_PROGRAM_ID }) {
  const address = associatedTokenAddress(owner, mint, program);
  const data = Buffer.alloc(165);
  new PublicKey(mint).toBuffer().copy(data, 0);
  new PublicKey(owner).toBuffer().copy(data, 32);
  writeU64(data, 64, amount);
  data[108] = 1;
  rpc.svm.setAccount(address, {
    lamports: 2_039_280n,
    data: new Uint8Array(data),
    owner: new PublicKey(program),
    executable: false,
  });
  return address;
}

/** The raw token balance of `owner` for `mint`, read straight from the stand-in. */
function tokenBalance(rpc, { owner, mint, program = TOKEN_PROGRAM_ID }) {
  const account = rpc.svm.getAccount(associatedTokenAddress(owner, mint, program));
  if (!account) return null;
  const data = Buffer.from(account.data);
  return data.readBigUInt64LE(64);
}

module.exports = { createMint, giveTokens, tokenBalance };
