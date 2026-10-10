"use strict";
/**
 * Auto-approve: the limit arithmetic and one test for each "never" rule.
 *
 * Most tests use hand-built reviews so each rule can be broken on its own. The last section uses
 * real reviews (real transactions, simulated by the local Solana runtime) so the rules are also
 * checked against what the phone actually produces.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { Connection, ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } = require("@solana/web3.js");

const {
  MAX_LIMIT_LAMPORTS,
  parseSolToLamports,
  startOfLocalDay,
  spentToday,
  remainingLamports,
  pruneLedger,
  outflowLamports,
  plainSolTransfer,
  isPausedForAuto,
  decideAutoApprove,
  addressToLearn,
  ledgerEntryFor,
  addKnownAddress,
  removeKnownAddress,
  parseStored,
} = require("../shared/autoapprove");
const { reviewRequest } = require("../shared/approval");
const { NeedsCardError, submitAutoApproval, submitApproval } = require("../shared/flow");
const { rpcChain } = require("../shared/chain");
const { createLocalRpc } = require("../sim/local-rpc");

const SOL = 1_000_000_000;
const SYSTEM = "11111111111111111111111111111111";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const FEE = 5_000;

const WALLET = Keypair.generate().publicKey.toBase58();
const FRIEND = Keypair.generate().publicKey.toBase58();
const STRANGER = Keypair.generate().publicKey.toBase58();

/** A review of "send `lamports` to `to`", the way reviewRequest builds one. */
function review({
  lamports = 10_000_000,
  to = FRIEND,
  from = WALLET,
  note = "",
  fee = FEE,
  delta,
  ok = true,
  programs,
  transfers,
  instructionCount = 1,
  signerCount = 1,
  usesLookupTables = false,
  refreshable = true,
} = {}) {
  const progs = programs || [{ id: SYSTEM, name: "System Program" }];
  return {
    request: { type: "transfer", note, agent: "Research agent" },
    summary: {
      programs: progs,
      transfers: transfers || [{ from, to, lamports }],
      instructionCount,
      signerCount,
      usesLookupTables,
      unknownPrograms: progs.filter((p) => !p.name).map((p) => p.id),
    },
    preview: {
      ok,
      preLamports: 1 * SOL,
      postLamports: ok ? 1 * SOL + (delta ?? -(lamports + fee)) : null,
      deltaLamports: ok ? (delta ?? -(lamports + fee)) : null,
      feeLamports: fee,
      error: ok ? null : "custom program error",
      logs: [],
    },
    headline: "",
    refreshable,
    signerCount,
  };
}

const NOW = new Date(2026, 9, 9, 14, 30, 0).getTime(); // 9 Oct 2026, 14:30 local
const SETTINGS = { enabled: true, limitLamports: 50_000_000 }; // 0.05 SOL

/** Decide with everything in order, then break one thing at a time. */
function decide(overrides = {}) {
  return decideAutoApprove({
    review: review(),
    settings: SETTINGS,
    walletAddress: WALLET,
    knownAddresses: [FRIEND],
    ledger: [],
    reservedLamports: 0,
    now: NOW,
    paused: false,
    appActive: true,
    ...overrides,
  });
}

const refused = (result, code) => {
  assert.equal(result.auto, false, `expected the card, got auto-approve (${JSON.stringify(result)})`);
  assert.equal(result.code, code);
  assert.ok(result.reason.length > 0);
};

// ---------------------------------------------------------------- typing the limit

test("limit: the text field is read as SOL, with a dot or a comma", () => {
  assert.equal(parseSolToLamports("0.05"), 50_000_000);
  assert.equal(parseSolToLamports("0,05"), 50_000_000);
  assert.equal(parseSolToLamports(" 1 "), SOL);
  assert.equal(parseSolToLamports(".5"), 500_000_000);
  assert.equal(parseSolToLamports("0.000000001"), 1);
  assert.equal(parseSolToLamports("100"), MAX_LIMIT_LAMPORTS);
});

test("limit: zero, negative, too precise, too big and non-numbers are refused", () => {
  for (const bad of ["", " ", "0", "0.0", "-1", "1e3", "0.0000000001", "100.000000001", "101", "abc", "1.2.3", "5 SOL", "0x10", "NaN", "Infinity", "99999999999999999999"]) {
    assert.equal(parseSolToLamports(bad), null, JSON.stringify(bad));
  }
  assert.equal(parseSolToLamports(undefined), null);
  assert.equal(parseSolToLamports(5), null);
});

