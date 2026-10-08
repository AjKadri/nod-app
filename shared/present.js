"use strict";
/**
 * Turns a Review (from reviewRequest) into the plain facts the approval card
 * shows. Pure functions, no React: the phone app and the tests use the same code.
 *
 * Rule: amounts, recipients and warnings come from the simulated review only.
 * The agent's note is returned separately as the agent's claim. The one place
 * the note is read is to catch a claim that disagrees with the simulation.
 */
const { LAMPORTS_PER_SOL, formatSol } = require("./approval");

/** Lamports as a plain decimal string without the unit, e.g. 30005000 -> "0.030005". */
function formatAmount(lamports) {
  return formatSol(Math.abs(lamports)).replace(/ SOL$/, "");
}

/** Every "<number> SOL" amount the note mentions, in lamports. */
function claimedLamports(note) {
  if (typeof note !== "string") return [];
  const found = [];
  const pattern = /(\d+(?:[.,]\d+)?|[.,]\d+)\s*SOL\b/gi;
  let match;
  while ((match = pattern.exec(note)) !== null) {
    const value = parseFloat(match[1].replace(",", "."));
    if (Number.isFinite(value)) found.push(Math.round(value * LAMPORTS_PER_SOL));
  }
  return found;
}

/**
 * If the note names a SOL amount and none of the amounts it names is close to
 * what the simulation says leaves the wallet, return both. Otherwise null.
 * "Close" means within the network fee, which the simulation includes.
 */
function findAmountMismatch(note, review) {
  const preview = review && review.preview;
  if (!preview || !preview.ok || typeof preview.deltaLamports !== "number" || preview.deltaLamports >= 0) {
    return null;
  }
  const claims = claimedLamports(note);
  if (claims.length === 0) return null;
  const actual = -preview.deltaLamports;
  const tolerance = (typeof preview.feeLamports === "number" ? preview.feeLamports : 10_000) + 1_000;
  if (claims.some((said) => Math.abs(said - actual) <= tolerance)) return null;
  return { saidLamports: claims[0], actualLamports: actual };
}

function actionLabel(review) {
  const { summary } = review;
  const names = summary.programs.map((program) => program.name || "");
  if (summary.transfers.length > 0 && summary.unknownPrograms.length === 0 && !names.some((n) => /token/i.test(n))) {
    return "SOL transfer";
  }
  if (names.some((name) => /token/i.test(name))) return "Token transaction";
  return "Program call";
}

function recipientLabel(review) {
  const { transfers, programs } = review.summary;
  if (transfers.length === 1) return { kind: "address", value: transfers[0].to };
  if (transfers.length > 1) return { kind: "text", value: `${transfers.length} recipients` };
  const main = programs.find((program) => program.name && !/^(System|Compute Budget)/.test(program.name));
  if (main) return { kind: "text", value: main.name };
  return { kind: "text", value: "Not shown" };
}

/**
 * @returns {{
 *   headline: string, agentClaim: string | null,
 *   amount: string | null, unit: string, direction: "send" | "receive" | "none" | "unknown",
 *   action: string, recipient: { kind: "address" | "text", value: string },
 *   fee: string, previewOk: boolean, previewText: string,
 *   mismatch: { said: string, actual: string, message: string } | null,
 *   warnings: { level: "danger" | "warn", text: string }[],
 *   programs: { id: string, name: string | null }[],
 *   transfers: { to: string, lamports: number | null }[],
 *   logs: string[],
 * }}
 */
function presentReview(review) {
  const { request, summary, preview } = review;
  const note = typeof request.note === "string" ? request.note.trim() : "";
  const isTransfer = request.type === "transfer" || (summary.transfers.length > 0 && summary.unknownPrograms.length === 0);

  let amount = null;
  let direction = "unknown";
  if (preview.ok && typeof preview.deltaLamports === "number") {
    if (preview.deltaLamports < 0) {
      direction = "send";
      amount = formatAmount(preview.deltaLamports);
    } else if (preview.deltaLamports > 0) {
      direction = "receive";
      amount = formatAmount(preview.deltaLamports);
    } else {
      direction = "none";
      amount = "0";
    }
  }

  const mismatchRaw = findAmountMismatch(note, review);
  const mismatch = mismatchRaw
    ? {
        said: formatSol(mismatchRaw.saidLamports),
        actual: formatSol(mismatchRaw.actualLamports),
        message: `The agent said ${formatSol(mismatchRaw.saidLamports)}. This sends ${formatSol(mismatchRaw.actualLamports)}.`,
      }
    : null;

  const warnings = [];
  if (mismatch) warnings.push({ level: "danger", text: mismatch.message });
  if (!preview.ok) {
    warnings.push({ level: "danger", text: "This transaction would fail or could not be checked." });
  }
  if (summary.unknownPrograms.length > 0) {
    const count = summary.unknownPrograms.length;
    warnings.push({
      level: "danger",
      text: `Calls ${count} program${count === 1 ? "" : "s"} this app does not recognise.`,
    });
  }
  if (!review.refreshable) {
    warnings.push({ level: "warn", text: "Other signers are involved, so approve soon or it will expire." });
  }

  return {
    headline: note || (isTransfer ? "Send SOL" : "Approve a transaction"),
    agentClaim: note || null,
    amount,
    unit: "SOL",
    direction,
    action: actionLabel(review),
    recipient: recipientLabel(review),
    fee: typeof preview.feeLamports === "number" ? `Est. ${formatSol(preview.feeLamports)}` : "Unknown",
    previewOk: preview.ok,
    previewText: preview.ok ? "Simulation completed" : `Failed: ${preview.error || "unknown error"}`,
    mismatch,
    warnings,
    programs: summary.programs,
    transfers: summary.transfers.map((t) => ({ to: t.to, lamports: t.lamports })),
    logs: preview.logs || [],
  };
}

module.exports = { presentReview, findAmountMismatch, claimedLamports, formatAmount };
