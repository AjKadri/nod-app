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

  const confirmation = await chain
    .confirm(sent.signature, { timeoutMs: confirmTimeoutMs })
    .catch((err) => ({ confirmed: false, err: explainError(err) }));
  if (!confirmation.confirmed) {
    const why = confirmation.err === "timeout" ? "not confirmed in time" : `failed on chain: ${JSON.stringify(confirmation.err)}`;
    return report(relay, request.id, {
      status: "failed",
      signature: sent.signature,
      reason: `Transaction was sent but ${why}`,
    });
  }
  return report(relay, request.id, { status: "approved", signature: sent.signature, refreshed: sent.refreshed });
}

/** The user tapped Deny. Nothing is signed. */
async function submitDenial({ request, relay, reason = "Denied on the phone" }) {
  return report(relay, request.id, { status: "denied", reason });
}

/** The request could not even be shown (bad address, wrong fee payer, undecodable). */
async function submitInvalid({ request, relay, error }) {
  return report(relay, request.id, { status: "failed", reason: explainError(error) });
}

module.exports = { explainError, submitApproval, submitDenial, submitInvalid };