// ---------------------------------------------------------------- the day, and what is left of it

test("limit: today starts at local midnight", () => {
  assert.equal(startOfLocalDay(NOW), new Date(2026, 9, 9, 0, 0, 0, 0).getTime());
  assert.equal(startOfLocalDay(new Date(2026, 9, 9, 0, 0, 0, 0).getTime()), new Date(2026, 9, 9).getTime());
  assert.equal(startOfLocalDay(new Date(2026, 9, 9, 23, 59, 59, 999).getTime()), new Date(2026, 9, 9).getTime());
});

test("limit: a payment counts until local midnight and not after it", () => {
  const lateEvening = new Date(2026, 9, 9, 23, 59, 59, 999).getTime();
  const midnight = new Date(2026, 9, 10, 0, 0, 0, 0).getTime();
  const ledger = [{ id: "a", at: lateEvening, lamports: 30_000_000 }];

  assert.equal(spentToday(ledger, lateEvening), 30_000_000);
  assert.equal(remainingLamports({ limitLamports: 50_000_000, ledger, now: lateEvening }), 20_000_000);
  // One millisecond later it is a new day: the limit is whole again.
  assert.equal(spentToday(ledger, midnight), 0);
  assert.equal(remainingLamports({ limitLamports: 50_000_000, ledger, now: midnight }), 50_000_000);
});

test("limit: a payment made at exactly midnight belongs to the new day", () => {
  const midnight = new Date(2026, 9, 10, 0, 0, 0, 0).getTime();
  const ledger = [{ id: "a", at: midnight, lamports: 7 }];
  assert.equal(spentToday(ledger, midnight), 7);
  assert.equal(spentToday(ledger, midnight - 1), 7, "an entry from the future of `now` is never ignored");
});

test("limit: spending adds up, and reservations for payments in progress are held back", () => {
  const ledger = [
    { id: "a", at: NOW - 3_600_000, lamports: 10_005_000 },
    { id: "b", at: NOW - 60_000, lamports: 5_005_000 },
  ];
  assert.equal(spentToday(ledger, NOW), 15_010_000);
  assert.equal(remainingLamports({ limitLamports: 50_000_000, ledger, now: NOW }), 34_990_000);
  assert.equal(remainingLamports({ limitLamports: 50_000_000, ledger, reservedLamports: 4_990_000, now: NOW }), 30_000_000);
});

test("limit: what is left is never below zero, even after a lowered limit", () => {
  const ledger = [{ id: "a", at: NOW, lamports: 60_000_000 }];
  assert.equal(remainingLamports({ limitLamports: 50_000_000, ledger, now: NOW }), 0);
  assert.equal(remainingLamports({ limitLamports: 50_000_000, ledger: [], reservedLamports: 99 * SOL, now: NOW }), 0);
});

test("limit: broken ledger rows are ignored, not counted as free money or as NaN", () => {
  const ledger = [null, {}, { id: "x", at: NOW, lamports: "5" }, { id: "y", at: NOW, lamports: 1.5 }, { id: "z", at: NOW, lamports: 3 }];
  assert.equal(spentToday(ledger, NOW), 3);
  assert.equal(spentToday(undefined, NOW), 0);
});

test("limit: the ledger keeps yesterday and today, drops older days", () => {
  const day = 24 * 60 * 60 * 1000;
  const ledger = [
    { id: "old", at: startOfLocalDay(NOW) - day - 1, lamports: 1 },
    { id: "yesterday", at: startOfLocalDay(NOW) - day + 1, lamports: 1 },
    { id: "today", at: NOW, lamports: 1 },
  ];
  assert.deepEqual(pruneLedger(ledger, NOW).map((e) => e.id), ["yesterday", "today"]);
});

// ---------------------------------------------------------------- what leaves the wallet

test("outflow: comes from the simulation, network fee included", () => {
  assert.equal(outflowLamports(review({ lamports: 10_000_000, fee: 5_000 })), 10_005_000);
  assert.equal(outflowLamports(review({ lamports: 10_000_000, delta: -12_345_678 })), 12_345_678);
});

