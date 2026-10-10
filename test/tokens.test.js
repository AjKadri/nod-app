"use strict";
/**
 * Task 8B: token payments. Real pieces: the relay, the agent client, the phone's approval logic and
 * the Solana runtime (LiteSVM) with the real SPL Token, Token-2022 and Associated Token programs.
 * Mints and balances are put straight into the stand-in by test/helpers/tokens.js.
 */
const { test, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} = require("@solana/web3.js");

const { createRelay } = require("../relay/server");
const { pairForTesting } = require("../agent/pairing");
const { createLocalRpc } = require("../sim/local-rpc");
const { createSimPhone } = require("../sim/phone");
const { requestApproval } = require("../agent/client");
const { reviewRequest, approveRequest, validateRequest } = require("../shared/approval");
const { presentReview } = require("../shared/present");
const { rpcChain } = require("../shared/chain");
const tokens = require("../shared/tokens");
const { createMint, giveTokens, tokenBalance, tokenAccountBytes } = require("./helpers/tokens");

const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = tokens;

let rpc;
let rpcUrl;
let relay;
let relayUrl;
let agentToken;
let phoneToken;
let connection;
let chain;
const phones = new Set();

before(async () => {
  rpc = createLocalRpc({ port: 0 });
  rpcUrl = (await rpc.listen()).url;
  relay = createRelay({ port: 0 });
  relayUrl = (await relay.listen()).url;
  ({ agentToken, phoneToken } = await pairForTesting({ relay: relayUrl }));
  connection = new Connection(rpcUrl, "confirmed");
  chain = rpcChain(connection, "devnet");
});

afterEach(() => {
  for (const phone of phones) phone.close();
  phones.clear();
});

after(async () => {
  await relay.close();
  await rpc.close();
});

const newAddress = () => Keypair.generate().publicKey.toBase58();

/** A funded wallet that already holds `amount` raw units of `mint`. */
function wallet({ mint, amount = 1_000_000_000n, program = TOKEN_PROGRAM_ID } = {}) {
  const keypair = Keypair.generate();
  rpc.airdrop(keypair.publicKey, LAMPORTS_PER_SOL);
  if (mint) giveTokens(rpc, { owner: keypair.publicKey.toBase58(), mint, amount, program });
  return { keypair, address: keypair.publicKey.toBase58() };
}

const tokenPayload = (mint, to, amount, extra = {}) => ({ type: "token_transfer", mint, to, amount, note: "", agent: "bot", network: "devnet", ...extra });

async function review(payload, address, registry) {
  return reviewRequest({ payload, walletAddress: address, chain, registry });
}

async function rawTokenTx(address, instructions) {
  const { blockhash } = await connection.getLatestBlockhash();
  const message = new TransactionMessage({ payerKey: new PublicKey(address), recentBlockhash: blockhash, instructions }).compileToLegacyMessage();
  return { type: "raw", transactionBase64: Buffer.from(new VersionedTransaction(message).serialize()).toString("base64"), note: "", agent: "bot", network: "devnet" };
}

async function waitOnline() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await (await fetch(`${relayUrl}/health`)).json()).phones > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("phone never came online");
}

function startPhone(keypair, decide = async () => "approve") {
  const phone = createSimPhone({ relayUrl, rpcUrl, keypair, token: phoneToken, decide });
  phones.add(phone);
  return phone;
}

// ---------------------------------------------------------------- amounts

test("token amounts: exact decimal arithmetic in both directions", () => {
  assert.equal(tokens.parseTokenAmount("250", 6), 250_000_000n);
  assert.equal(tokens.parseTokenAmount("0.5", 6), 500_000n);
  assert.equal(tokens.parseTokenAmount("0.000001", 6), 1n);
  assert.equal(tokens.parseTokenAmount("1.25", 2), 125n);
  assert.equal(tokens.parseTokenAmount("7", 0), 7n);
  assert.equal(tokens.parseTokenAmount("0.0000001", 6), null, "more places than the token has");
  assert.equal(tokens.parseTokenAmount("1.5", 0), null);
  assert.equal(tokens.parseTokenAmount("0", 6), null);
  assert.equal(tokens.parseTokenAmount("-5", 6), null);
  assert.equal(tokens.parseTokenAmount("1e3", 6), null);
  assert.equal(tokens.parseTokenAmount("", 6), null);
  assert.equal(tokens.parseTokenAmount("12345678901234567890", 9), 12345678901234567890_000000000n, "bigger than a JS number can hold");
  assert.equal(tokens.formatTokenAmount(250_000_000n, 6), "250");
  assert.equal(tokens.formatTokenAmount("500000", 6), "0.5");
  assert.equal(tokens.formatTokenAmount(1n, 6), "0.000001");
  assert.equal(tokens.formatTokenAmount(-1_234_560n, 6), "-1.23456");
  assert.equal(tokens.formatTokenAmount(12345678901234567890_000000000n, 9), "12345678901234567890");
  assert.equal(tokens.formatTokenAmount(7n, 0), "7");
  assert.equal(tokens.formatSolShort(2_039_280), "0.00204");
});

