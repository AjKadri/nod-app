"use strict";
/**
 * Task 8C: SKR as a first-class token, per-token daily limits, and auto-approve for tokens.
 *
 * Real pieces: the phone's review code and the Solana runtime (LiteSVM) with the real SPL Token and
 * Token-2022 programs. Devnet has no real SKR, so tests use a test mint labelled "SKR (test)"; the
 * official mint address is also put into the stand-in so its display can be checked.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { Connection, Keypair, LAMPORTS_PER_SOL } = require("@solana/web3.js");

const { createLocalRpc } = require("../sim/local-rpc");
const { reviewRequest } = require("../shared/approval");
const { presentReview } = require("../shared/present");
const { rpcChain } = require("../shared/chain");
const { submitAutoApproval } = require("../shared/flow");
const tokens = require("../shared/tokens");
const {
  decideAutoApprove,
  addressToLearn,
  ledgerEntryFor,
  normalizeTokenLimit,
  tokenLimitRaw,
  spentTodayToken,
  remainingToken,
  parseStored,
  isEnabled,
  startOfLocalDay,
} = require("../shared/autoapprove");
const { createMint, giveTokens } = require("./helpers/tokens");

const { SKR_MINT } = tokens;

let rpc;
let connection;
let chain;

before(async () => {
  rpc = createLocalRpc({ port: 0 });
  const { url } = await rpc.listen();
  connection = new Connection(url, "confirmed");
  chain = rpcChain(connection, "devnet");
});

after(async () => {
  await rpc.close();
});

const NOW = new Date(2026, 9, 10, 14, 30, 0).getTime();
const newAddress = () => Keypair.generate().publicKey.toBase58();
const payload = (mint, to, amount, extra = {}) => ({ type: "token_transfer", mint, to, amount, note: "", agent: "bot", network: "devnet", ...extra });

function wallet(mint, amount = 5_000_000_000n) {
  const keypair = Keypair.generate();
  rpc.airdrop(keypair.publicKey, LAMPORTS_PER_SOL);
  if (mint) giveTokens(rpc, { owner: keypair.publicKey.toBase58(), mint, amount });
  return keypair.publicKey.toBase58();
}

/** A test SKR on devnet, a registry that names it, and a recipient that already has a token account. */
function setup({ decimals = 6 } = {}) {
  const mint = createMint(rpc, { decimals, symbol: "SKR" });
  const registry = tokens.tokenRegistry("devnet", { testSkrMint: mint });
  const me = wallet(mint);
  const friend = newAddress();
  giveTokens(rpc, { owner: friend, mint, amount: 1n });
  return { mint, registry, me, friend };
}

const review = (s, amount, to, extra) =>
  reviewRequest({ payload: payload(s.mint, to || s.friend, amount, extra), walletAddress: s.me, chain, registry: s.registry });

const SETTINGS = (mint, limit = "100") => ({ enabled: true, limitLamports: 0, tokenLimits: { [mint]: limit } });

function decide(s, real, overrides = {}) {
  return decideAutoApprove({
    review: real,
    settings: SETTINGS(s.mint),
    walletAddress: s.me,
    knownAddresses: [s.friend],
    ledger: [],
    now: NOW,
    paused: false,
    appActive: true,
    ...overrides,
  });
}

// ---------------------------------------------------------------- SKR in the registry

test("the official SKR mint is SKR on mainnet, with its logo, and nothing else is", () => {
  const mainnet = tokens.tokenRegistry("mainnet");
  assert.equal(SKR_MINT, "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3");
  assert.deepEqual(mainnet.tokens[SKR_MINT], { symbol: "SKR", label: "SKR", logo: "skr" });
  assert.equal(tokens.tokenLabel(mainnet, SKR_MINT), "SKR");
  const other = newAddress();
  assert.equal(tokens.tokenLabel(mainnet, other), tokens.shortMint(other), "an unknown token is its shortened mint");
  assert.equal(tokens.officialMintFor(mainnet, "SKR"), SKR_MINT);
});

test("devnet has no real SKR: the test mint stands in, labelled “SKR (test)”", () => {
  const test = newAddress();
  const devnet = tokens.tokenRegistry("devnet", { testSkrMint: test });
  assert.equal(devnet.tokens[SKR_MINT], undefined, "the real mint is not named on devnet");
  assert.equal(tokens.tokenLabel(devnet, test), "SKR (test)");
  assert.equal(devnet.tokens[test].test, true);
  assert.equal(tokens.officialMintFor(devnet, "SKR"), test);
  assert.equal(tokens.tokenRegistry("devnet").tokens[test], undefined, "without a test mint there is no SKR at all");
  assert.equal(tokens.tokenRegistry("devnet", { testSkrMint: SKR_MINT }).tokens[SKR_MINT], undefined, "the real address is never a 'test' SKR");
});