test("outflow: with no usable simulation, the transfers plus the fee (or 5000 if the fee is unknown)", () => {
  assert.equal(outflowLamports(review({ lamports: 10_000_000, ok: false, fee: 7_000 })), 10_007_000);
  const noFee = review({ lamports: 10_000_000, ok: false });
  noFee.preview.feeLamports = null;
  assert.equal(outflowLamports(noFee), 10_005_000);
});

// ---------------------------------------------------------------- the happy path and its edges

test("auto: a plain transfer to a known address inside the limit is approved", () => {
  const result = decide();
  assert.deepEqual(result, { auto: true, outflowLamports: 10_005_000, to: FRIEND });
});

test("limit: the fee counts. A transfer that fits only without its fee is refused", () => {
  // 0.05 SOL limit. 0.05 SOL + 5000 fee leaves the wallet: 5000 too much.
  refused(decide({ review: review({ lamports: 50_000_000 }) }), "over_limit");
  // Exactly the limit, fee included, is allowed.
  assert.equal(decide({ review: review({ lamports: 49_995_000 }) }).auto, true);
  // One lamport more is not.
  refused(decide({ review: review({ lamports: 49_995_001 }) }), "over_limit");
});

test("limit: earlier spending today shrinks what can be auto-approved", () => {
  const ledger = [{ id: "a", at: NOW - 1000, lamports: 40_000_000 }];
  // 10_000_000 left.
  assert.equal(decide({ ledger, review: review({ lamports: 9_995_000 }) }).auto, true);
  refused(decide({ ledger, review: review({ lamports: 9_995_001 }) }), "over_limit");
});

test("limit: two requests at once cannot both use the same money", () => {
  const first = decide({ review: review({ lamports: 30_000_000 }) });
  assert.equal(first.auto, true);
  // The phone reserves the first one's money before it looks at the second.
  refused(decide({ review: review({ lamports: 30_000_000 }), reservedLamports: first.outflowLamports }), "over_limit");
});

test("limit: yesterday's spending does not count today", () => {
  const yesterday = new Date(2026, 9, 8, 23, 59, 0).getTime();
  const ledger = [{ id: "a", at: yesterday, lamports: 50_000_000 }];
  assert.equal(decide({ ledger, review: review({ lamports: 40_000_000 }) }).auto, true);
});

test("limit: a manual payment today uses up the limit too", () => {
  const ledger = [{ id: "manual", at: NOW - 5000, lamports: 45_000_000 }];
  refused(decide({ ledger, review: review({ lamports: 10_000_000 }) }), "over_limit");
});

test("limit: lowering the limit below what is already spent refuses everything until midnight", () => {
  const ledger = [{ id: "a", at: NOW - 1000, lamports: 30_000_000 }];
  refused(decide({ ledger, settings: { enabled: true, limitLamports: 20_000_000 }, review: review({ lamports: 1 }) }), "over_limit");
});

// ---------------------------------------------------------------- never: it is not switched on

test("never: while auto-approve is off", () => {
  refused(decide({ settings: { enabled: false, limitLamports: 50_000_000 } }), "off");
});

test("never: with no limit, or a limit that is not a whole positive number of lamports", () => {
  for (const limitLamports of [0, -1, 1.5, NaN, Infinity, "50000000", null, undefined]) {
    refused(decide({ settings: { enabled: true, limitLamports } }), "off");
  }
  refused(decide({ settings: undefined }), "off");
  refused(decide({ settings: { enabled: "true", limitLamports: 50_000_000 } }), "off");
});

// ---------------------------------------------------------------- never: while paused

test("never: while Pause everything is on, or on only some laptops, or just switched on", () => {
  refused(decide({ paused: true }), "paused");
  assert.equal(isPausedForAuto({ pauseState: "on" }), true);
  assert.equal(isPausedForAuto({ pauseState: "partial" }), true);
  assert.equal(isPausedForAuto({ pauseState: "off" }), false);
  // The person tapped Pause but the relay has not confirmed it yet.
  assert.equal(isPausedForAuto({ pauseState: "off", unconfirmedPause: true }), true);
  // "Not sure" is not "not paused".
  refused(decide({ paused: undefined }), "paused");
  refused(decide({ paused: "off" }), "paused");
});

// ---------------------------------------------------------------- never: Nod is not on screen

