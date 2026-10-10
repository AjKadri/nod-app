"use strict";
/**
 * What the approval card shows. These are pure functions over a Review, so the
 * tests build reviews by hand. The headline case is the demo moment: the agent
 * says "0.001 SOL" and the simulation says 0.030005 SOL leaves the wallet.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { presentReview, findAmountMismatch, claimedLamports } = require("../shared/present");

const SYSTEM = "11111111111111111111111111111111";
const SOL = 1_000_000_000;

function review({ note = "", delta = -30_005_000, fee = 5_000, ok = true, programs, transfers, refreshable = true, type = "transfer", error = null } = {}) {
  return {
    request: { type, note, agent: "Research agent" },
    summary: {
      programs: programs || [{ id: SYSTEM, name: "System Program" }],
      transfers: transfers || [{ from: "Wallet", to: "8kQpAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3vLm", lamports: 30_000_000 }],
      instructionCount: 1,
      signerCount: 1,
      usesLookupTables: false,
      unknownPrograms: (programs || []).filter((p) => !p.name).map((p) => p.id),
    },
    preview: {
      ok,
      preLamports: 1 * SOL,
      postLamports: ok ? 1 * SOL + delta : null,
      deltaLamports: ok ? delta : null,
      feeLamports: fee,
      error,
      logs: [],
    },
    headline: "",
    refreshable,
    signerCount: 1,
  };
}

test("the note's SOL amounts are read in lamports", () => {
  assert.deepEqual(claimedLamports("tiny 0.001 SOL test payment"), [1_000_000]);
  assert.deepEqual(claimedLamports("send 2 sol, then 0,5 SOL"), [2 * SOL, 500_000_000]);
  assert.deepEqual(claimedLamports("pay for the report"), []);
  assert.deepEqual(claimedLamports(undefined), []);
});

test("the amount on the card is what the simulation says leaves the wallet, not what the note says", () => {
  const shown = presentReview(review({ note: "tiny 0.001 SOL test payment" }));
  assert.equal(shown.amount, "0.030005");
  assert.equal(shown.unit, "SOL");
  assert.equal(shown.direction, "send");
  assert.equal(shown.mismatch.message, "The agent said 0.001 SOL. This sends 0.030005 SOL.");
  assert.equal(shown.warnings[0].level, "danger");
  assert.equal(shown.warnings[0].text, shown.mismatch.message);
});

test("the agent's note is kept as a claim and used as the headline", () => {
  const shown = presentReview(review({ note: "Pay for your research report" }));
  assert.equal(shown.agentClaim, "Pay for your research report");
  assert.equal(shown.headline, "Pay for your research report");
  assert.equal(shown.mismatch, null);
});

test("without a note the headline is plain and there is no claim", () => {
  assert.equal(presentReview(review({ note: "" })).headline, "Send SOL");
  assert.equal(presentReview(review({ note: "" })).agentClaim, null);
  const call = presentReview(review({ note: "", type: "raw", transfers: [], programs: [{ id: "Prog111", name: null }] }));
  assert.equal(call.headline, "Approve a transaction");
});

test("a note that matches the simulation, fee included, raises no warning", () => {
  assert.equal(presentReview(review({ note: "send 0.03 SOL" })).mismatch, null);
  assert.equal(presentReview(review({ note: "send 0.030005 SOL" })).mismatch, null);
});

test("a note that names several amounts is fine if one of them matches", () => {
  assert.equal(findAmountMismatch("0.03 SOL now, 5 SOL never", review()), null);
});

test("a note with no amount, or a failed simulation, never claims a mismatch", () => {
  assert.equal(findAmountMismatch("pay the invoice", review()), null);
  assert.equal(findAmountMismatch("0.001 SOL", review({ ok: false, error: "boom" })), null);
});

test("a failed simulation is shown in the preview row with a danger warning, and the amount is unknown", () => {
  const shown = presentReview(review({ ok: false, error: "InsufficientFundsForRent" }));
  assert.equal(shown.amount, null);
  assert.equal(shown.direction, "unknown");
  assert.equal(shown.previewOk, false);
  assert.match(shown.previewText, /InsufficientFundsForRent/);
  assert.ok(shown.warnings.some((w) => w.level === "danger" && /fail|checked/.test(w.text)));
});

test("incoming money is labelled as received, no change as none", () => {
  assert.equal(presentReview(review({ delta: 2 * SOL })).direction, "receive");
  assert.equal(presentReview(review({ delta: 2 * SOL })).amount, "2");
  assert.equal(presentReview(review({ delta: 0 })).direction, "none");
});

test("unknown programs and other signers warn; a plain transfer warns about nothing", () => {
  assert.equal(presentReview(review()).warnings.length, 0);
  const odd = presentReview(review({ type: "raw", transfers: [], programs: [{ id: "Prog111", name: null }] }));
  assert.ok(odd.warnings.some((w) => /1 program this app does not recognise/.test(w.text)));
  assert.equal(odd.action, "Program call");
  const shared = presentReview(review({ refreshable: false }));
  assert.deepEqual(shared.warnings.map((w) => w.level), ["warn"]);
});

test("the details panel facts: recipient, action and fee", () => {
  const shown = presentReview(review());
  assert.equal(shown.action, "SOL transfer");
  assert.deepEqual(shown.recipient, { kind: "address", value: "8kQpAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3vLm" });
  assert.equal(shown.fee, "Est. 0.000005 SOL");
  assert.equal(shown.previewText, "Simulation completed");

  const token = presentReview(
    review({ type: "raw", transfers: [], programs: [{ id: "Tokenkeg", name: "Token Program" }] }),
  );
  assert.equal(token.action, "Token transaction");
  assert.deepEqual(token.recipient, { kind: "text", value: "Token Program" });

  const many = presentReview(
    review({ transfers: [{ from: "a", to: "b", lamports: 1 }, { from: "a", to: "c", lamports: 2 }] }),
  );
  assert.deepEqual(many.recipient, { kind: "text", value: "2 recipients" });
});

test("risky is true for red warnings only: mismatch, failed preview, unknown program", () => {
  assert.equal(presentReview(review()).risky, false);
  assert.equal(presentReview(review({ note: "tiny 0.001 SOL test payment" })).risky, true);
  assert.equal(presentReview(review({ ok: false, error: "boom" })).risky, true);
  const odd = presentReview(review({ type: "raw", transfers: [], programs: [{ id: "Prog111", name: null }] }));
  assert.equal(odd.risky, true);
  // Other signers is an amber warning: still a normal approval.
  assert.equal(presentReview(review({ refreshable: false })).risky, false);
});

test("demo mode sample data covers every state and uses the real presenter", () => {
  const { demoRequests, demoHistory } = require("../shared/demo");
  const [normal, risky, coder] = demoRequests();
  assert.equal(normal.presented.amount, "0.002005");
  assert.equal(normal.presented.risky, false);
  assert.equal(risky.note, "tiny 0.001 SOL test payment");
  assert.equal(risky.presented.amount, "0.030005");
  assert.equal(risky.presented.risky, true);
  assert.equal(risky.presented.mismatch.message, "The agent said 0.001 SOL. This sends 0.030005 SOL.");
  // Three different agents are waiting, each with its own name and icon.
  assert.deepEqual([normal, risky, coder].map((r) => r.agent), ["Research agent", "Trading agent", "Claude Code"]);
  assert.equal(new Set([normal, risky, coder].map((r) => r.agentIcon)).size, 3);
  assert.deepEqual(demoHistory().map((h) => h.status), ["approved", "rejected", "failed", "approved", "rejected"]);
  // Every icon in the sample data is one the phone will accept.
  const { cleanAgentIcon } = require("../shared/agent");
  for (const sample of [...demoRequests(), ...demoHistory()]) assert.ok(cleanAgentIcon(sample.agentIcon), sample.id);
  // Older history is dated by calendar day, not by seconds, so it falls in Yesterday and Earlier at any hour.
  assert.deepEqual(demoHistory().filter((h) => h.daysAgo).map((h) => h.daysAgo), [1, 3]);
  assert.deepEqual(demoHistory().filter((h) => h.auto).map((h) => h.id), ["demo-done-approved"]);
  assert.ok(demoHistory().find((h) => h.status === "failed").reason);
  const ids = [...demoRequests(), ...demoHistory()].map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
});