test("the card shows the official SKR by name with its logo and no warning", async () => {
  // Put the official mint address into the stand-in and review with the mainnet registry.
  createMint(rpc, { decimals: 6, symbol: "SKR", mint: SKR_MINT });
  const me = wallet(SKR_MINT);
  const to = newAddress();
  giveTokens(rpc, { owner: to, mint: SKR_MINT, amount: 1n });
  const real = await reviewRequest({ payload: payload(SKR_MINT, to, "250"), walletAddress: me, chain, registry: tokens.tokenRegistry("mainnet") });
  const presented = presentReview(real);
  assert.equal(presented.amount, "250");
  assert.equal(presented.unit, "SKR");
  assert.equal(presented.token.logo, "skr");
  assert.equal(presented.token.known, true);
  assert.deepEqual(presented.warnings, []);
});

test("a token that calls itself SKR with another mint gets the red warning", async () => {
  const s = setup();
  const fake = createMint(rpc, { decimals: 6, symbol: "SKR" });
  const me = wallet(fake);
  const to = newAddress();
  giveTokens(rpc, { owner: to, mint: fake, amount: 1n });
  const real = await reviewRequest({ payload: payload(fake, to, "250", { note: "pay 250 SKR" }), walletAddress: me, chain, registry: s.registry });
  const presented = presentReview(real);
  assert.equal(presented.unit, tokens.shortMint(fake), "never shown as SKR");
  assert.equal(presented.token.known, false);
  assert.equal(presented.token.logo, null);
  assert.ok(
    presented.warnings.some((w) => w.level === "danger" && w.text === "This token claims to be SKR but isn’t the official SKR."),
    JSON.stringify(presented.warnings),
  );
  assert.equal(presented.risky, true);
});

test("the test SKR itself does not trigger the warning", async () => {
  const s = setup();
  const presented = presentReview(await review(s, "5"));
  assert.equal(presented.unit, "SKR (test)");
  assert.deepEqual(presented.warnings, []);
});

test("a note that says 25 SKR while 250 SKR leave is caught", async () => {
  const s = setup();
  const real = await review(s, "250", undefined, { note: "sending 25 SKR" });
  const presented = presentReview(real);
  assert.equal(presented.mismatch.said, "25 SKR");
  assert.equal(presented.mismatch.actual, "250 SKR");
  assert.equal(presented.mismatch.message, "The agent said 25 SKR. This sends 250 SKR.");
  assert.equal(presented.risky, true);
});

// ---------------------------------------------------------------- limit arithmetic

test("token limits: typed amounts are normalised and bad ones refused", () => {
  assert.equal(normalizeTokenLimit("100"), "100");
  assert.equal(normalizeTokenLimit(" 0,50 "), "0.5");
  assert.equal(normalizeTokenLimit("007.250"), "7.25");
  for (const bad of ["", "0", "0.000", "-5", "1e3", "abc", "1.2.3", "1.0000000001", "9999999999999", null, 5, undefined]) {
    assert.equal(normalizeTokenLimit(bad), null, String(bad));
  }
});

test("token limits: whole units come from the mint's decimals, never a guess", () => {
  const mint = newAddress();
  const settings = { tokenLimits: { [mint]: "100.5" } };
  assert.equal(tokenLimitRaw(settings, mint, 6), 100_500_000n);
  assert.equal(tokenLimitRaw(settings, mint, 9), 100_500_000_000n);
  assert.equal(tokenLimitRaw(settings, mint, 1), 1005n);
  assert.equal(tokenLimitRaw(settings, mint, 0), null, "a limit with decimals that the token does not have is no limit");
  assert.equal(tokenLimitRaw(settings, newAddress(), 6), null, "no limit set for that token");
});

test("token limits: spent today counts this token only, since local midnight", () => {
  const a = newAddress();
  const b = newAddress();
  const midnight = startOfLocalDay(NOW);
  const ledger = [
    { id: "1", at: NOW, lamports: 5000, tokens: [{ mint: a, raw: "60000000" }] },
    { id: "2", at: NOW - 1000, lamports: 5000, tokens: [{ mint: b, raw: "999" }] },
    { id: "3", at: midnight - 1, lamports: 5000, tokens: [{ mint: a, raw: "70000000" }] }, // yesterday
    { id: "4", at: midnight, lamports: 5000, tokens: [{ mint: a, raw: "1" }] }, // exactly midnight counts
    { id: "5", at: NOW, lamports: 5000 }, // a SOL payment
  ];
  assert.equal(spentTodayToken(ledger, a, NOW), 60_000_001n);
  assert.equal(spentTodayToken(ledger, b, NOW), 999n);
  assert.equal(spentTodayToken(ledger, newAddress(), NOW), 0n);
});