test("never: when Nod was not open on the screen", () => {
  refused(decide({ appActive: false }), "background");
  refused(decide({ appActive: undefined }), "background");
});

// ---------------------------------------------------------------- never: the preview failed

test("never: when the preview failed", () => {
  refused(decide({ review: review({ ok: false }) }), "preview_failed");
});

test("never: when there is no preview or no review at all", () => {
  const noPreview = review();
  delete noPreview.preview;
  refused(decide({ review: noPreview }), "preview_failed");
  refused(decide({ review: undefined }), "preview_failed");
  const noSummary = review();
  delete noSummary.summary;
  refused(decide({ review: noSummary }), "preview_failed");
});

// ---------------------------------------------------------------- never: any warning shows

test("never: when the agent's note names a different amount than the simulation (the demo scam)", () => {
  // Says 0.001 SOL, sends 0.01 SOL.
  refused(decide({ review: review({ note: "tiny 0.001 SOL test payment" }) }), "warnings");
});

test("never: when the note's amount matches there is no warning, so it can be approved", () => {
  assert.equal(decide({ review: review({ note: "pay 0.01 SOL for the report" }) }).auto, true);
});

test("never: when a program is not recognised", () => {
  const unknown = review({ programs: [{ id: SYSTEM, name: "System Program" }, { id: STRANGER, name: null }] });
  refused(decide({ review: unknown }), "warnings");
});

test("never: when other signers are involved", () => {
  refused(decide({ review: review({ refreshable: false }) }), "warnings");
});

test("never: a caller cannot hide a warning by editing the review's own fields", () => {
  const sneaky = review({ note: "0.001 SOL" });
  sneaky.headline = "Send 0.001 SOL";
  sneaky.warnings = [];
  sneaky.risky = false;
  refused(decide({ review: sneaky }), "warnings");
});

// ---------------------------------------------------------------- never: not a plain SOL transfer

test("never: more than one instruction (a hidden second step)", () => {
  refused(decide({ review: review({ instructionCount: 2 }) }), "not_plain");
  refused(
    decide({
      review: review({
        instructionCount: 2,
        transfers: [
          { from: WALLET, to: FRIEND, lamports: 1_000_000 },
          { from: WALLET, to: FRIEND, lamports: 1_000_000 },
        ],
      }),
    }),
    "not_plain",
  );
});

test("never: a program other than the System Program, even a known one", () => {
  const memo = review({ programs: [{ id: MEMO, name: "Memo" }] });
  refused(decide({ review: memo }), "not_plain");
  const both = review({ programs: [{ id: SYSTEM, name: "System Program" }, { id: MEMO, name: "Memo" }] });
  refused(decide({ review: both }), "not_plain");
});

test("never: a System Program instruction that is not a SOL transfer", () => {
  // e.g. creating or assigning an account: the summary finds no transfer in it.
  refused(decide({ review: review({ transfers: [] }) }), "not_plain");
});

test("never: lookup tables, or more than one signer", () => {
  refused(decide({ review: review({ usesLookupTables: true }) }), "not_plain");
  refused(decide({ review: review({ signerCount: 2 }) }), "not_plain");
  const one = review();
  one.summary.signerCount = 2;
  refused(decide({ review: one }), "not_plain");
});

test("never: a transfer that does not come from this wallet, or goes to it", () => {
  refused(decide({ review: review({ from: STRANGER }) }), "not_plain");
  refused(decide({ review: review({ to: WALLET }), knownAddresses: [WALLET] }), "not_plain");
});

test("never: a recipient that is not a valid address", () => {
  const odd = "not-an-address";
  refused(decide({ review: review({ to: odd }), knownAddresses: [odd] }), "not_plain");
});

test("never: an amount that is zero or not a whole number of lamports", () => {
  for (const lamports of [0, -5, 1.5, NaN]) {
    refused(decide({ review: review({ lamports, delta: -FEE }) }), "not_plain");
  }
});

test("never: without the wallet's address", () => {
  refused(decide({ walletAddress: "" }), "not_plain");
  refused(decide({ walletAddress: undefined }), "not_plain");
});

// ---------------------------------------------------------------- never: the money does not add up