test("request validation: a token transfer needs a real mint, a real address and a plain positive amount", () => {
  const ok = validateRequest(tokenPayload(newAddress(), newAddress(), "250"));
  assert.equal(ok.type, "token_transfer");
  assert.equal(ok.amount, "250");
  assert.equal(validateRequest(tokenPayload(newAddress(), newAddress(), 0.5)).amount, "0.5", "a JSON number is accepted and written out");
  for (const amount of ["0", "0.0", "-1", "1e3", "abc", "", " ", "1,5", null, undefined, {}]) {
    assert.throws(() => validateRequest(tokenPayload(newAddress(), newAddress(), amount)), /amount must be a positive number/, String(amount));
  }
  assert.throws(() => validateRequest(tokenPayload("not-a-mint", newAddress(), "1")), /mint is not a valid/);
  assert.throws(() => validateRequest(tokenPayload(newAddress(), "nope", "1")), /to is not a valid/);
});

// ---------------------------------------------------------------- the review reads the simulation

test("a token transfer: the card shows what the simulation says, decimals come from the mint", async () => {
  for (const decimals of [0, 2, 6, 9]) {
    const mint = createMint(rpc, { decimals });
    const w = wallet({ mint, amount: 1_000_000_000_000n });
    const to = newAddress();
    giveTokens(rpc, { owner: to, mint, amount: 1n }); // the recipient already has an account
    const amount = decimals === 0 ? "250" : "250.5".slice(0, decimals >= 1 ? 5 : 3);
    const real = await review(tokenPayload(mint, to, amount), w.address);
    const presented = presentReview(real);
    assert.equal(presented.amount, amount, `decimals ${decimals}`);
    assert.equal(presented.unit, tokens.shortMint(mint));
    assert.equal(presented.direction, "send");
    assert.equal(presented.action, "Token transfer");
    assert.deepEqual(presented.recipient, { kind: "address", value: to });
    assert.deepEqual(presented.notes, [], "no new token account, no rent line");
    assert.equal(presented.fee, "Est. 0.000005 SOL");
    assert.deepEqual(presented.warnings, []);
    assert.equal(real.preview.deltaLamports, -5000, "only the fee leaves in SOL");
  }
});

test("a transfer to someone with no token account shows the rent for creating it", async () => {
  const mint = createMint(rpc, { decimals: 6 });
  const w = wallet({ mint });
  const to = newAddress();
  const real = await review(tokenPayload(mint, to, "250"), w.address);
  const presented = presentReview(real);
  assert.deepEqual(presented.notes, ["Creates the recipient’s token account: +0.00204 SOL rent"]);
  assert.equal(real.preview.deltaLamports, -(5000 + 2_039_280));
  assert.equal(presented.amount, "250");
  assert.deepEqual(presented.also, [], "rent and fee are explained, nothing else leaves");
  assert.deepEqual(presented.warnings, []);
});

test("end to end: the agent asks for 250 tokens, the phone approves, balances move exactly that much", async () => {
  const mint = createMint(rpc, { decimals: 6 });
  const w = wallet({ mint });
  startPhone(w.keypair);
  await waitOnline();
  const to = newAddress();
  const outcome = await requestApproval({ relay: relayUrl, token: agentToken, payload: { type: "token_transfer", mint, to, amount: "250", note: "pay the vendor" } });
  assert.equal(outcome.status, "approved", JSON.stringify(outcome.result));
  assert.equal(tokenBalance(rpc, { owner: w.address, mint }), 750_000_000n);
  assert.equal(tokenBalance(rpc, { owner: to, mint }), 250_000_000n);
  assert.equal(rpc.balance(w.address), LAMPORTS_PER_SOL - 5000 - 2_039_280, "fee plus the recipient's account rent");
});