test("token limits: what is left = limit − spent − in progress, never below zero, exact beyond 2^53", () => {
  const mint = newAddress();
  const ledger = [{ id: "1", at: NOW, lamports: 0, tokens: [{ mint, raw: "60000000" }] }];
  const left = (limitRaw, reserved = []) => remainingToken({ limitRaw, ledger, reserved, mint, now: NOW });
  assert.equal(left(100_000_000n), 40_000_000n);
  assert.equal(left(100_000_000n, [{ mint, raw: "15000000" }]), 25_000_000n);
  assert.equal(left(100_000_000n, [{ mint: newAddress(), raw: "15000000" }]), 40_000_000n, "another token's reservation does not count");
  assert.equal(left(50_000_000n), 0n, "overspent is zero, not negative");
  const huge = 9_007_199_254_740_993n; // 2^53 + 1
  const big = [{ id: "b", at: NOW, lamports: 0, tokens: [{ mint, raw: "9007199254740992" }] }];
  assert.equal(remainingToken({ limitRaw: huge, ledger: big, mint, now: NOW }), 1n);
});

test("saved state: token limits and token spending survive a round trip, junk is dropped", () => {
  const mint = newAddress();
  const stored = {
    settings: { enabled: true, limitLamports: 0, tokenLimits: { [mint]: "100" } },
    known: [],
    ledger: [{ id: "a", at: NOW, lamports: 5000, tokens: [{ mint, raw: "250", decimals: 6 }] }],
  };
  assert.deepEqual(parseStored(JSON.stringify(stored)), stored);
  const messy = parseStored(
    JSON.stringify({
      settings: { enabled: true, limitLamports: 0, tokenLimits: { [mint]: "5", junk: "5", [newAddress()]: "-1", [newAddress()]: 7 } },
      ledger: [{ id: "a", at: NOW, lamports: 0, tokens: [{ mint, raw: "-1" }, { mint: "x", raw: "1" }, { mint, raw: "2" }] }],
    }),
  );
  assert.deepEqual(messy.settings.tokenLimits, { [mint]: "5" });
  assert.deepEqual(messy.ledger[0].tokens, [{ mint, raw: "2" }]);
  // An old save (SOL only) still reads, and has no token limits.
  const old = parseStored(JSON.stringify({ settings: { enabled: true, limitLamports: 5_000_000 }, known: [], ledger: [{ id: "x", at: NOW, lamports: 1 }] }));
  assert.deepEqual(old.settings, { enabled: true, limitLamports: 5_000_000, tokenLimits: {} });
  assert.deepEqual(old.ledger, [{ id: "x", at: NOW, lamports: 1 }]);
  // The switch means nothing without any limit.
  assert.equal(parseStored(JSON.stringify({ settings: { enabled: true } })).settings.enabled, false);
});

test("auto-approve is in use with a SOL limit, a token limit, or both", () => {
  const mint = newAddress();
  assert.equal(isEnabled({ enabled: true, limitLamports: 0, tokenLimits: {} }), false);
  assert.equal(isEnabled({ enabled: true, limitLamports: 1, tokenLimits: {} }), true);
  assert.equal(isEnabled({ enabled: true, limitLamports: 0, tokenLimits: { [mint]: "1" } }), true);
  assert.equal(isEnabled({ enabled: false, limitLamports: 1, tokenLimits: { [mint]: "1" } }), false);
});

// ---------------------------------------------------------------- the decision, on real reviews

test("auto-approve: a plain SKR transfer to a known recipient inside today's limit", async () => {
  const s = setup();
  const real = await review(s, "40");
  const decision = decide(s, real);
  assert.equal(decision.auto, true, JSON.stringify(decision));
  assert.deepEqual(decision.token, { mint: s.mint, raw: "40000000" });
  assert.equal(decision.to, s.friend);
  assert.equal(decision.outflowLamports, 5000, "only the fee leaves in SOL");
});

test("auto-approve: exactly the limit passes, one unit more asks", async () => {
  const s = setup();
  assert.equal(decide(s, await review(s, "100")).auto, true);
  const over = decide(s, await review(s, "100.000001"));
  assert.equal(over.auto, false);
  assert.equal(over.code, "over_limit");
  assert.match(over.reason, /SKR \(test\) limit \(100 SKR \(test\)\)/);
});

