#!/usr/bin/env node
"use strict";
/**
 * Read the real SKR token on Mainnet and show what Nod will display. Sends nothing.
 *   npm run check:skr
 *
 *   --url URL     a Mainnet RPC (default: the public one)
 *   --mint ADDR   a different mint to read (default: the official SKR mint)
 *
 * Checks: the mint exists on Mainnet, which token program owns it, its decimals (the number Nod
 * uses to turn "250 SKR" into on-chain units), whether it has extensions, and that Nod names it
 * "SKR". The RPC is checked to be Mainnet by its genesis hash.
 */
const { Connection, PublicKey } = require("@solana/web3.js");
const { NETWORKS } = require("../shared/network");
const tokens = require("../shared/tokens");

function parseArgs(argv) {
  const out = { url: NETWORKS.mainnet.rpc, mint: tokens.SKR_MINT };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!["--url", "--mint"].includes(flag) || argv[i + 1] === undefined) throw new Error(`Unknown or incomplete option ${flag}`);
    out[flag.slice(2)] = argv[i + 1];
  }
  try {
    new PublicKey(out.mint);
  } catch (_err) {
    throw new Error("--mint is not a Solana address");
  }
  return out;
}

/** @returns {Promise<object>} what was found; throws when the RPC is not Mainnet or the mint is not a token. */
async function checkMint({ connection, mint, genesisHash = NETWORKS.mainnet.genesisHash }) {
  const genesis = await connection.getGenesisHash();
  if (genesis !== genesisHash) throw new Error("That RPC is not Mainnet, so the real SKR cannot be read from it.");
  const info = await connection.getAccountInfo(new PublicKey(mint));
  if (!info) throw new Error(`There is no account at ${mint} on Mainnet.`);
  const program = info.owner.toBase58();
  const parsed = tokens.parseMint(new Uint8Array(info.data), program);
  if (!parsed) throw new Error(`The account at ${mint} is not a token mint (owner ${program}).`);
  const registry = tokens.tokenRegistry("mainnet");
  const label = tokens.tokenLabel(registry, mint);
  const raw = tokens.parseTokenAmount("250", parsed.decimals);
  return {
    mint,
    program,
    programName: program === tokens.TOKEN_2022_PROGRAM_ID ? "Token-2022" : "SPL Token",
    decimals: parsed.decimals,
    supply: tokens.formatTokenAmount(parsed.supply, parsed.decimals),
    extensions: info.data.length > 82,
    label,
    named: label === "SKR",
    example: raw === null ? null : `250 ${label} = ${raw} on-chain units`,
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const found = await checkMint({ connection: new Connection(options.url, "confirmed"), mint: options.mint });
  console.log(`Mint        ${found.mint}`);
  console.log(`Program     ${found.programName} (${found.program})`);
  console.log(`Decimals    ${found.decimals}`);
  console.log(`Supply      ${found.supply}`);
  console.log(`Extensions  ${found.extensions ? "yes (Token-2022 extensions present)" : "none"}`);
  console.log(`Nod shows   ${found.label}${found.named ? " (the official SKR, with its logo)" : " (NOT named by Nod: this is not the official SKR mint)"}`);
  if (found.example) console.log(`Example     ${found.example}`);
  console.log("Nothing was sent.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, checkMint };
