"use strict";
/**
 * What happens after the user decides. Shared by the phone app and the
 * simulator: sign and send through the wallet, wait for confirmation, then
 * tell the relay (and so the agent) how it went.
 */
const { ApprovalError, approveRequest } = require("./approval");

function explainError(err) {
  if (!err) return "Unknown error";
  if (err instanceof ApprovalError) return err.message;
  const message = err.message ? String(err.message) : String(err);
  if (/blockhash not found|block height exceeded|expired/i.test(message)) {
    return "The transaction expired before it could be sent. Ask the agent to try again.";
  }
  if (/insufficient/i.test(message)) return "Not enough SOL in the wallet for this transaction.";
  return message.slice(0, 300);
}

async function report(relay, id, result) {
  try {
    await relay.sendResult(id, result);
    return { ...result, reported: true };
  } catch (err) {
    // The transaction outcome stands even if the relay could not be told.
    return { ...result, reported: false, reportError: explainError(err) };
  }
}

/** Wait for the network, then tell the relay how it went. */
async function confirmAndReport({ request, sent, chain, relay, confirmTimeoutMs }) {
  const confirmation = await chain
    .confirm(sent.signature, { timeoutMs: confirmTimeoutMs })
    .catch((err) => ({ confirmed: false, err: explainError(err) }));
  if (!confirmation.confirmed) {
    const timedOut = confirmation.err === "timeout";
    const why = timedOut ? "not confirmed in time" : `failed on chain: ${JSON.stringify(confirmation.err)}`;
    const reported = await report(relay, request.id, {
      status: "failed",
      signature: sent.signature,
      reason: `Transaction was sent but ${why}`,
    });
    // Landed and failed: only the fee left the wallet. Timed out: it may still land.
    return timedOut ? reported : { ...reported, failedOnChain: true };
  }
  return report(relay, request.id, { status: "approved", signature: sent.signature, refreshed: sent.refreshed });
}

/**
 * The user tapped Approve.
 * @param request the request object from the relay ({ id, payload })
 * @param signAndSend async (transaction, minContextSlot) => base58 signature
 * @returns {{ status: "approved" | "failed", signature?, reason?, refreshed?, reported }}
 */
async function submitApproval({ request, walletAddress, chain, signAndSend, relay, confirmTimeoutMs = 60_000 }) {
  let sent;
  try {
    sent = await approveRequest({ payload: request.payload, walletAddress, chain, signAndSend });
  } catch (err) {
    return report(relay, request.id, { status: "failed", reason: explainError(err) });
  }
  return confirmAndReport({ request, sent, chain, relay, confirmTimeoutMs });
}

/** Throw this from `signAndSend` when the wallet needs the person (login expired, prompt declined). */
class NeedsCardError extends Error {
  constructor(message) {
    super(message);
    this.name = "NeedsCardError";
    this.needsCard = true;
  }
}

/**
 * Approve without the card. Same as submitApproval, with one difference: when NOTHING could have
 * been sent (the blockhash could not be fetched, the wallet is not logged in, the wallet prompt was
 * declined) it returns { status: "needs_card" } and tells the relay nothing, so the request stays
 * pending and the person gets the normal card. Once the wallet has signed, a failure is reported
 * like any other, because the payment may have gone out and must not be offered twice.
 *
 * `signAndSend` must throw NeedsCardError (or any error with needsCard = true) for failures that
 * happen before anything is broadcast.
 * @returns {{ status: "needs_card", reason, reported: false } | { status: "approved" | "failed", auto: true, ... }}
 */
async function submitAutoApproval({ request, walletAddress, chain, signAndSend, relay, confirmTimeoutMs = 60_000 }) {
  let signing = false;
  let sent;
  try {
    sent = await approveRequest({
      payload: request.payload,
      walletAddress,
      chain,
      plainOnly: true,
      signAndSend: (transaction, minContextSlot) => {
        signing = true;
        return signAndSend(transaction, minContextSlot);
      },
    });
  } catch (err) {
    if (!signing || (err && err.needsCard === true)) {
      return { status: "needs_card", reason: explainError(err), reported: false };
    }
    return { ...(await report(relay, request.id, { status: "failed", reason: explainError(err) })), auto: true };
  }
  return { ...(await confirmAndReport({ request, sent, chain, relay, confirmTimeoutMs })), auto: true };
}

/** The user tapped Deny. Nothing is signed. */
async function submitDenial({ request, relay, reason = "Denied on the phone" }) {
  return report(relay, request.id, { status: "denied", reason });
}

/** The request could not even be shown (bad address, wrong fee payer, undecodable). */
async function submitInvalid({ request, relay, error }) {
  return report(relay, request.id, { status: "failed", reason: explainError(error) });
}

module.exports = { explainError, NeedsCardError, submitApproval, submitAutoApproval, submitDenial, submitInvalid };