test("auto-approve: today's SKR payments (manual and automatic) use up the SKR limit", async () => {
  const s = setup();
  const first = await review(s, "60");
  const entry = ledgerEntryFor({ id: "r1", review: first, outcome: { status: "approved", signature: "SIG" }, now: NOW });
  assert.deepEqual(entry, { id: "r1", at: NOW, lamports: 5000, tokens: [{ mint: s.mint, raw: "60000000", decimals: 6 }] });
  const second = decide(s, await review(s, "50"), { ledger: [entry] });
  assert.equal(second.auto, false);
  assert.equal(second.code, "over_limit");
  assert.match(second.reason, /\(40 SKR \(test\)\)/);
  assert.equal(decide(s, await review(s, "40"), { ledger: [entry] }).auto, true);
  // A payment that has started but not finished is held back too.
  const held = decide(s, await review(s, "10"), { reservedTokens: [{ mint: s.mint, raw: "95000000" }] });
  assert.equal(held.code, "over_limit");
  // Tomorrow it is a new day.
  const tomorrow = NOW + 24 * 60 * 60 * 1000;
  assert.equal(decide(s, await review(s, "100"), { ledger: [entry], now: tomorrow }).auto, true);
});

test("auto-approve: a failed-on-chain token payment only used the fee", async () => {
  const s = setup();
  const real = await review(s, "60");
  const entry = ledgerEntryFor({ id: "r1", review: real, outcome: { status: "failed", signature: "SIG", failedOnChain: true }, now: NOW });
  assert.deepEqual(entry, { id: "r1", at: NOW, lamports: 5000 });
});

test("auto-approve: SOL and SKR limits are separate", async () => {
  const s = setup();
  const real = await review(s, "10");
  // Only a SOL limit: a token payment has no limit and asks.
  const solOnly = decide(s, real, { settings: { enabled: true, limitLamports: 50_000_000, tokenLimits: {} } });
  assert.equal(solOnly.auto, false);
  assert.equal(solOnly.code, "no_limit");
  // A SOL limit that is used up does not stop a token payment, and its fee is recorded as SOL.
  const used = [{ id: "s", at: NOW, lamports: 50_000_000 }];
  const both = decide(s, real, { settings: { enabled: true, limitLamports: 50_000_000, tokenLimits: { [s.mint]: "100" } }, ledger: used });
  assert.equal(both.auto, true);
  // Token spending never uses up the SOL limit beyond the fee.
  assert.equal(ledgerEntryFor({ id: "t", review: real, outcome: { status: "approved", signature: "S" }, now: NOW }).lamports, 5000);
});

test("auto-approve: the other rules hold for tokens too", async () => {
  const s = setup();
  const real = await review(s, "10");
  assert.equal(decide(s, real).auto, true);
  assert.equal(decide(s, real, { knownAddresses: [] }).code, "unknown_recipient");
  assert.equal(decide(s, real, { knownAddresses: [newAddress()] }).code, "unknown_recipient");
  assert.equal(decide(s, real, { paused: true }).code, "paused");
  assert.equal(decide(s, real, { appActive: false }).code, "background");
  assert.equal(decide(s, real, { settings: { ...SETTINGS(s.mint), enabled: false } }).code, "off");
  assert.equal(decide(s, real, { settings: SETTINGS(s.mint, "0") }).code, "no_limit");
});

test("auto-approve: a recipient with no token account yet needs a person (rent would leave the wallet)", async () => {
  const s = setup();
  const stranger = newAddress();
  const real = await review(s, "10", stranger);
  assert.ok(presentReview(real).notes.length > 0);
  const decision = decide(s, real, { knownAddresses: [stranger] });
  assert.equal(decision.auto, false);
  assert.equal(decision.code, "not_plain");
});

test("auto-approve: a warning of any kind means the card", async () => {
  const s = setup();
  const real = await review(s, "10", undefined, { note: "pay 1 SKR" });
  assert.ok(presentReview(real).warnings.length > 0);
  assert.equal(decide(s, real).code, "warnings");
});

test("auto-approve: a token that only calls itself SKR is never approved automatically", async () => {
  const s = setup();
  const fake = createMint(rpc, { decimals: 6, symbol: "SKR" });
  const me = wallet(fake);
  const to = newAddress();
  giveTokens(rpc, { owner: to, mint: fake, amount: 1n });
  const real = await reviewRequest({ payload: payload(fake, to, "1"), walletAddress: me, chain, registry: s.registry });
  const decision = decideAutoApprove({
    review: real,
    settings: SETTINGS(fake), // even with a limit set for it
    walletAddress: me,
    knownAddresses: [to],
    ledger: [],
    now: NOW,
    paused: false,
    appActive: true,
  });
  assert.equal(decision.auto, false);
  assert.ok(["warnings", "unknown_token"].includes(decision.code), decision.code);
});

