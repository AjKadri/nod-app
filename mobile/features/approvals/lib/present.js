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
const tokens = require("./tokens");

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

// ------------------------------------------------------------------ tokens

function registryOf(review) {
  return review.registry || tokens.tokenRegistry(review.network || "devnet");
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every "<number> <SYMBOL>" the note mentions, as the text of the number. */
function claimedTokenAmounts(note, symbol) {
  if (typeof note !== "string" || !symbol) return [];
  const pattern = new RegExp(`(\\d+(?:[.,]\\d+)?|[.,]\\d+)\\s*${escapeRegExp(symbol)}(?![A-Za-z0-9])`, "gi");
  const found = [];
  let match;
  while ((match = pattern.exec(note)) !== null) found.push(match[1].replace(",", "."));
  return found;
}

function mentionsSymbol(note, symbol) {
  if (typeof note !== "string" || !symbol) return false;
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(symbol)}(?![A-Za-z0-9])`, "i").test(note);
}

const tokenChangesOf = (review) => (review.preview && review.preview.tokens && review.preview.tokens.changes) || [];

/**
 * Token amounts the note names that disagree with the simulation. Only tokens Nod knows by name
 * (SKR, USDC) are checked, because only those have a symbol the note can mean. Exact: a note that
 * says 25 SKR when 250 SKR leave is a mismatch.
 * @returns {{ said: string, actual: string, message: string }[]}
 */
function findTokenMismatches(note, review) {
  const registry = registryOf(review);
  const found = [];
  for (const change of tokenChangesOf(review)) {
    const known = registry.tokens[change.mint];
    const raw = BigInt(change.deltaRaw);
    if (!known || raw >= 0n) continue;
    const claims = claimedTokenAmounts(note, known.symbol);
    if (claims.length === 0) continue;
    const actual = -raw;
    const matches = claims.some((text) => tokens.parseTokenAmount(text, change.decimals) === actual);
    if (matches) continue;
    const said = `${claims[0]} ${known.symbol}`;
    const real = `${tokens.formatTokenAmount(actual, change.decimals)} ${known.symbol}`;
    found.push({ said, actual: real, message: `The agent said ${said}. This sends ${real}.` });
  }
  return found;
}

/**
 * Tokens that pass themselves off as a token Nod knows by name. A token does this when its own
 * metadata gives it that symbol, or when the note talks about that symbol while the token that
 * leaves the wallet is a different mint. Only the official mint is the real one.
 * @returns {string[]} the symbols being imitated, e.g. ["SKR"]
 */
function findImpostors(note, review) {
  const registry = registryOf(review);
  const changes = tokenChangesOf(review);
  const symbols = [];
  for (const symbol of tokens.protectedSymbols(registry)) {
    const official = tokens.officialMintFor(registry, symbol);
    const sendsOfficial = changes.some((c) => c.mint === official && BigInt(c.deltaRaw) < 0n);
    const noteTalksAbout = mentionsSymbol(note, symbol);
    const imitated = changes.some((c) => {
      if (c.mint === official) return false;
      const byMetadata = typeof c.claimedSymbol === "string" && c.claimedSymbol.trim().toUpperCase() === symbol.toUpperCase();
      const byNote = noteTalksAbout && !sendsOfficial && BigInt(c.deltaRaw) < 0n;
      return byMetadata || byNote;
    });
    if (imitated) symbols.push(symbol);
  }
  return symbols;
}

/** Only transfers (and creating the token account they need), nothing else besides a compute budget. */
function isPlainTokenTransfer(summary) {
  const kinds = summary.tokenInstructions || [];
  if (kinds.length === 0 || !kinds.every((kind) => kind === "transfer" || kind === "createAta")) return false;
  if (!kinds.includes("transfer") || summary.unknownPrograms.length > 0) return false;
  return summary.programs.every((program) => program.name && /^(Token|Token-2022|Associated Token|Compute Budget|System)/.test(program.name));
}

function actionLabel(review) {
  const { summary } = review;
  if (isPlainTokenTransfer(summary)) return "Token transfer";
  const names = summary.programs.map((program) => program.name || "");
  if (summary.transfers.length > 0 && summary.unknownPrograms.length === 0 && !names.some((n) => /token/i.test(n))) {
    return "SOL transfer";
  }
  if (names.some((name) => /token/i.test(name))) return "Token transaction";
  return "Program call";
}

function recipientLabel(review, primary) {
  const { transfers, programs } = review.summary;
  if (primary && primary.deltaRaw && BigInt(primary.deltaRaw) < 0n) {
    // Who receives the token, from the simulation: the owners of the token accounts that went up.
    const owners = [
      ...new Set(
        ((review.preview.tokens && review.preview.tokens.others) || [])
          .filter((other) => other.mint === primary.mint && BigInt(other.deltaRaw) > 0n)
          .map((other) => other.owner),
      ),
    ];
    if (owners.length === 1) return { kind: "address", value: owners[0] };
    if (owners.length > 1) return { kind: "text", value: `${owners.length} recipients` };
  }
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
 *   risky: boolean,
 *   warnings: { level: "danger" | "warn", text: string }[],
 *   programs: { id: string, name: string | null }[],
 *   transfers: { to: string, lamports: number | null }[],
 *   logs: string[],
 * }}
 */
function presentReview(review) {
  const { request, summary, preview } = review;
  const note = typeof request.note === "string" ? request.note.trim() : "";
  const registry = registryOf(review);
  const tokenInfo = preview.tokens || null;
  const tokenChanges = tokenChangesOf(review);
  const isTransfer = request.type === "transfer" || (summary.transfers.length > 0 && summary.unknownPrograms.length === 0);

  // What the main number on the card is: the token that leaves (or arrives), else SOL.
  const byDelta = (a, b) => {
    const x = BigInt(a.deltaRaw);
    const y = BigInt(b.deltaRaw);
    const ax = x < 0n ? -x : x;
    const ay = y < 0n ? -y : y;
    return ax > ay ? -1 : ax < ay ? 1 : 0;
  };
  const sends = tokenChanges.filter((c) => BigInt(c.deltaRaw) < 0n).sort(byDelta);
  const receives = tokenChanges.filter((c) => BigInt(c.deltaRaw) > 0n).sort(byDelta);
  const primary = preview.ok ? sends[0] || receives[0] || null : null;

  let amount = null;
  let unit = "SOL";
  let direction = "unknown";
  let token = null;
  if (primary) {
    const raw = BigInt(primary.deltaRaw);
    amount = tokens.formatTokenAmount(raw < 0n ? -raw : raw, primary.decimals);
    unit = tokens.tokenLabel(registry, primary.mint);
    direction = raw < 0n ? "send" : "receive";
    const known = registry.tokens[primary.mint];
    token = { mint: primary.mint, label: unit, symbol: known ? known.symbol : null, logo: known ? known.logo : null, known: !!known, test: !!(known && known.test) };
  } else if (preview.ok && typeof preview.deltaLamports === "number") {
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

  // Everything else the transaction does, in words: rent for a new token account, other amounts.
  const notes = [];
  const also = [];
  let rentLamports = 0;
  for (const created of (tokenInfo && tokenInfo.created) || []) {
    rentLamports += created.rentLamports;
    notes.push(
      created.own
        ? `Creates your ${tokens.tokenLabel(registry, created.mint)} token account: +${tokens.formatSolShort(created.rentLamports)} SOL rent`
        : `Creates the recipient’s token account: +${tokens.formatSolShort(created.rentLamports)} SOL rent`,
    );
  }
  if (preview.ok) {
    for (const change of [...sends, ...receives]) {
      if (change === primary) continue;
      const raw = BigInt(change.deltaRaw);
      const text = `${tokens.formatTokenAmount(raw < 0n ? -raw : raw, change.decimals)} ${tokens.tokenLabel(registry, change.mint)}`;
      also.push(raw < 0n ? `Also sends ${text}` : `Also receives ${text}`);
    }
    if (primary && typeof preview.deltaLamports === "number") {
      const fee = typeof preview.feeLamports === "number" ? preview.feeLamports : 0;
      const extra = -preview.deltaLamports - fee - rentLamports;
      if (extra > 1_000) also.push(`Also sends ${formatSol(extra)}`);
      else if (preview.deltaLamports > 0) also.push(`Also receives ${formatSol(preview.deltaLamports)}`);
    }
  }

  const mismatches = [];
  const solMismatch = findAmountMismatch(note, review);
  if (solMismatch) {
    const said = formatSol(solMismatch.saidLamports);
    const actual = formatSol(solMismatch.actualLamports);
    mismatches.push({ said, actual, message: `The agent said ${said}. This sends ${actual}.` });
  }
  mismatches.push(...findTokenMismatches(note, review));
  const mismatch = mismatches[0] || null;

  const warnings = [];
  for (const found of mismatches) warnings.push({ level: "danger", text: found.message });
  // Warnings about tokens also show on the card itself, not only in the details.
  const tokenAlerts = [];
  for (const symbol of findImpostors(note, review)) {
    const text = `This token claims to be ${symbol} but isn’t the official ${symbol}.`;
    warnings.push({ level: "danger", text });
    tokenAlerts.push(text);
  }
  if (!preview.ok) {
    warnings.push({ level: "danger", text: "This transaction would fail or could not be checked." });
  }
  if (preview.ok && tokenInfo && tokenInfo.complete === false) {
    const text = "Nod could not check every account in this transaction, so some token changes may not be shown.";
    warnings.push({ level: "danger", text });
    tokenAlerts.push(text);
  }
  // Said once each: the instruction can name a danger (approve, set authority) and the simulation
  // can show it too (and shows it when a program Nod does not know did it).
  const dangers = [...(summary.tokenDangers || []), ...((tokenInfo && tokenInfo.dangers) || [])];
  for (const text of dangers) {
    if (tokenAlerts.includes(text)) continue;
    warnings.push({ level: "danger", text });
    tokenAlerts.push(text);
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

  const tokenLines = tokenChanges.map((change) => {
    const label = tokens.tokenLabel(registry, change.mint);
    return `${label}: ${tokens.formatTokenAmount(change.preRaw, change.decimals)} → ${tokens.formatTokenAmount(change.postRaw, change.decimals)}`;
  });

  return {
    headline: note || (primary ? `${direction === "receive" ? "Receive" : "Send"} ${unit}` : isTransfer ? "Send SOL" : "Approve a transaction"),
    agentClaim: note || null,
    amount,
    unit,
    /** The token on the card when it is not SOL: { mint, label, symbol, logo, known, test }. */
    token,
    network: review.network || null,
    direction,
    action: actionLabel(review),
    recipient: recipientLabel(review, primary),
    fee: typeof preview.feeLamports === "number" ? `Est. ${formatSol(preview.feeLamports)}` : "Unknown",
    previewOk: preview.ok,
    previewText: preview.ok ? "Simulation completed" : `Failed: ${preview.error || "unknown error"}`,
    mismatch,
    /** Lines under the amount: rent for a new token account. */
    notes,
    /** Red warnings about tokens (a fake SKR, an unchecked account, a hand-over of control), for the card itself. */
    tokenAlerts,
    /** Other amounts that move in the same transaction. */
    also,
    /** The wallet's token balances before and after, for the details. */
    tokenLines,
    /** True when any red warning shows: the card then makes Reject the main action. */
    risky: warnings.some((w) => w.level === "danger"),
    warnings,
    programs: summary.programs,
    transfers: summary.transfers.map((t) => ({ to: t.to, lamports: t.lamports })),
    logs: preview.logs || [],
  };
}

module.exports = {
  presentReview,
  findAmountMismatch,
  findTokenMismatches,
  findImpostors,
  claimedLamports,
  claimedTokenAmounts,
  formatAmount,
};
