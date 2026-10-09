"use strict";
/**
 * Auto-approve: when Nod may skip its own card for a small payment. Pure functions, no React and
 * no storage, so the phone and the tests run the same code.
 *
 * A request is auto-approved ONLY if every one of these holds. Any doubt means the card is shown:
 *
 *   1. The person turned auto-approve on and set a daily limit.
 *   2. "Pause everything" is off (and was not just switched on without the relay confirming).
 *   3. Nod is open on the screen: the wallet can only be reached by an app the person can see.
 *   4. The simulation succeeded and shows NO warning (no amount mismatch, no unknown program,
 *      no other signers). Warnings are recomputed here, never taken from the caller.
 *   5. It is a plain SOL transfer: exactly one instruction, the System Program, one transfer out
 *      of this wallet, one signer, no lookup tables.
 *   6. The money that leaves the wallet (from the simulation, network fee included) is the
 *      transfer plus at most the fee. Anything else leaving means it is not plain.
 *   7. The recipient is an address the person approved by hand before, with no warning showing.
 *   8. That money fits in what is left of today's limit. Today ends at local midnight.
 *
 * Today's limit is spent by every payment that left the wallet through Nod, approved by hand or
 * automatically, fee included. A payment counts as soon as it is sent, even if it did not confirm,
 * because the money may have moved.
 */
const { LAMPORTS_PER_SOL, formatSol } = require("./approval");
const { presentReview } = require("./present");

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const MAX_LIMIT_LAMPORTS = 100 * LAMPORTS_PER_SOL;
const MAX_KNOWN_ADDRESSES = 200;
const MAX_LEDGER_ENTRIES = 500;
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DEFAULT_FEE_LAMPORTS = 5_000;

const OFF = Object.freeze({ enabled: false, limitLamports: 0 });

// ------------------------------------------------------------------ amounts

/**
 * "0.05" or "0,05" -> lamports. Returns null for anything that is not a plain positive amount of
 * SOL with at most 9 decimals and not above the largest limit Nod allows.
 */
function parseSolToLamports(text) {
  if (typeof text !== "string") return null;
  const match = text.trim().match(/^(\d+)?(?:[.,](\d{1,9}))?$/);
  if (!match || (match[1] === undefined && match[2] === undefined)) return null;
  const whole = match[1] === undefined ? 0 : Number(match[1]);
  const fraction = match[2] === undefined ? 0 : Number(match[2].padEnd(9, "0"));
  if (!Number.isSafeInteger(whole)) return null;
  const lamports = whole * LAMPORTS_PER_SOL + fraction;
  if (!Number.isSafeInteger(lamports) || lamports <= 0 || lamports > MAX_LIMIT_LAMPORTS) return null;
  return lamports;
}

// ------------------------------------------------------------------ today

/** Midnight at the start of the phone's local day, in ms. */
function startOfLocalDay(now) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** What has left the wallet since local midnight. */
function spentToday(ledger, now) {
  const start = startOfLocalDay(now);
  return (Array.isArray(ledger) ? ledger : []).reduce(
    (sum, entry) => (entry && entry.at >= start && Number.isSafeInteger(entry.lamports) ? sum + entry.lamports : sum),
    0,
  );
}

/** What is left of today's limit, counting payments still in progress. Never below zero. */
function remainingLamports({ limitLamports, ledger, reservedLamports = 0, now }) {
  return Math.max(0, limitLamports - spentToday(ledger, now) - reservedLamports);
}

/** Keep yesterday and today only: older entries can no longer count. */
function pruneLedger(ledger, now) {
  const keepFrom = startOfLocalDay(now) - 24 * 60 * 60 * 1000;
  return (Array.isArray(ledger) ? ledger : []).filter((entry) => entry.at >= keepFrom).slice(-MAX_LEDGER_ENTRIES);
}

// ------------------------------------------------------------------ reading a review

/**
 * What leaves the wallet, fee included. From the simulation when there is one; otherwise the SOL
 * transfers plus the fee, as a best estimate for a payment the person approved by hand anyway.
 */