test("a second transfer to the same person has no rent line and no account creation", async () => {
  const mint = createMint(rpc, { decimals: 6 });
  const w = wallet({ mint });
  startPhone(w.keypair);
  await waitOnline();
  const to = newAddress();
  for (let i = 0; i < 2; i += 1) {
    const outcome = await requestApproval({ relay: relayUrl, token: agentToken, payload: { type: "token_transfer", mint, to, amount: "10" } });
    assert.equal(outcome.status, "approved");
  }
  assert.equal(tokenBalance(rpc, { owner: to, mint }), 20_000_000n);
  assert.equal(rpc.balance(w.address), LAMPORTS_PER_SOL - 2 * 5000 - 2_039_280, "rent was paid once");
});

test("Token-2022 mints work the same way", async () => {
  const mint = createMint(rpc, { decimals: 9, program: TOKEN_2022_PROGRAM_ID });
  const w = wallet({ mint, amount: 5_000_000_000n, program: TOKEN_2022_PROGRAM_ID });
  const to = newAddress();
  const real = await review(tokenPayload(mint, to, "1.5"), w.address);
  const presented = presentReview(real);
  assert.equal(presented.amount, "1.5");
  assert.equal(presented.action, "Token transfer");
  assert.equal(real.preview.tokens.changes[0].program, TOKEN_2022_PROGRAM_ID);
  assert.equal(presented.notes.length, 1);
  startPhone(w.keypair);
  await waitOnline();
  const outcome = await requestApproval({ relay: relayUrl, token: agentToken, payload: { type: "token_transfer", mint, to, amount: "1.5" } });
  assert.equal(outcome.status, "approved", JSON.stringify(outcome.result));
  assert.equal(tokenBalance(rpc, { owner: to, mint, program: TOKEN_2022_PROGRAM_ID }), 1_500_000_000n);
});

test("a token that does not exist, or an address that is not a mint, is refused with a reason", async () => {
  const w = wallet();
  await assert.rejects(review(tokenPayload(newAddress(), newAddress(), "1"), w.address), (e) => e.code === "bad_token" && /does not exist on Devnet/.test(e.message));
  await assert.rejects(review(tokenPayload(w.address, newAddress(), "1"), w.address), (e) => e.code === "bad_token" || /itself|not a token mint|does not exist/.test(e.message));
  const mint = createMint(rpc, { decimals: 2 });
  await assert.rejects(review(tokenPayload(mint, newAddress(), "1.234"), w.address), (e) => /does not fit this token, which has 2 decimal places/.test(e.message));
  await assert.rejects(review(tokenPayload(mint, w.address, "1"), w.address), /itself/);
});

test("a wallet without enough tokens fails the preview, so the card says so", async () => {
  const mint = createMint(rpc, { decimals: 6 });
  const w = wallet({ mint, amount: 1_000_000n });
  const presented = presentReview(await review(tokenPayload(mint, newAddress(), "250"), w.address));
  assert.equal(presented.previewOk, false);
  assert.equal(presented.risky, true);
  assert.ok(presented.warnings.some((x) => /would fail/.test(x.text)));
});

// ---------------------------------------------------------------- raw transactions: transfer and transferChecked

test("raw transactions: Transfer and TransferChecked are both read from the simulation", async () => {
  const mint = createMint(rpc, { decimals: 6 });
  const w = wallet({ mint });
  const to = newAddress();
  const toAta = giveTokens(rpc, { owner: to, mint, amount: 0n });
  const fromAta = tokens.associatedTokenAddress(w.address, mint, TOKEN_PROGRAM_ID);

  const checked = tokens.transferCheckedInstruction({ source: fromAta, mint, destination: toAta, authority: w.address, amount: 40_000_000n, decimals: 6, tokenProgram: TOKEN_PROGRAM_ID });
  const plainData = Buffer.alloc(9);
  plainData[0] = 3;
  plainData.writeBigUInt64LE(60_000_000n, 1);
  const plain = new TransactionInstruction({
    programId: new PublicKey(TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: fromAta, isSigner: false, isWritable: true },
      { pubkey: toAta, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(w.address), isSigner: true, isWritable: false },
    ],
    data: plainData,
  });

  const one = await review(await rawTokenTx(w.address, [checked]), w.address);
  assert.deepEqual(one.summary.tokenInstructions, ["transfer"]);
  assert.equal(presentReview(one).amount, "40");
  assert.equal(presentReview(one).action, "Token transfer");

  const two = await review(await rawTokenTx(w.address, [plain]), w.address);
  assert.deepEqual(two.summary.tokenInstructions, ["transfer"]);
  assert.equal(presentReview(two).amount, "60");

  const both = await review(await rawTokenTx(w.address, [checked, plain]), w.address);
  assert.equal(presentReview(both).amount, "100", "the sum the simulation shows, not either instruction alone");
  assert.deepEqual(presentReview(both).warnings, []);
});

