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
 * Tokens follow the same rules with a limit per token (SOL and SKR): a plain token transfer is one
 * transfer instruction of one token program, one token leaving the wallet and the same amount
 * arriving at one recipient (from the simulation), no new token account to pay for, the network fee
 * as the only SOL cost, a recipient the person approved by hand, a token Nod names (an official mint,
 * never one that only claims a name), and an amount that fits what is left of today's limit for
 * that token. The fee of a token payment is recorded in the SOL ledger.
 *
 * Today's limit is spent by every payment that left the wallet through Nod, approved by hand or
 * automatically, fee included. A payment counts as soon as it is sent, even if it did not confirm,
 * because the money may have moved.
 */
const { LAMPORTS_PER_SOL, formatSol } = require("./approval");
const { presentReview } = require("./present");
const tokens = require("./tokens");

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const MAX_LIMIT_LAMPORTS = 100 * LAMPORTS_PER_SOL;
const MAX_KNOWN_ADDRESSES = 200;
const MAX_LEDGER_ENTRIES = 500;
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DEFAULT_FEE_LAMPORTS = 5_000;

const OFF = Object.freeze({ enabled: false, limitLamports: 0, tokenLimits: Object.freeze({}) });
const RAW_RE = /^\d{1,40}$/;
const LIMIT_TEXT_RE = /^\d{1,12}(?:\.\d{1,9})?$/;

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

/**
 * A token limit as typed ("100", "0,5") -> the normal text "100" / "0.5", or null if it is not a
 * plain positive amount (at most 12 whole digits and 9 decimals). It is turned into whole units of
 * the token only when it is used, with the decimals read from the token's mint.
 */
function normalizeTokenLimit(text) {
  if (typeof text !== "string") return null;
  const clean = text.trim().replace(",", ".");
  if (!LIMIT_TEXT_RE.test(clean)) return null;
  const [whole, fraction = ""] = clean.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  const normal = `${whole.replace(/^0+(?=\d)/, "")}${trimmed ? "." + trimmed : ""}`;
  return /[1-9]/.test(normal) ? normal : null;
}