test("never: when more leaves the wallet than the transfer plus its fee", () => {
  refused(decide({ review: review({ lamports: 10_000_000, delta: -10_005_001 }) }), "amounts");
  refused(decide({ review: review({ lamports: 10_000_000, delta: -20_000_000 }) }), "amounts");
});

test("never: when less than the transfer leaves, or SOL arrives", () => {
  refused(decide({ review: review({ lamports: 10_000_000, delta: -9_999_999 }) }), "amounts");
  refused(decide({ review: review({ lamports: 10_000_000, delta: 5_000 }) }), "amounts");
  refused(decide({ review: review({ lamports: 10_000_000, delta: 0 }) }), "amounts");
});

test("never: when the fee is unknown", () => {
  const unknownFee = review();
  unknownFee.preview.feeLamports = null;
  refused(decide({ review: unknownFee }), "amounts");
  const negativeFee = review();
  negativeFee.preview.feeLamports = -1;
  refused(decide({ review: negativeFee }), "amounts");
});

test("auto: the wallet may pay less than the estimated fee, never more", () => {
  assert.equal(decide({ review: review({ lamports: 10_000_000, delta: -10_000_000 }) }).auto, true);
  assert.equal(decide({ review: review({ lamports: 10_000_000, delta: -10_005_000 }) }).auto, true);
});

// ---------------------------------------------------------------- never: first payment to an address

test("never: to an address that was not approved by hand before", () => {
  refused(decide({ review: review({ to: STRANGER }) }), "unknown_recipient");
  refused(decide({ knownAddresses: [] }), "unknown_recipient");
  refused(decide({ knownAddresses: undefined }), "unknown_recipient");
});

test("never: an address that only looks like a known one (different case or one character off)", () => {
  const flipped = FRIEND.slice(0, -1) + (FRIEND.endsWith("a") ? "b" : "a");
  refused(decide({ knownAddresses: [flipped] }), "unknown_recipient");
  refused(decide({ knownAddresses: [FRIEND.toLowerCase() === FRIEND ? FRIEND.toUpperCase() : FRIEND.toLowerCase()] }), "unknown_recipient");
});

// ---------------------------------------------------------------- the order of the checks

test("the reason shown is the first rule that failed", () => {
  const bad = { review: review({ lamports: 90_000_000, to: STRANGER, note: "0.001 SOL" }), paused: false, appActive: true };
  refused(decide(bad), "warnings");
  refused(decide({ ...bad, paused: true }), "paused");
  refused(decide({ ...bad, settings: { enabled: false, limitLamports: 1 } }), "off");
});

// ---------------------------------------------------------------- learning an address

const approvedOutcome = { status: "approved", signature: "sig1", reported: true };

test("learn: an address is trusted after a plain payment approved by hand and sent", () => {
  assert.equal(addressToLearn({ review: review(), outcome: approvedOutcome, walletAddress: WALLET }), FRIEND);
});

test("learn: not from a denied, failed or unsent request", () => {
  for (const outcome of [{ status: "denied" }, { status: "failed", signature: "sig" }, { status: "approved" }, { status: "approved", signature: "" }, undefined]) {
    assert.equal(addressToLearn({ review: review(), outcome, walletAddress: WALLET }), null, JSON.stringify(outcome));
  }
});

test("learn: not from a payment that showed a warning, even if the person sent it anyway", () => {
  assert.equal(addressToLearn({ review: review({ note: "0.001 SOL" }), outcome: approvedOutcome, walletAddress: WALLET }), null);
  assert.equal(addressToLearn({ review: review({ programs: [{ id: STRANGER, name: null }] }), outcome: approvedOutcome, walletAddress: WALLET }), null);
});

test("learn: not from a payment that was not plain, or whose preview failed", () => {
  assert.equal(addressToLearn({ review: review({ instructionCount: 2 }), outcome: approvedOutcome, walletAddress: WALLET }), null);
  assert.equal(addressToLearn({ review: review({ ok: false }), outcome: approvedOutcome, walletAddress: WALLET }), null);
  assert.equal(addressToLearn({ review: undefined, outcome: approvedOutcome, walletAddress: WALLET }), null);
});