test("raw transaction that creates the recipient's account: the rent is shown", async () => {
  const mint = createMint(rpc, { decimals: 6 });
  const w = wallet({ mint });
  const to = newAddress();
  const toAta = tokens.associatedTokenAddress(to, mint, TOKEN_PROGRAM_ID);
  const fromAta = tokens.associatedTokenAddress(w.address, mint, TOKEN_PROGRAM_ID);
  const create = tokens.createAtaIdempotentInstruction({ payer: w.address, ata: toAta, owner: to, mint, tokenProgram: TOKEN_PROGRAM_ID });
  const send = tokens.transferCheckedInstruction({ source: fromAta, mint, destination: toAta, authority: w.address, amount: 5_000_000n, decimals: 6, tokenProgram: TOKEN_PROGRAM_ID });
  const real = await review(await rawTokenTx(w.address, [create, send]), w.address);
  const presented = presentReview(real);
  assert.deepEqual(real.summary.tokenInstructions, ["createAta", "transfer"]);
  assert.equal(presented.amount, "5");
  assert.deepEqual(presented.notes, ["Creates the recipient’s token account: +0.00204 SOL rent"]);
  assert.deepEqual(presented.warnings, []);
});

test("anything else keeps the existing handling: a token transfer plus an unknown program is a program call with a warning", async () => {
  const mint = createMint(rpc, { decimals: 6 });
  const w = wallet({ mint });
  const to = newAddress();
  const toAta = giveTokens(rpc, { owner: to, mint, amount: 0n });
  const fromAta = tokens.associatedTokenAddress(w.address, mint, TOKEN_PROGRAM_ID);
  const send = tokens.transferCheckedInstruction({ source: fromAta, mint, destination: toAta, authority: w.address, amount: 1_000_000n, decimals: 6, tokenProgram: TOKEN_PROGRAM_ID });
  const mystery = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.from([1]) });
  const presented = presentReview(await review(await rawTokenTx(w.address, [send, mystery]), w.address));
  assert.notEqual(presented.action, "Token transfer");
  assert.ok(presented.warnings.some((x) => /program this app does not recognise/.test(x.text)));
});

test("a token approval (delegation) is a red warning even though no balance moves", async () => {
  const mint = createMint(rpc, { decimals: 6 });
  const w = wallet({ mint });
  const fromAta = tokens.associatedTokenAddress(w.address, mint, TOKEN_PROGRAM_ID);
  const data = Buffer.alloc(9);
  data[0] = 4;
  data.writeBigUInt64LE(18446744073709551615n, 1);
  const approve = new TransactionInstruction({
    programId: new PublicKey(TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: fromAta, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(newAddress()), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(w.address), isSigner: true, isWritable: false },
    ],
    data,
  });
  const presented = presentReview(await review(await rawTokenTx(w.address, [approve]), w.address));
  assert.equal(presented.risky, true);
  assert.ok(presented.warnings.some((x) => x.level === "danger" && /lets another address spend your tokens/.test(x.text)));
  assert.notEqual(presented.action, "Token transfer");
  // The instruction names it and the simulation shows it: the card says it once.
  assert.equal(presented.warnings.filter((x) => /lets another address spend your tokens/.test(x.text)).length, 1);
  assert.deepEqual(presented.tokenAlerts, [tokens.DANGER_SPEND]);
});

test("handing a token account to someone else shows as the full balance leaving", async () => {
  const mint = createMint(rpc, { decimals: 6 });
  const w = wallet({ mint, amount: 900_000_000n });
  const fromAta = tokens.associatedTokenAddress(w.address, mint, TOKEN_PROGRAM_ID);
  const data = Buffer.alloc(35);
  data[0] = 6; // SetAuthority
  data[1] = 2; // AccountOwner
  data[2] = 1; // new authority present
  new PublicKey(newAddress()).toBuffer().copy(data, 3);
  const steal = new TransactionInstruction({
    programId: new PublicKey(TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: fromAta, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(w.address), isSigner: true, isWritable: false },
    ],
    data,
  });
  const presented = presentReview(await review(await rawTokenTx(w.address, [steal]), w.address));
  assert.equal(presented.amount, "900", "the whole balance is shown as leaving");
  assert.equal(presented.direction, "send");
  assert.equal(presented.risky, true);
  assert.ok(presented.warnings.some((x) => /changes who controls/.test(x.text)));
});