/** The limit for one token in whole units, or null when none is set (or it does not fit the token). */
function tokenLimitRaw(settings, mint, decimals) {
  const text = settings && settings.tokenLimits && settings.tokenLimits[mint];
  return typeof text === "string" ? tokens.parseTokenAmount(text, decimals) : null;
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

/** What has left the wallet of one token since local midnight, in whole units of the token (BigInt). */
function spentTodayToken(ledger, mint, now) {
  const start = startOfLocalDay(now);
  let sum = 0n;
  for (const entry of Array.isArray(ledger) ? ledger : []) {
    if (!entry || !(entry.at >= start) || !Array.isArray(entry.tokens)) continue;
    for (const item of entry.tokens) {
      if (item && item.mint === mint && typeof item.raw === "string" && RAW_RE.test(item.raw)) sum += BigInt(item.raw);
    }
  }
  return sum;
}

/**
 * What is left of today's limit for one token, counting payments still in progress. Never below
 * zero. `reserved` is [{ mint, raw }] for payments started but not finished.
 */
function remainingToken({ limitRaw, ledger, reserved = [], mint, now }) {
  let held = 0n;
  for (const item of reserved) if (item && item.mint === mint && typeof item.raw === "string" && RAW_RE.test(item.raw)) held += BigInt(item.raw);
  const left = BigInt(limitRaw) - spentTodayToken(ledger, mint, now) - held;
  return left > 0n ? left : 0n;
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

/**
 * The token a review moves out of the wallet: { mint, raw (string), decimals }, or null when no token
 * leaves it. Read from the simulation only.
 */
function tokenOutflows(review) {
  const view = review && review.preview && review.preview.tokens;
  if (!view || !Array.isArray(view.changes)) return [];
  const out = [];
  for (const change of view.changes) {
    try {
      const delta = BigInt(change.deltaRaw);
      if (delta < 0n) out.push({ mint: change.mint, raw: (-delta).toString(), decimals: change.decimals });
    } catch (_err) {
      // an unreadable amount is not counted here; the review shows a warning for an incomplete view
    }
  }
  return out;
}

/**
 * If (and only if) this review is one token transfer out of `walletAddress`:
 * { mint, raw (string), decimals, to (the recipient's address, the owner of the receiving account),
 *   createsAccount }. With `allowCreate` false, anything that creates a token account is refused.
 */
function tokenTransfer(review, walletAddress, { allowCreate = false } = {}) {
  const summary = review && review.summary;
  const view = review && review.preview && review.preview.tokens;
  if (!summary || !view || typeof walletAddress !== "string" || !walletAddress) return null;
  if (!Array.isArray(summary.tokenInstructions) || !Array.isArray(summary.programs)) return null;
  if (summary.usesLookupTables || summary.signerCount !== 1 || review.signerCount !== 1) return null;
  if (!Array.isArray(summary.unknownPrograms) || summary.unknownPrograms.length !== 0) return null;
  if (Array.isArray(summary.tokenDangers) && summary.tokenDangers.length > 0) return null;
  if (Array.isArray(summary.transfers) && summary.transfers.length > 0) return null;

  const kinds = summary.tokenInstructions;
  const transfers = kinds.filter((kind) => kind === "transfer").length;
  const creates = kinds.filter((kind) => kind === "createAta").length;
  if (transfers !== 1 || kinds.length !== summary.instructionCount || kinds.length !== transfers + creates) return null;
  if (creates > 0 && !allowCreate) return null;
  if (creates > 1) return null;

  if (view.complete !== true || view.error || !Array.isArray(view.changes) || !Array.isArray(view.others) || !Array.isArray(view.created)) return null;
  if (Array.isArray(view.dangers) && view.dangers.length > 0) return null;
  if (!allowCreate && view.created.length !== 0) return null;
  if (view.changes.length !== 1 || view.others.length !== 1) return null;
  const sent = view.changes[0];
  const received = view.others[0];
  let out;
  let into;
  try {
    out = BigInt(sent.deltaRaw);
    into = BigInt(received.deltaRaw);
  } catch (_err) {
    return null;
  }
  // Exactly what leaves arrives: a token that skims a fee on the way is not "plain".
  if (out >= 0n || into !== -out || sent.mint !== received.mint) return null;
  if (typeof received.owner !== "string" || !ADDRESS_RE.test(received.owner) || received.owner === walletAddress) return null;
  if (!Number.isInteger(sent.decimals)) return null;
  return { mint: sent.mint, raw: (-out).toString(), decimals: sent.decimals, to: received.owner, createsAccount: creates > 0 };
}

// ------------------------------------------------------------------ the decision

/** True while sends must wait for a person: paused, or a pause the person asked for is unconfirmed. */
function isPausedForAuto({ pauseState, unconfirmedPause = false }) {
  return pauseState !== "off" || unconfirmedPause === true;
}

function hasTokenLimit(settings) {
  return !!settings && !!settings.tokenLimits && Object.keys(settings.tokenLimits).length > 0;
}

/** Auto-approve is in use: switched on, with a limit for SOL or for at least one token. */
function isEnabled(settings) {
  if (!settings || settings.enabled !== true) return false;
  return (Number.isSafeInteger(settings.limitLamports) && settings.limitLamports > 0) || hasTokenLimit(settings);
}

/**
 * @param review          from reviewRequest()
 * @param settings        { enabled, limitLamports }
 * @param walletAddress   this phone's wallet, base58
 * @param knownAddresses  addresses the person approved by hand
 * @param ledger          [{ id, at, lamports }] payments that left the wallet
 * @param reservedLamports money for payments started but not finished
 * @param reservedTokens  [{ mint, raw }] tokens for payments started but not finished
 * @param paused          see isPausedForAuto()
 * @param appActive       Nod is on screen
 * @returns {{ auto: true, outflowLamports: number, to: string, token?: { mint, raw } } | { auto: false, code: string, reason: string }}
 *   `code` is "off" when auto-approve is simply not in use: nothing is worth telling the person.
 */
function decideAutoApprove({
  review,
  settings,
  walletAddress,
  knownAddresses = [],
  ledger = [],
  reservedLamports = 0,
  reservedTokens = [],
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
  if (!transfer) {
    const token = tokenTransfer(review, walletAddress);
    if (!token) return no("not_plain", "Only plain SOL and token transfers are approved automatically.");
    return decideToken({ review, settings, token, knownAddresses, ledger, reservedTokens, now });
  }
  if (!(Number.isSafeInteger(settings.limitLamports) && settings.limitLamports > 0)) {
    return no("no_limit", "There is no daily limit for SOL, so it needs you.");
  }

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

/** The token half of the decision. Everything before it (switch, pause, screen, warnings) already held. */
function decideToken({ review, settings, token, knownAddresses, ledger, reservedTokens, now }) {
  const no = (code, reason) => ({ auto: false, code, reason });
  const label = tokens.tokenLabel(review.registry, token.mint);

  // Only a token Nod names. A mint that merely calls itself something never gets here.
  if (!review.registry || !review.registry.tokens || !review.registry.tokens[token.mint]) {
    return no("unknown_token", "Nod does not know this token, so it needs you.");
  }
  const fee = review.preview.feeLamports;
  const outflow = Number.isSafeInteger(review.preview.deltaLamports) ? -review.preview.deltaLamports : NaN;
  if (!Number.isSafeInteger(fee) || fee < 0 || !(outflow >= 0 && outflow <= fee)) {
    return no("amounts", "The amounts do not add up, so it needs you.");
  }
  if (!Array.isArray(knownAddresses) || !knownAddresses.includes(token.to)) {
    return no("unknown_recipient", "First payment to this address: approve it yourself once.");
  }
  const limitRaw = tokenLimitRaw(settings, token.mint, token.decimals);
  if (limitRaw === null) return no("no_limit", `There is no daily limit for ${label}, so it needs you.`);
  const remaining = remainingToken({ limitRaw, ledger, reserved: reservedTokens, mint: token.mint, now });
  if (BigInt(token.raw) > remaining) {
    return no("over_limit", `Over what is left of today's ${label} limit (${tokens.formatTokenAmount(remaining, token.decimals)} ${label}), so it needs you.`);
  }
  return { auto: true, outflowLamports: outflow, to: token.to, token: { mint: token.mint, raw: token.raw } };
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
  if (transfer) return transfer.to;
  // A token payment the person approved teaches the recipient too, also when it had to create
  // their token account (the next one will not).
  const token = tokenTransfer(review, walletAddress, { allowCreate: true });
  return token ? token.to : null;
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
  const entry = { id, at: now, lamports: outflowLamports(review) };
  const out = tokenOutflows(review).map(({ mint, raw, decimals }) => ({ mint, raw, decimals }));
  if (out.length > 0) entry.tokens = out;
  return entry;
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
  const tokenLimits = {};
  if (raw && raw.tokenLimits && typeof raw.tokenLimits === "object") {
    for (const [mint, text] of Object.entries(raw.tokenLimits)) {
      const normal = ADDRESS_RE.test(mint) ? normalizeTokenLimit(text) : null;
      if (normal) tokenLimits[mint] = normal;
    }
  }
  settings.tokenLimits = tokenLimits;
  if (raw && Number.isSafeInteger(raw.limitLamports) && raw.limitLamports > 0 && raw.limitLamports <= MAX_LIMIT_LAMPORTS) {
    settings.limitLamports = raw.limitLamports;
  }
  // The switch counts only when there is a limit to apply it to.
  if (raw && raw.enabled === true && (settings.limitLamports > 0 || Object.keys(tokenLimits).length > 0)) settings.enabled = true;
  const known = (Array.isArray(data.known) ? data.known : []).filter((a) => typeof a === "string" && ADDRESS_RE.test(a)).slice(0, MAX_KNOWN_ADDRESSES);
  const ledger = (Array.isArray(data.ledger) ? data.ledger : [])
    .filter((e) => e && typeof e.id === "string" && Number.isFinite(e.at) && Number.isSafeInteger(e.lamports) && e.lamports >= 0)
    .map((e) => {
      const entry = { id: e.id.slice(0, 64), at: e.at, lamports: e.lamports };
      const items = (Array.isArray(e.tokens) ? e.tokens : [])
        .filter((t) => t && typeof t.mint === "string" && ADDRESS_RE.test(t.mint) && typeof t.raw === "string" && RAW_RE.test(t.raw))
        .map((t) => (Number.isInteger(t.decimals) && t.decimals >= 0 && t.decimals <= 30 ? { mint: t.mint, raw: t.raw, decimals: t.decimals } : { mint: t.mint, raw: t.raw }));
      if (items.length > 0) entry.tokens = items;
      return entry;
    })
    .slice(-MAX_LEDGER_ENTRIES);
  return { settings, known, ledger };
}

module.exports = {
  MAX_LIMIT_LAMPORTS,
  MAX_KNOWN_ADDRESSES,
  parseSolToLamports,
  normalizeTokenLimit,
  tokenLimitRaw,
  startOfLocalDay,
  spentToday,
  spentTodayToken,
  remainingLamports,
  remainingToken,
  pruneLedger,
  outflowLamports,
  tokenOutflows,
  tokenTransfer,
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
