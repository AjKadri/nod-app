"use strict";
/**
 * Sample data for Nod's demo mode: every card state without a wallet, a laptop
 * or a relay. The reviews go through the same presentReview() the real cards
 * use, so the demo screens are the real screens. Nothing here is signed or sent.
 */
const { presentReview } = require("./present");

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
// A made-up address, not a real wallet.
const SAMPLE_RECIPIENT = "8kQpV4Jq2mTnR7xYb9sLzC3dWfH6uEaN5gKtP1rD3vLm";
const FEE = 5_000;

function sampleReview({ note, agent, transferLamports }) {
  return {
    request: { type: "transfer", note, agent },
    summary: {
      programs: [{ id: SYSTEM_PROGRAM, name: "System Program" }],
      transfers: [{ from: "Your wallet", to: SAMPLE_RECIPIENT, lamports: transferLamports }],
      instructionCount: 1,
      signerCount: 1,
      usesLookupTables: false,
      unknownPrograms: [],
    },
    preview: {
      ok: true,
      preLamports: 5_000_000_000,
      postLamports: 5_000_000_000 - transferLamports - FEE,
      deltaLamports: -(transferLamports + FEE),
      feeLamports: FEE,
      error: null,
      logs: [`Program ${SYSTEM_PROGRAM} invoke [1]`, `Program ${SYSTEM_PROGRAM} success`],
    },
    headline: "",
    refreshable: true,
    signerCount: 1,
  };
}

/**
 * Waiting requests from three different agents: a normal one, the demo moment (the note says
 * 0.001, it sends 0.030005), and a third so the inbox shows distinct names and icons.
 */
function demoRequests() {
  const make = (id, agent, agentIcon, note, transferLamports, ageSeconds) => {
    const presented = presentReview(sampleReview({ note, agent, transferLamports }));
    return { id, agent, agentIcon, note, ageSeconds, presented };
  };
  return [
    make("demo-normal", "Research agent", "search", "Pay for your research report", 2_000_000, 20),
    make("demo-risky", "Trading agent", "flash", "tiny 0.001 SOL test payment", 30_000_000, 75),
    make("demo-coder", "Claude Code", "code", "Buy 1 month of API credits", 4_000_000, 140),
  ];
}

/**
 * Finished items for the history list: one approved, one rejected and one failed today, then
 * older ones so the list shows its Yesterday and Earlier groups. Today's use `ageSeconds`;
 * older ones say which day (`daysAgo`) and what time, so they land in the right group at any hour.
 */
function demoHistory() {
  const amountOf = (note, agent, transferLamports) =>
    presentReview(sampleReview({ note, agent, transferLamports })).amount;
  return [
    {
      id: "demo-done-approved",
      agent: "Research agent",
      agentIcon: "search",
      note: "Pay for your research report",
      amount: amountOf("", "Research agent", 2_000_000),
      recipient: SAMPLE_RECIPIENT,
      status: "approved",
      auto: true,
      ageSeconds: 3_600,
    },
    {
      id: "demo-done-rejected",
      agent: "Trading agent",
      agentIcon: "flash",
      note: "tiny 0.001 SOL test payment",
      amount: amountOf("", "Trading agent", 30_000_000),
      recipient: SAMPLE_RECIPIENT,
      status: "rejected",
      ageSeconds: 7_200,
    },
    {
      id: "demo-done-failed",
      agent: "Research agent",
      agentIcon: "search",
      note: "Top up the compute account",
      amount: amountOf("", "Research agent", 6_000_000_000),
      recipient: SAMPLE_RECIPIENT,
      status: "failed",
      reason: "Not enough SOL in the wallet for this transaction.",
      ageSeconds: 18_000,
    },
    {
      id: "demo-yesterday",
      agent: "Claude Code",
      agentIcon: "code",
      note: "Pay the hosting invoice",
      amount: amountOf("", "Claude Code", 12_000_000),
      recipient: SAMPLE_RECIPIENT,
      status: "approved",
      daysAgo: 1,
      hour: 18,
      minute: 40,
    },
    {
      id: "demo-earlier",
      agent: "Cursor",
      agentIcon: "sparkles",
      note: "Top up the test wallet",
      amount: amountOf("", "Cursor", 50_000_000),
      recipient: SAMPLE_RECIPIENT,
      status: "rejected",
      daysAgo: 3,
      hour: 11,
      minute: 5,
    },
  ];
}

module.exports = { demoRequests, demoHistory, SAMPLE_RECIPIENT };