// ---------------------------------------------------------------- mismatch, impostors

test("the agent's note about a token amount is checked against the simulation", async () => {
  const mint = createMint(rpc, { decimals: 6 });
  const w = wallet({ mint });
  const registry = tokens.tokenRegistry("devnet", { testSkrMint: mint });
  const to = newAddress();
  giveTokens(rpc, { owner: to, mint, amount: 1n });

  const lie = presentReview(await review(tokenPayload(mint, to, "250", { note: "Sending 25 SKR for the report" }), w.address, registry));
  assert.equal(lie.unit, "SKR (test)");
  assert.deepEqual(lie.mismatch, { said: "25 SKR", actual: "250 SKR", message: "The agent said 25 SKR. This sends 250 SKR." });
  assert.equal(lie.risky, true);
  assert.ok(lie.warnings.some((x) => x.text === "The agent said 25 SKR. This sends 250 SKR."));

  const honest = presentReview(await review(tokenPayload(mint, to, "250", { note: "Paying 250 SKR for the report" }), w.address, registry));
  assert.equal(honest.mismatch, null);
  assert.deepEqual(honest.warnings, []);

  const decimal = presentReview(await review(tokenPayload(mint, to, "0.5", { note: "send 0,5 SKR" }), w.address, registry));
  assert.equal(decimal.mismatch, null, "0,5 and 0.5 are the same amount");

  const noClaim = presentReview(await review(tokenPayload(mint, to, "250", { note: "monthly payment" }), w.address, registry));
  assert.equal(noClaim.mismatch, null);
});

test("a note that says 0.001 SOL while a token leaves still triggers the SOL check", async () => {
  const mint = createMint(rpc, { decimals: 6 });
  const w = wallet({ mint });
  const to = newAddress();
  giveTokens(rpc, { owner: to, mint, amount: 1n });
  const presented = presentReview(await review(tokenPayload(mint, to, "250", { note: "tiny 0.001 SOL test payment" }), w.address));
  assert.ok(presented.mismatch, "the claim does not match what leaves in SOL");
  assert.equal(presented.amount, "250");
});

test("a lookup table that cannot be read means Nod says it cannot see every account", async () => {
  const stub = {
    network: "devnet",
    verifyNetwork: async () => true,
    getAccounts: async () => [null],
    getBalance: async () => 1_000_000_000,
    getFee: async () => 5000,
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), slot: 1 }),
    simulate: async () => ({ err: null, postLamports: 1_000_000_000, logs: [], accounts: [] }),
  };
  const payer = Keypair.generate().publicKey;
  const looked = Keypair.generate().publicKey;
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: looked, lamports: 1 })],
  }).compileToV0Message([
    { key: Keypair.generate().publicKey, state: { deactivationSlot: 0xffffffffffffffffn, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [looked] } },
  ]);
  assert.equal(message.addressTableLookups.length, 1, "the destination really is loaded from a table");
  const { previewTransaction } = require("../shared/approval");
  const result = await previewTransaction(stub, new VersionedTransaction(message), payer);
  assert.equal(result.ok, true);
  assert.equal(result.tokens.complete, false);
  const { presentReview: present } = require("../shared/present");
  const shown = present({ request: { type: "raw", note: "" }, network: "devnet", summary: { programs: [], transfers: [], tokenInstructions: [], tokenDangers: [], unknownPrograms: [], instructionCount: 1, signerCount: 1, usesLookupTables: true }, preview: result, refreshable: true, signerCount: 1 });
  assert.ok(shown.warnings.some((w) => w.level === "danger" && /could not check every account/.test(w.text)));
});

// ---------------------------------------------------------------- who else has a say over the wallet's token accounts

const SPEND = tokens.DANGER_SPEND;
const CONTROL = tokens.DANGER_CONTROL;

/** The warnings diffTokenAccounts raises when the wallet's account goes from `before` to `after`. */
function controlDangers(before, after, { wallet = newAddress(), mint = newAddress(), beforeOwner } = {}) {
  const key = Keypair.generate().publicKey;
  const account = (fields, owner) => ({ lamports: 2_039_280, owner: TOKEN_PROGRAM_ID, data: tokenAccountBytes({ mint, owner, ...fields }) });
  const pre = before === null ? null : account(before, beforeOwner || wallet);
  const post = after === null ? null : account(after, after.owner || wallet);
  return tokens.diffTokenAccounts({ keys: [key], pre: [pre], post: [post], wallet }).dangers;
}