test("known addresses: newest first, no duplicates, capped, junk refused", () => {
  const a = Keypair.generate().publicKey.toBase58();
  const b = Keypair.generate().publicKey.toBase58();
  assert.deepEqual(addKnownAddress(addKnownAddress([], a), b), [b, a]);
  assert.deepEqual(addKnownAddress([a, b], a), [a, b]);
  assert.deepEqual(addKnownAddress([a], "junk"), [a]);
  assert.deepEqual(addKnownAddress([a], undefined), [a]);
  let many = [];
  for (let i = 0; i < 210; i += 1) many = addKnownAddress(many, Keypair.generate().publicKey.toBase58());
  assert.equal(many.length, 200);
  assert.deepEqual(removeKnownAddress([a, b], a), [b]);
  assert.deepEqual(removeKnownAddress([a, b], "other"), [a, b]);
});

// ---------------------------------------------------------------- what counts as spent

test("ledger: a sent payment counts its full outflow, fee included", () => {
  const entry = ledgerEntryFor({ id: "r1", review: review({ lamports: 10_000_000 }), outcome: approvedOutcome, now: NOW });
  assert.deepEqual(entry, { id: "r1", at: NOW, lamports: 10_005_000 });
});

test("ledger: a payment that never reached the wallet's signature counts nothing", () => {
  assert.equal(ledgerEntryFor({ id: "r1", review: review(), outcome: { status: "failed", reason: "x" }, now: NOW }), null);
  assert.equal(ledgerEntryFor({ id: "r1", review: review(), outcome: { status: "denied" }, now: NOW }), null);
  assert.equal(ledgerEntryFor({ id: "r1", review: review(), outcome: undefined, now: NOW }), null);
});

test("ledger: signed but the network call broke counts in full, because the money may have moved", () => {
  const entry = ledgerEntryFor({ id: "r1", review: review({ lamports: 10_000_000 }), outcome: { status: "failed" }, now: NOW, maybeSent: true });
  assert.equal(entry.lamports, 10_005_000);
});

test("ledger: sent but failed on chain counts only the fee", () => {
  const entry = ledgerEntryFor({
    id: "r1",
    review: review({ lamports: 10_000_000, fee: 5_000 }),
    outcome: { status: "failed", signature: "sig", failedOnChain: true },
    now: NOW,
  });
  assert.equal(entry.lamports, 5_000);
});

test("ledger: sent but not confirmed in time counts in full (it may still land)", () => {
  const entry = ledgerEntryFor({ id: "r1", review: review({ lamports: 10_000_000 }), outcome: { status: "failed", signature: "sig" }, now: NOW });
  assert.equal(entry.lamports, 10_005_000);
});

// ---------------------------------------------------------------- saved state

test("saved state: round trip", () => {
  const stored = { settings: { ...SETTINGS, tokenLimits: {} }, known: [FRIEND], ledger: [{ id: "a", at: NOW, lamports: 5 }] };
  assert.deepEqual(parseStored(JSON.stringify(stored)), stored);
});

test("saved state: damaged storage means off, nothing known, nothing spent", () => {
  const empty = { settings: { enabled: false, limitLamports: 0, tokenLimits: {} }, known: [], ledger: [] };
  for (const text of ["", "not json", "null", "[]", "42", '"x"', undefined]) {
    assert.deepEqual(parseStored(text), empty, String(text));
  }
});

test("saved state: bad pieces are dropped, good ones kept", () => {
  const parsed = parseStored(
    JSON.stringify({
      settings: { enabled: true, limitLamports: -5 },
      known: [FRIEND, "junk", 5, null],
      ledger: [{ id: "a", at: NOW, lamports: 5 }, { id: 7, at: NOW, lamports: 5 }, { id: "b", at: "x", lamports: 5 }, { id: "c", at: NOW, lamports: -1 }],
    }),
  );
  assert.deepEqual(parsed.settings, { enabled: false, limitLamports: 0, tokenLimits: {} });
  assert.deepEqual(parsed.known, [FRIEND]);
  assert.deepEqual(parsed.ledger, [{ id: "a", at: NOW, lamports: 5 }]);
  // A limit above the largest allowed one is not trusted.
  assert.equal(parseStored(JSON.stringify({ settings: { enabled: true, limitLamports: MAX_LIMIT_LAMPORTS + 1 } })).settings.enabled, false);
  // "enabled" must be exactly true.
  assert.equal(parseStored(JSON.stringify({ settings: { enabled: "yes", limitLamports: 5 } })).settings.enabled, false);
});