test("auto-approve: a token Nod does not name is not approved automatically", async () => {
  const s = setup();
  const plain = createMint(rpc, { decimals: 6 });
  const me = wallet(plain);
  const to = newAddress();
  giveTokens(rpc, { owner: to, mint: plain, amount: 1n });
  const real = await reviewRequest({ payload: payload(plain, to, "1"), walletAddress: me, chain, registry: s.registry });
  const decision = decideAutoApprove({
    review: real,
    settings: SETTINGS(plain),
    walletAddress: me,
    knownAddresses: [to],
    ledger: [],
    now: NOW,
    paused: false,
    appActive: true,
  });
  assert.equal(decision.code, "unknown_token");
});

test("auto-approve: a hand-built review cannot hide an extra instruction or a second token", async () => {
  const s = setup();
  const real = await review(s, "10");
  const extraInstruction = { ...real, summary: { ...real.summary, instructionCount: 2, tokenInstructions: ["transfer", "other"] } };
  assert.equal(decide(s, extraInstruction).code, "not_plain");
  const approve = { ...real, summary: { ...real.summary, tokenInstructions: ["transfer"], tokenDangers: ["This transaction lets another address spend your tokens."] } };
  assert.notEqual(decide(s, approve).auto, true);
  const incomplete = { ...real, preview: { ...real.preview, tokens: { ...real.preview.tokens, complete: false } } };
  assert.equal(decide(s, incomplete).auto, false);
  const skimmed = {
    ...real,
    preview: { ...real.preview, tokens: { ...real.preview.tokens, others: [{ ...real.preview.tokens.others[0], deltaRaw: "9000000" }] } },
  };
  assert.equal(decide(s, skimmed).code, "not_plain", "less arrives than leaves");
  const extraSol = { ...real, preview: { ...real.preview, deltaLamports: -(5000 + 1_000_000) } };
  assert.equal(decide(s, extraSol).code, "amounts", "SOL leaves beyond the fee");
});

test("learning: a token payment the person approved teaches the recipient, with or without account creation", async () => {
  const s = setup();
  const approved = { status: "approved", signature: "SIG" };
  assert.equal(addressToLearn({ review: await review(s, "10"), outcome: approved, walletAddress: s.me }), s.friend);
  const stranger = newAddress();
  assert.equal(addressToLearn({ review: await review(s, "10", stranger), outcome: approved, walletAddress: s.me }), stranger);
  assert.equal(addressToLearn({ review: await review(s, "10"), outcome: { status: "denied" }, walletAddress: s.me }), null);
  assert.equal(addressToLearn({ review: await review(s, "10", undefined, { note: "1 SKR" }), outcome: approved, walletAddress: s.me }), null, "approving over a warning teaches nothing");
});

// ---------------------------------------------------------------- the wallet step

const fakeRelay = () => {
  const sent = [];
  return { sent, sendResult: async (id, result) => void sent.push({ id, result }) };
};

const autoChain = () => ({
  ...chain,
  confirm: async () => ({ confirmed: true }),
});

test("wallet step: an automatic token payment is signed as reviewed", async () => {
  const s = setup();
  const relay = fakeRelay();
  let signed = null;
  const outcome = await submitAutoApproval({
    request: { id: "t1", payload: payload(s.mint, s.friend, "40") },
    walletAddress: s.me,
    chain: autoChain(),
    relay,
    signAndSend: async (transaction) => {
      signed = transaction;
      return "SIG";
    },
  });
  assert.equal(outcome.status, "approved");
  assert.equal(signed.message.compiledInstructions.length, 1, "one instruction: the transfer");
});

test("wallet step: if the recipient's account has gone missing since the check, nothing is signed and the card comes back", async () => {
  const s = setup();
  const relay = fakeRelay();
  const stranger = newAddress(); // no token account: building the payment would also create one
  let asked = false;
  const outcome = await submitAutoApproval({
    request: { id: "t2", payload: payload(s.mint, stranger, "10") },
    walletAddress: s.me,
    chain: autoChain(),
    relay,
    signAndSend: async () => void (asked = true),
  });
  assert.equal(outcome.status, "needs_card");
  assert.equal(asked, false);
  assert.equal(relay.sent.length, 0, "the agent hears nothing; the request stays pending");
});