test("token accounts: a delegate that is new or different, or a bigger allowance, is 'lets another address spend your tokens'", () => {
  const stranger = newAddress();
  assert.deepEqual(controlDangers({ amount: 5n }, { amount: 5n, delegate: stranger, delegatedAmount: 5n }), [SPEND]);
  assert.deepEqual(controlDangers({ amount: 5n, delegate: newAddress(), delegatedAmount: 5n }, { amount: 5n, delegate: stranger, delegatedAmount: 5n }), [SPEND], "a different delegate");
  assert.deepEqual(controlDangers({ amount: 5n, delegate: stranger, delegatedAmount: 1n }, { amount: 5n, delegate: stranger, delegatedAmount: 5n }), [SPEND], "same delegate, bigger allowance");
  assert.deepEqual(controlDangers({ amount: 5n, delegate: stranger, delegatedAmount: 5n }, { amount: 5n, delegate: stranger, delegatedAmount: 2n }), [SPEND], "an allowance that changed at all is flagged while a delegate remains");
  assert.deepEqual(controlDangers({ amount: 5n }, { amount: 5n, delegate: stranger, delegatedAmount: 5n }, { beforeOwner: newAddress() }), [SPEND], "an account that becomes the wallet's with a stranger as delegate");
});

test("token accounts: changes that give no one else a say are not flagged", () => {
  const stranger = newAddress();
  const wallet = newAddress();
  assert.deepEqual(controlDangers({ amount: 9n }, { amount: 4n }), [], "an ordinary transfer out");
  assert.deepEqual(controlDangers({ amount: 5n, delegate: stranger, delegatedAmount: 5n }, { amount: 5n, delegate: stranger, delegatedAmount: 5n }), [], "an old delegate that did not change");
  assert.deepEqual(controlDangers({ amount: 5n, delegate: stranger, delegatedAmount: 5n }, { amount: 5n }), [], "revoking a delegate");
  assert.deepEqual(controlDangers({ amount: 5n, closeAuthority: stranger }, { amount: 5n }), [], "removing a close authority");
  assert.deepEqual(controlDangers({ amount: 5n }, { amount: 5n, delegate: wallet, delegatedAmount: 5n }, { wallet }), [], "a delegate that is the wallet itself");
  assert.deepEqual(controlDangers({ amount: 5n }, { amount: 5n, closeAuthority: wallet }, { wallet }), [], "a close authority that is the wallet itself");
  assert.deepEqual(controlDangers({ amount: 5n }, null), [], "closing an account");
  assert.deepEqual(controlDangers(null, { amount: 0n }), [], "a new, empty account");
  // Someone else's account is not the wallet's business.
  const key = Keypair.generate().publicKey;
  const mint = newAddress();
  const owner = newAddress();
  const pre = { lamports: 1, owner: TOKEN_PROGRAM_ID, data: tokenAccountBytes({ mint, owner, amount: 5n }) };
  const post = { lamports: 1, owner: TOKEN_PROGRAM_ID, data: tokenAccountBytes({ mint, owner, amount: 5n, delegate: stranger, delegatedAmount: 5n }) };
  assert.deepEqual(tokens.diffTokenAccounts({ keys: [key], pre: [pre], post: [post], wallet: newAddress() }).dangers, [], "another person's account");
});

test("token accounts: a close authority that is new or different, or a new owner, is 'changes who controls'", () => {
  const stranger = newAddress();
  assert.deepEqual(controlDangers({ amount: 5n }, { amount: 5n, closeAuthority: stranger }), [CONTROL]);
  assert.deepEqual(controlDangers({ amount: 5n, closeAuthority: newAddress() }, { amount: 5n, closeAuthority: stranger }), [CONTROL]);
  assert.deepEqual(controlDangers({ amount: 5n }, { amount: 5n, owner: stranger }), [CONTROL], "the account now belongs to someone else");
  assert.deepEqual(controlDangers({ amount: 5n }, { amount: 5n, owner: stranger, delegate: stranger, delegatedAmount: 5n }).sort(), [CONTROL, SPEND].sort(), "both can be said at once");
});

test("token accounts: Token-2022 accounts with extensions are read the same way", () => {
  const stranger = newAddress();
  const wallet = newAddress();
  const mint = newAddress();
  const key = Keypair.generate().publicKey;
  const make = (fields) => ({ lamports: 1, owner: TOKEN_2022_PROGRAM_ID, data: tokenAccountBytes({ mint, owner: wallet, extension: true, ...fields }) });
  const result = tokens.diffTokenAccounts({ keys: [key], pre: [make({ amount: 5n })], post: [make({ amount: 5n, delegate: stranger, delegatedAmount: 1n })], wallet });
  assert.deepEqual(result.dangers, [SPEND]);
});