// ---------------------------------------------------------------- the wallet step

function fakeRelay() {
  const sent = [];
  return { sent, sendResult: async (id, result) => void sent.push({ id, result }) };
}

function fakeChain({ confirm = { confirmed: true }, blockhashError } = {}) {
  return {
    network: "devnet",
    verifyNetwork: async () => true,
    getLatestBlockhash: async () => {
      if (blockhashError) throw blockhashError;
      return { blockhash: Keypair.generate().publicKey.toBase58(), slot: 1 };
    },
    confirm: async () => confirm,
  };
}

const REQUEST = { id: "req1", payload: { type: "transfer", to: FRIEND, lamports: 10_000_000, note: "", agent: "bot", network: "devnet" } };

test("wallet step: approved automatically, reported like any approval, marked auto on the phone only", async () => {
  const relay = fakeRelay();
  const outcome = await submitAutoApproval({ request: REQUEST, walletAddress: WALLET, chain: fakeChain(), relay, signAndSend: async () => "SIG1" });
  assert.equal(outcome.status, "approved");
  assert.equal(outcome.signature, "SIG1");
  assert.equal(outcome.auto, true);
  assert.equal(relay.sent.length, 1);
  assert.deepEqual(Object.keys(relay.sent[0].result).sort(), ["refreshed", "signature", "status"], "the agent is not told how it was approved");
});

test("wallet step: a wallet that needs a prompt or a new login gives the card, and the relay hears nothing", async () => {
  const relay = fakeRelay();
  const outcome = await submitAutoApproval({
    request: REQUEST,
    walletAddress: WALLET,
    chain: fakeChain(),
    relay,
    signAndSend: async () => {
      throw new NeedsCardError("authorization request failed");
    },
  });
  assert.equal(outcome.status, "needs_card");
  assert.match(outcome.reason, /authorization/);
  assert.equal(outcome.reported, false);
  assert.equal(relay.sent.length, 0, "the request stays pending for the card");
});

test("wallet step: a failure before the wallet was even asked also gives the card", async () => {
  const relay = fakeRelay();
  const chain = fakeChain({ blockhashError: new Error("network down") });
  let asked = false;
  const outcome = await submitAutoApproval({ request: REQUEST, walletAddress: WALLET, chain, relay, signAndSend: async () => void (asked = true) });
  assert.equal(outcome.status, "needs_card");
  assert.equal(asked, false);
  assert.equal(relay.sent.length, 0);
});

test("wallet step: a failure after the wallet signed is reported, never offered again as a card", async () => {
  const relay = fakeRelay();
  const outcome = await submitAutoApproval({
    request: REQUEST,
    walletAddress: WALLET,
    chain: fakeChain(),
    relay,
    signAndSend: async () => {
      throw new Error("socket hang up");
    },
  });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.auto, true);
  assert.equal(relay.sent.length, 1);
  assert.equal(relay.sent[0].result.status, "failed");
});

test("wallet step: sent but failed on chain is marked, and the marked field never reaches the relay", async () => {
  const relay = fakeRelay();
  const outcome = await submitAutoApproval({
    request: REQUEST,
    walletAddress: WALLET,
    chain: fakeChain({ confirm: { confirmed: false, err: { InstructionError: [0, "Custom"] } } }),
    relay,
    signAndSend: async () => "SIG2",
  });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.signature, "SIG2");
  assert.equal(outcome.failedOnChain, true);
  assert.equal("failedOnChain" in relay.sent[0].result, false);
});

test("wallet step: not confirmed in time is not called a failure on chain", async () => {
  const relay = fakeRelay();
  const outcome = await submitAutoApproval({
    request: REQUEST,
    walletAddress: WALLET,
    chain: fakeChain({ confirm: { confirmed: false, err: "timeout" } }),
    relay,
    signAndSend: async () => "SIG3",
  });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.failedOnChain, undefined);
});

test("wallet step: the normal card path still behaves as before", async () => {
  const relay = fakeRelay();
  const outcome = await submitApproval({ request: REQUEST, walletAddress: WALLET, chain: fakeChain(), relay, signAndSend: async () => "SIG4" });
  assert.equal(outcome.status, "approved");
  assert.equal(outcome.auto, undefined);
  const failed = await submitApproval({ request: REQUEST, walletAddress: WALLET, chain: fakeChain(), relay: fakeRelay(), signAndSend: async () => { throw new Error("x"); } });
  assert.equal(failed.status, "failed");
});