function outflowLamports(review) {
  const preview = review && review.preview;
  if (preview && preview.ok && Number.isSafeInteger(preview.deltaLamports) && preview.deltaLamports < 0) {
    return -preview.deltaLamports;
  }
  const transfers = (review && review.summary && review.summary.transfers) || [];
  const sent = transfers.reduce((sum, t) => sum + (Number.isSafeInteger(t.lamports) ? t.lamports : 0), 0);
  const fee = preview && Number.isSafeInteger(preview.feeLamports) ? preview.feeLamports : DEFAULT_FEE_LAMPORTS;
  return sent + fee;
}

/** The one transfer, if (and only if) this is a plain SOL transfer out of `walletAddress`. */
function plainSolTransfer(review, walletAddress) {
  const summary = review && review.summary;
  if (!summary || typeof walletAddress !== "string" || !walletAddress) return null;
  if (summary.instructionCount !== 1 || !Array.isArray(summary.transfers) || summary.transfers.length !== 1) return null;
  if (!Array.isArray(summary.programs) || summary.programs.length !== 1 || summary.programs[0].id !== SYSTEM_PROGRAM_ID) return null;
  if (!Array.isArray(summary.unknownPrograms) || summary.unknownPrograms.length !== 0) return null;
  if (summary.usesLookupTables || summary.signerCount !== 1 || review.signerCount !== 1) return null;
  const transfer = summary.transfers[0];
  if (transfer.from !== walletAddress || transfer.to === walletAddress) return null;
  if (typeof transfer.to !== "string" || !ADDRESS_RE.test(transfer.to)) return null;
  if (!Number.isSafeInteger(transfer.lamports) || transfer.lamports <= 0) return null;
  return { to: transfer.to, lamports: transfer.lamports };
}

// ------------------------------------------------------------------ the decision

/** True while sends must wait for a person: paused, or a pause the person asked for is unconfirmed. */
function isPausedForAuto({ pauseState, unconfirmedPause = false }) {
  return pauseState !== "off" || unconfirmedPause === true;
}

function isEnabled(settings) {
  return !!settings && settings.enabled === true && Number.isSafeInteger(settings.limitLamports) && settings.limitLamports > 0;
}

/**
 * @param review          from reviewRequest()
 * @param settings        { enabled, limitLamports }
 * @param walletAddress   this phone's wallet, base58
 * @param knownAddresses  addresses the person approved by hand
 * @param ledger          [{ id, at, lamports }] payments that left the wallet
 * @param reservedLamports money for payments started but not finished
 * @param paused          see isPausedForAuto()
 * @param appActive       Nod is on screen
 * @returns {{ auto: true, outflowLamports: number, to: string } | { auto: false, code: string, reason: string }}
 *   `code` is "off" when auto-approve is simply not in use: nothing is worth telling the person.
 */
function decideAutoApprove({
  review,
  settings,
  walletAddress,
  knownAddresses = [],
  ledger = [],
  reservedLamports = 0,
  now,
  paused,
  appActive,
}) {
  const no = (code, reason) => ({ auto: false, code, reason });

  if (!isEnabled(settings)) return no("off", "Auto-approve is off.");
  if (paused !== false) return no("paused", "Pause everything is on, so nothing is approved automatically.");
  if (appActive !== true) return no("background", "Nod was not open when this arrived, so it needs you.");
  if (!review || !review.preview || !review.summary || !review.request) return no("preview_failed", "This request could not be checked.");
  if (review.preview.ok !== true) return no("preview_failed", "The preview failed, so it needs you.");

  // Recomputed from the review itself: a caller cannot hide a warning from this check.
  if (presentReview(review).warnings.length > 0) return no("warnings", "There is a warning on this request, so it needs you.");

  const transfer = plainSolTransfer(review, walletAddress);
  if (!transfer) return no("not_plain", "Only plain SOL transfers are approved automatically.");

  const fee = review.preview.feeLamports;
  const outflow = Number.isSafeInteger(review.preview.deltaLamports) ? -review.preview.deltaLamports : NaN;
  if (!Number.isSafeInteger(fee) || fee < 0 || !(outflow >= transfer.lamports && outflow <= transfer.lamports + fee)) {
    return no("amounts", "The amounts do not add up, so it needs you.");
  }

  if (!Array.isArray(knownAddresses) || !knownAddresses.includes(transfer.to)) {
    return no("unknown_recipient", "First payment to this address: approve it yourself once.");
  }

  const remaining = remainingLamports({ limitLamports: settings.limitLamports, ledger, reservedLamports, now });
  if (outflow > remaining) {
    return no("over_limit", `Over what is left of today's limit (${formatSol(remaining)}), so it needs you.`);
  }
  return { auto: true, outflowLamports: outflow, to: transfer.to };
}