/**
 * A chain whose simulation says what a program that Nod does not know would leave behind: the
 * wallet's token account with `change` applied. The stand-in Solana runtime has no such program, so
 * the post-state is written by hand; everything that READS it (the review, the card) is the real code.
 */
function chainWhere(ata, change) {
  return {
    ...chain,
    simulate: async (_transaction, publicKey, watch = []) => {
      const now = await chain.getAccounts(watch);
      const accounts = now.map((account, index) => (account && watch[index].toBase58() === ata ? { ...account, data: change(account.data) } : account));
      return { err: null, postLamports: await chain.getBalance(publicKey), logs: ["Program unknown invoke [1]", "Program unknown success"], accounts };
    },
  };
}

function withFields(fields) {
  return (data) => {
    const bytes = Buffer.from(data);
    if (fields.delegate) {
      bytes.writeUInt32LE(1, 72);
      new PublicKey(fields.delegate).toBuffer().copy(bytes, 76);
      bytes.writeBigUInt64LE(fields.delegatedAmount ?? 0n, 121);
    }
    if (fields.closeAuthority) {
      bytes.writeUInt32LE(1, 129);
      new PublicKey(fields.closeAuthority).toBuffer().copy(bytes, 133);
    }
    if (fields.owner) new PublicKey(fields.owner).toBuffer().copy(bytes, 32);
    return new Uint8Array(bytes);
  };
}

async function unknownProgramReview(w, mint, change) {
  const ata = tokens.associatedTokenAddress(w.address, mint, TOKEN_PROGRAM_ID);
  const unknown = Keypair.generate().publicKey; // a program Nod has never heard of
  const call = new TransactionInstruction({
    programId: unknown,
    keys: [
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(w.address), isSigner: true, isWritable: false },
    ],
    data: Buffer.from([1, 2, 3]),
  });
  const payload = await rawTokenTx(w.address, [call]);
  const real = await reviewRequest({ payload, walletAddress: w.address, chain: chainWhere(ata.toBase58(), change) });
  return presentReview(real);
}

test("an unknown program that sets a delegate on the wallet's token account is a red warning, whatever the instruction looked like", async () => {
  const mint = createMint(rpc, { decimals: 6 });
  const w = wallet({ mint });
  const presented = await unknownProgramReview(w, mint, withFields({ delegate: newAddress(), delegatedAmount: 18446744073709551615n }));
  // Nothing in the instruction says "approve": it is a program Nod does not recognise.
  assert.ok(presented.warnings.some((x) => /program this app does not recognise/.test(x.text)));
  assert.ok(presented.warnings.some((x) => x.level === "danger" && x.text === SPEND), JSON.stringify(presented.warnings));
  assert.deepEqual(presented.tokenAlerts, [SPEND], "on the card itself, once");
  assert.equal(presented.risky, true);
  assert.equal(presented.warnings.filter((x) => x.text === SPEND).length, 1);
});

test("an unknown program that sets a close authority or hands the account over says 'changes who controls'", async () => {
  const mint = createMint(rpc, { decimals: 6 });
  const w = wallet({ mint });
  const closer = await unknownProgramReview(w, mint, withFields({ closeAuthority: newAddress() }));
  assert.deepEqual(closer.tokenAlerts, [CONTROL]);
  const handedOver = await unknownProgramReview(w, mint, withFields({ owner: newAddress() }));
  assert.ok(handedOver.warnings.some((x) => x.level === "danger" && x.text === CONTROL));
});

test("an unknown program that leaves the token accounts alone adds no token warning", async () => {
  const mint = createMint(rpc, { decimals: 6 });
  const w = wallet({ mint });
  const presented = await unknownProgramReview(w, mint, (data) => data);
  assert.deepEqual(presented.tokenAlerts, []);
  assert.ok(!presented.warnings.some((x) => x.text === SPEND || x.text === CONTROL));
});

test("auto-approve never treats a transfer as plain when the simulation shows a delegate was set", async () => {
  const { tokenTransfer } = require("../shared/autoapprove");
  const mint = createMint(rpc, { decimals: 6 });
  const w = wallet({ mint });
  const to = newAddress();
  giveTokens(rpc, { owner: to, mint, amount: 1n });
  const real = await review(tokenPayload(mint, to, "5"), w.address);
  assert.ok(tokenTransfer(real, w.address), "a plain transfer is plain");
  const tampered = { ...real, preview: { ...real.preview, tokens: { ...real.preview.tokens, dangers: [SPEND] } } };
  assert.equal(tokenTransfer(tampered, w.address), null);
});

