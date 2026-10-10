"use strict";
/**
 * Thin wrapper around a @solana/web3.js Connection. The approval logic talks to
 * this, never to the Connection directly, so the same logic runs on the phone
 * (real RPC) and in the laptop tests (local stand-in RPC).
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param connection a @solana/web3.js Connection */
function rpcChain(connection) {
  return {
    /** Blockhash plus the slot it was fetched at (the wallet wants the slot). */
    async getLatestBlockhash() {
      const { context, value } = await connection.getLatestBlockhashAndContext();
      return {
        blockhash: value.blockhash,
        lastValidBlockHeight: value.lastValidBlockHeight,
        slot: context.slot,
      };
    },

    async getBalance(publicKey) {
      return connection.getBalance(publicKey);
    },

    /**
     * Dry-run a transaction that has not been signed yet and report the
     * wallet's balance afterwards.
     */
    async simulate(transaction, publicKey) {
      const { value } = await connection.simulateTransaction(transaction, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        accounts: { encoding: "base64", addresses: [publicKey.toBase58()] },
      });
      const account = value.accounts && value.accounts[0];
      return {
        err: value.err || null,
        postLamports: account ? account.lamports : null,
        logs: value.logs || [],
      };
    },

    async getFee(message) {
      const { value } = await connection.getFeeForMessage(message);
      return typeof value === "number" ? value : null;
    },

    /** Only used when we sign ourselves (simulator, or the sign-only fallback). */
    async sendRaw(serializedTransaction) {
      return connection.sendRawTransaction(serializedTransaction);
    },

    /**
     * Wait until a signature is confirmed. Polls instead of using a websocket
     * subscription, which is more reliable on mobile networks.
     * @returns {{ confirmed: boolean, err: unknown }}
     */
    async confirm(signature, { timeoutMs = 60_000, intervalMs = 1_000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const { value } = await connection.getSignatureStatuses([signature]);
        const status = value && value[0];
        if (status) {
          if (status.err) return { confirmed: false, err: status.err };
          if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
            return { confirmed: true, err: null };
          }
        }
        await sleep(intervalMs);
      }
      return { confirmed: false, err: "timeout" };
    },
  };
}

module.exports = { rpcChain };