// ------------------------------------------------------------------ what to remember afterwards

/**
 * The address to trust from now on, or null. Only a payment the person approved by hand, that
 * went through, was a plain SOL transfer and showed no warning teaches Nod an address: approving
 * "Send anyway" over a warning is a one-off, not trust.
 */
function addressToLearn({ review, outcome, walletAddress }) {
  if (!outcome || outcome.status !== "approved" || !outcome.signature) return null;
  if (!review || !review.preview || review.preview.ok !== true) return null;
  if (presentReview(review).warnings.length > 0) return null;
  const transfer = plainSolTransfer(review, walletAddress);
  return transfer ? transfer.to : null;
}

/**
 * The ledger entry for a payment, or null if nothing left the wallet.
 * - Sent (it has a signature): the full outflow, fee included.
 * - Sent but failed on chain (outcome.failedOnChain): only the fee left.
 * - No signature but `maybeSent` (it was signed, then the network call broke): the full outflow,
 *   because the money may have moved. Counting too much only makes auto-approve stricter.
 */
function ledgerEntryFor({ id, review, outcome, now, maybeSent = false }) {
  const signed = !!outcome && typeof outcome.signature === "string" && outcome.signature.length > 0;
  if (!signed && maybeSent !== true) return null;
  if (signed && outcome.failedOnChain === true) {
    const fee = review && review.preview && Number.isSafeInteger(review.preview.feeLamports) ? review.preview.feeLamports : DEFAULT_FEE_LAMPORTS;
    return { id, at: now, lamports: fee };
  }
  return { id, at: now, lamports: outflowLamports(review) };
}

/** Add an address, newest first, no duplicates, at most 200. */
function addKnownAddress(known, address) {
  if (typeof address !== "string" || !ADDRESS_RE.test(address)) return Array.isArray(known) ? known : [];
  return [address, ...(Array.isArray(known) ? known : []).filter((other) => other !== address)].slice(0, MAX_KNOWN_ADDRESSES);
}

function removeKnownAddress(known, address) {
  return (Array.isArray(known) ? known : []).filter((other) => other !== address);
}

// ------------------------------------------------------------------ saved state

/**
 * Read what was saved. Anything that does not look right becomes "off, nothing known, nothing
 * spent" for that part: damaged or tampered storage can only make auto-approve stricter, except
 * that an emptied ledger forgets today's spending, which is why the phone also keeps the ledger
 * only on the device, never on the relay.
 */
function parseStored(text) {
  const empty = { settings: { ...OFF }, known: [], ledger: [] };
  let data;
  try {
    data = JSON.parse(text);
  } catch (_err) {
    return empty;
  }
  if (!data || typeof data !== "object") return empty;

  const settings = { ...OFF };
  const raw = data.settings;
  if (raw && Number.isSafeInteger(raw.limitLamports) && raw.limitLamports > 0 && raw.limitLamports <= MAX_LIMIT_LAMPORTS) {
    settings.limitLamports = raw.limitLamports;
    settings.enabled = raw.enabled === true;
  }
  const known = (Array.isArray(data.known) ? data.known : []).filter((a) => typeof a === "string" && ADDRESS_RE.test(a)).slice(0, MAX_KNOWN_ADDRESSES);
  const ledger = (Array.isArray(data.ledger) ? data.ledger : [])
    .filter((e) => e && typeof e.id === "string" && Number.isFinite(e.at) && Number.isSafeInteger(e.lamports) && e.lamports >= 0)
    .map((e) => ({ id: e.id.slice(0, 64), at: e.at, lamports: e.lamports }))
    .slice(-MAX_LEDGER_ENTRIES);
  return { settings, known, ledger };
}

module.exports = {
  MAX_LIMIT_LAMPORTS,
  MAX_KNOWN_ADDRESSES,
  parseSolToLamports,
  startOfLocalDay,
  spentToday,
  remainingLamports,
  pruneLedger,
  outflowLamports,
  plainSolTransfer,
  isPausedForAuto,
  isEnabled,
  decideAutoApprove,
  addressToLearn,
  ledgerEntryFor,
  addKnownAddress,
  removeKnownAddress,
  parseStored,
};