// ---------------------------------------------------------------- agent tools

const path = require("node:path");
const { spawn } = require("node:child_process");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { normalizeTokenAmount } = require("../agent/client");

const ROOT = path.join(__dirname, "..");

async function mcpClient(env = {}) {
  const client = new Client({ name: "test-agent", version: "0.0.1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, "agent/mcp-server.js")],
      env: { ...process.env, RELAY_URL: relayUrl, RELAY_TOKEN: agentToken, AGENT_NAME: "claude-code", APPROVAL_TIMEOUT_SECONDS: "20", ...env },
    }),
  );
  return client;
}

test("agent side: token amounts are plain decimals only", () => {
  assert.equal(normalizeTokenAmount("250"), "250");
  assert.equal(normalizeTokenAmount(" 0.5 "), "0.5");
  assert.equal(normalizeTokenAmount(12), "12");
  for (const bad of ["1e-7", 1e-7, "ten", "", "0", 0, -1, "1,5", null, undefined, NaN, Infinity]) {
    assert.throws(() => normalizeTokenAmount(bad), /plain decimal/, String(bad));
  }
});

test("MCP: request_token_transfer sends a token and the agent gets the signature", async () => {
  const mint = createMint(rpc, { decimals: 6 });
  const w = wallet({ mint });
  startPhone(w.keypair);
  await waitOnline();
  const client = await mcpClient();
  try {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "request_token_transfer");
    assert.deepEqual(tool.inputSchema.required, ["mint", "to", "amount"]);
    const to = newAddress();
    const done = await client.callTool({ name: "request_token_transfer", arguments: { mint, to, amount: "12.5", note: "pay" } });
    assert.ok(!done.isError, done.content[0].text);
    assert.match(done.content[0].text, /^APPROVED by the user\. Transaction signature: /);
    assert.equal(tokenBalance(rpc, { owner: to, mint }), 12_500_000n);

    const bad = await client.callTool({ name: "request_token_transfer", arguments: { mint, to, amount: "1e-7" } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /plain decimal/);
  } finally {
    await client.close();
  }
});

test("MCP: NETWORK=mainnet makes the request for mainnet, and the devnet phone refuses it", async () => {
  const mint = createMint(rpc, { decimals: 6 });
  const w = wallet({ mint });
  startPhone(w.keypair);
  await waitOnline();
  const client = await mcpClient({ NETWORK: "mainnet" });
  try {
    const to = newAddress();
    const refused = await client.callTool({ name: "request_token_transfer", arguments: { mint, to, amount: "1" } });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /for Mainnet, but this phone is on Devnet/);
    assert.equal(tokenBalance(rpc, { owner: to, mint }), null);
    assert.equal(tokenBalance(rpc, { owner: w.address, mint }), 1_000_000_000n);
  } finally {
    await client.close();
  }
});

test("MCP: a wrong NETWORK stops the server at start, with the reason", async () => {
  await assert.rejects(mcpClient({ NETWORK: "mainet" }), /Unknown network "mainet"|closed|exit/i);
});

test("CLI: `request.js token` asks for a token and prints the signature", async () => {
  const mint = createMint(rpc, { decimals: 6 });
  const w = wallet({ mint });
  startPhone(w.keypair);
  await waitOnline();
  const to = newAddress();
  const run = (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(ROOT, "agent/request.js"), ...args], {
        env: { ...process.env, RELAY_URL: relayUrl, RELAY_TOKEN: agentToken },
      });
      let output = "";
      child.stdout.on("data", (c) => (output += c));
      child.stderr.on("data", (c) => (output += c));
      child.on("close", (code) => resolve({ code, output }));
    });
  const ok = await run(["token", "--mint", mint, "--to", to, "--amount", "3", "--note", "pay 3 tokens"]);
  assert.equal(ok.code, 0, ok.output);
  assert.match(ok.output, /APPROVED/);
  assert.equal(tokenBalance(rpc, { owner: to, mint }), 3_000_000n);
  const noMint = await run(["token", "--to", to, "--amount", "3"]);
  assert.equal(noMint.code, 2);
  assert.match(noMint.output, /--mint/);
  const badAmount = await run(["token", "--mint", mint, "--to", to, "--amount", "1e3"]);
  assert.equal(badAmount.code, 2);
  assert.match(badAmount.output, /plain decimal/);
});