// ---------------------------------------------------------------- real reviews

let rpc;
let connection;
let chain;
let wallet;
let walletAddress;

before(async () => {
  rpc = createLocalRpc({ port: 0 });
  const { url } = await rpc.listen();
  connection = new Connection(url, "confirmed");
  chain = rpcChain(connection, "devnet");
  wallet = Keypair.generate();
  walletAddress = wallet.publicKey.toBase58();
  rpc.airdrop(wallet.publicKey, 2 * SOL);
});

after(async () => {
  await rpc.close();
});

async function rawPayload(instructions, note = "") {
  const { blockhash } = await connection.getLatestBlockhash();
  const message = new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: blockhash, instructions }).compileToLegacyMessage();
  const tx = new VersionedTransaction(message);
  return { type: "raw", transactionBase64: Buffer.from(tx.serialize()).toString("base64"), note, agent: "bot", network: "devnet" };
}

async function realDecision(payload, overrides = {}) {
  const real = await reviewRequest({ payload, walletAddress, chain });
  return decideAutoApprove({
    review: real,
    settings: { enabled: true, limitLamports: 100_000_000 },
    walletAddress,
    knownAddresses: [FRIEND],
    ledger: [],
    now: NOW,
    paused: false,
    appActive: true,
    ...overrides,
  });
}

test("real review: a plain transfer request to a known address is approved, fee included in what it counts", async () => {
  const result = await realDecision({ type: "transfer", to: FRIEND, lamports: 20_000_000, note: "rent", agent: "bot", network: "devnet" });
  assert.equal(result.auto, true);
  assert.equal(result.outflowLamports, 20_005_000);
});

test("real review: a plain transfer sent as a raw transaction is approved too", async () => {
  const payload = await rawPayload([SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: new PublicKey(FRIEND), lamports: 20_000_000 })]);
  assert.equal((await realDecision(payload)).auto, true);
});

test("real review: a raw transaction with an extra instruction (priority fee) asks every time", async () => {
  const payload = await rawPayload([
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: new PublicKey(FRIEND), lamports: 20_000_000 }),
  ]);
  refused(await realDecision(payload), "not_plain");
});

test("real review: two transfers in one transaction ask every time, even to known addresses", async () => {
  const to = new PublicKey(FRIEND);
  const payload = await rawPayload([
    SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: to, lamports: 1_000_000 }),
    SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: to, lamports: 1_000_000 }),
  ]);
  refused(await realDecision(payload), "not_plain");
});

test("real review: a note that understates the amount shows a warning, so it asks", async () => {
  const result = await realDecision({ type: "transfer", to: FRIEND, lamports: 30_000_000, note: "tiny 0.001 SOL test payment", agent: "bot", network: "devnet" });
  refused(result, "warnings");
});

test("real review: a transfer the wallet cannot afford fails the preview, so it asks", async () => {
  const poor = Keypair.generate();
  const real = await reviewRequest({
    payload: { type: "transfer", to: FRIEND, lamports: 20_000_000, note: "", agent: "bot", network: "devnet" },
    walletAddress: poor.publicKey.toBase58(),
    chain,
  });
  refused(
    decideAutoApprove({
      review: real,
      settings: { enabled: true, limitLamports: 100_000_000 },
      walletAddress: poor.publicKey.toBase58(),
      knownAddresses: [FRIEND],
      ledger: [],
      now: NOW,
      paused: false,
      appActive: true,
    }),
    "preview_failed",
  );
});

test("real review: a stranger asks the first time", async () => {
  refused(await realDecision({ type: "transfer", to: STRANGER, lamports: 20_000_000, note: "", agent: "bot", network: "devnet" }), "unknown_recipient");
});

test("real review: plainSolTransfer reads the same facts the card shows", async () => {
  const real = await reviewRequest({ payload: { type: "transfer", to: FRIEND, lamports: 5, note: "", agent: "bot", network: "devnet" }, walletAddress, chain });
  assert.deepEqual(plainSolTransfer(real, walletAddress), { to: FRIEND, lamports: 5 });
  assert.equal(plainSolTransfer(real, STRANGER), null);
});
