"use strict";
/**
 * The two helper scripts for Task 8: making a test SKR on Devnet and reading the real SKR on
 * Mainnet. Both run here against the local Solana stand-in. Nothing touches a real network.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { Connection, Keypair, LAMPORTS_PER_SOL } = require("@solana/web3.js");

const { createLocalRpc } = require("../sim/local-rpc");
const { createTestToken, parseArgs: devnetArgs } = require("../scripts/devnet-skr-test");
const { checkMint, parseArgs: checkArgs } = require("../scripts/check-skr");
const { reviewRequest } = require("../shared/approval");
const { presentReview } = require("../shared/present");
const { rpcChain } = require("../shared/chain");
const { NETWORKS } = require("../shared/network");
const tokens = require("../shared/tokens");
const { createMint, tokenBalance } = require("./helpers/tokens");

let devnet;
let mainnet;
let devnetConnection;
let mainnetConnection;

before(async () => {
  devnet = createLocalRpc({ port: 0 });
  mainnet = createLocalRpc({ port: 0, genesisHash: NETWORKS.mainnet.genesisHash });
  devnetConnection = new Connection((await devnet.listen()).url, "confirmed");
  mainnetConnection = new Connection((await mainnet.listen()).url, "confirmed");
});

after(async () => {
  await devnet.close();
  await mainnet.close();
});

test("devnet:skr-test makes a mint and sends tokens to a wallet; the app can then review a payment of it", async () => {
  const payer = Keypair.generate();
  devnet.airdrop(payer.publicKey, LAMPORTS_PER_SOL);
  const phoneKeys = Keypair.generate();
  devnet.airdrop(phoneKeys.publicKey, LAMPORTS_PER_SOL);
  const phone = phoneKeys.publicKey.toBase58();
  const made = await createTestToken({ connection: devnetConnection, payer, to: phone, amount: "1000", decimals: 6 });
  assert.equal(tokenBalance(devnet, { owner: phone, mint: made.mint }), 1_000_000_000n);
  assert.equal(made.raw, "1000000000");
  const registry = tokens.tokenRegistry("devnet", { testSkrMint: made.mint });
  assert.equal(tokens.tokenLabel(registry, made.mint), "SKR (test)");
  // And the phone's review of a payment in it reads "250 SKR (test)", with nothing flagged.
  const to = Keypair.generate().publicKey.toBase58();
  const review = await reviewRequest({
    payload: { type: "token_transfer", mint: made.mint, to, amount: "250", note: "", agent: "bot", network: "devnet" },
    walletAddress: phone,
    chain: rpcChain(devnetConnection, "devnet"),
    registry,
  });
  const presented = presentReview(review);
  assert.deepEqual([presented.amount, presented.unit, presented.token.logo], ["250", "SKR (test)", "skr"]);
  assert.deepEqual(presented.warnings, []);
});

test("devnet:skr-test refuses an RPC that is not Devnet, and bad amounts", async () => {
  const payer = Keypair.generate();
  mainnet.airdrop(payer.publicKey, LAMPORTS_PER_SOL);
  await assert.rejects(createTestToken({ connection: mainnetConnection, payer }), /not Devnet/);
  devnet.airdrop(payer.publicKey, LAMPORTS_PER_SOL);
  await assert.rejects(createTestToken({ connection: devnetConnection, payer, amount: "1.0000001", decimals: 6 }), /not an amount/);
  assert.throws(() => devnetArgs(["--to", "nope"]), /not a Solana address/);
  assert.throws(() => devnetArgs(["--decimals", "12"]), /0 to 9/);
  assert.throws(() => devnetArgs(["--bogus", "1"]), /Unknown option/);
});

test("check:skr reads the mint on Mainnet and says what Nod will show", async () => {
  createMint(mainnet, { decimals: 6, mint: tokens.SKR_MINT });
  const found = await checkMint({ connection: mainnetConnection, mint: tokens.SKR_MINT });
  assert.equal(found.decimals, 6);
  assert.equal(found.label, "SKR");
  assert.equal(found.named, true);
  assert.equal(found.programName, "SPL Token");
  assert.equal(found.example, "250 SKR = 250000000 on-chain units");
});

test("check:skr does not name another mint SKR, refuses a non-Mainnet RPC, and reports a missing mint", async () => {
  const other = createMint(mainnet, { decimals: 9, symbol: "SKR" });
  const found = await checkMint({ connection: mainnetConnection, mint: other });
  assert.equal(found.named, false);
  assert.equal(found.label, tokens.shortMint(other));
  await assert.rejects(checkMint({ connection: devnetConnection, mint: tokens.SKR_MINT }), /not Mainnet/);
  await assert.rejects(checkMint({ connection: mainnetConnection, mint: Keypair.generate().publicKey.toBase58() }), /no account/);
  assert.throws(() => checkArgs(["--mint", "x"]), /not a Solana address/);
});
