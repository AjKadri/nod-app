#!/usr/bin/env node
"use strict";
/**
 * Make a test token for Devnet and send some to a wallet.   npm run devnet:skr-test -- --to <WALLET>
 *
 * Devnet has no real SKR, so the app shows a test token as "SKR (test)". This creates that token
 * (6 decimals, you are the mint authority), mints some to a wallet, and prints the line to put in
 * mobile/.env so the app knows which mint is the test SKR.
 *
 *   --to ADDRESS      the wallet that gets the tokens (default: your own keypair's address)
 *   --amount N        how many whole tokens to mint (default 1000)
 *   --decimals N      default 6
 *   --keypair FILE    pays for it and becomes the mint authority (default ~/.config/solana/id.json)
 *   --url URL         Devnet RPC (default: the public one)
 *
 * It refuses to run against anything that is not Devnet (it checks the chain's genesis hash).
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} = require("@solana/web3.js");
const { NETWORKS } = require("../shared/network");
const tokens = require("../shared/tokens");

const MINT_SIZE = 82;

function parseArgs(argv) {
  const out = { amount: "1000", decimals: 6, url: NETWORKS.devnet.rpc, keypair: path.join(os.homedir(), ".config", "solana", "id.json") };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (["--to", "--amount", "--decimals", "--keypair", "--url"].includes(flag)) {
      if (value === undefined) throw new Error(`${flag} needs a value`);
      out[flag.slice(2)] = flag === "--decimals" ? Number(value) : value;
      i += 1;
    } else {
      throw new Error(`Unknown option ${flag}`);
    }
  }
  if (!Number.isInteger(out.decimals) || out.decimals < 0 || out.decimals > 9) throw new Error("--decimals must be a whole number from 0 to 9");
  if (out.to !== undefined) {
    try {
      new PublicKey(out.to);
    } catch (_err) {
      throw new Error("--to is not a Solana address");
    }
  }
  return out;
}

function mintToInstruction({ mint, destination, authority, amount }) {
  const data = Buffer.alloc(9);
  data[0] = 7;
  data.writeBigUInt64LE(BigInt(amount), 1);
  return new TransactionInstruction({
    programId: new PublicKey(tokens.TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: new PublicKey(mint), isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(authority), isSigner: true, isWritable: false },
    ],
    data,
  });
}

function initializeMintInstruction({ mint, decimals, authority }) {
  const data = Buffer.alloc(35);
  data[0] = 0;
  data[1] = decimals;
  new PublicKey(authority).toBuffer().copy(data, 2);
  data[34] = 0; // no freeze authority
  return new TransactionInstruction({
    programId: new PublicKey(tokens.TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: new PublicKey(mint), isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/** Create the mint and mint tokens to `to` in one transaction. Returns { mint, signature, to, raw }. */
async function createTestToken({ connection, payer, to, amount = "1000", decimals = 6 }) {
  const genesis = await connection.getGenesisHash();
  if (genesis !== NETWORKS.devnet.genesisHash) {
    throw new Error("That RPC is not Devnet, so nothing was created. This script only makes test tokens on Devnet.");
  }
  const raw = tokens.parseTokenAmount(String(amount), decimals);
  if (raw === null) throw new Error(`"${amount}" is not an amount that fits ${decimals} decimals`);
  const recipient = new PublicKey(to || payer.publicKey);
  const mint = Keypair.generate();
  const ata = tokens.associatedTokenAddress(recipient, mint.publicKey, tokens.TOKEN_PROGRAM_ID);
  const rent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  const { blockhash } = await connection.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mint.publicKey,
        lamports: rent,
        space: MINT_SIZE,
        programId: new PublicKey(tokens.TOKEN_PROGRAM_ID),
      }),
      initializeMintInstruction({ mint: mint.publicKey, decimals, authority: payer.publicKey }),
      tokens.createAtaIdempotentInstruction({
        payer: payer.publicKey,
        ata,
        owner: recipient,
        mint: mint.publicKey,
        tokenProgram: tokens.TOKEN_PROGRAM_ID,
      }),
      mintToInstruction({ mint: mint.publicKey, destination: ata, authority: payer.publicKey, amount: raw }),
    ],
  }).compileToLegacyMessage();
  const transaction = new VersionedTransaction(message);
  transaction.sign([payer, mint]);
  const signature = await connection.sendRawTransaction(transaction.serialize());
  return { mint: mint.publicKey.toBase58(), signature, to: recipient.toBase58(), raw: raw.toString() };
}

function loadKeypair(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (_err) {
    throw new Error(`Could not read the keypair file ${file}. Pass one with --keypair (a Solana CLI keypair JSON).`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(text)));
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const payer = loadKeypair(options.keypair);
  const connection = new Connection(options.url, "confirmed");
  const balance = await connection.getBalance(payer.publicKey);
  if (balance < 10_000_000) {
    throw new Error(`The paying wallet ${payer.publicKey.toBase58()} has ${balance / 1e9} SOL on Devnet. Get some at https://faucet.solana.com and run this again.`);
  }
  const made = await createTestToken({ connection, payer, to: options.to, amount: options.amount, decimals: options.decimals });
  console.log(`Created the test token on Devnet.`);
  console.log(`  mint:      ${made.mint}`);
  console.log(`  minted:    ${options.amount} to ${made.to}`);
  console.log(`  signature: ${made.signature}`);
  console.log("");
  console.log("Tell the app which mint is the test SKR: add this line to mobile/.env, then rebuild the app.");
  console.log(`  EXPO_PUBLIC_TEST_SKR_MINT=${made.mint}`);
  console.log("The app then shows it as “SKR (test)”. Real SKR only exists on Mainnet.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, createTestToken };
