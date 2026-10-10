"use strict";
/**
 * Thin wrapper around a @solana/web3.js Connection. The approval logic talks to
 * this, never to the Connection directly, so the same logic runs on the phone
 * (real RPC) and in the laptop tests (local stand-in RPC).
 */

const { Buffer } = require("buffer");
const { NETWORKS } = require("./network");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param connection a @solana/web3.js Connection
 * @param {"devnet"|"mainnet"} network the network this connection is MEANT to be. verifyNetwork()
 *   checks the server really is that network (by its genesis hash) before anything is signed.
 */
function rpcChain(connection, network) {
  let verified = null;
  return {
    network,

    /**
     * Throws unless the RPC server is the chain this phone is set to. A success is remembered; a
     * failure (or an unreachable server) is not, so it is checked again next time.
     */
    async verifyNetwork() {
      const expected = NETWORKS[network];
      if (!expected) throw networkError("no_network", "Unknown network.");
      if (verified) return verified;
      let genesis;
      try {
        genesis = await connection.getGenesisHash();
      } catch (err) {
        throw networkError("network_unreachable", `Could not check which network the RPC server is on (${err && err.message ? err.message : err}). Nothing was signed.`);
      }
      if (genesis !== expected.genesisHash) {
        throw networkError("wrong_cluster", `The RPC server for ${expected.label} is not ${expected.label}. Nothing was signed. Check the RPC address in Settings.`);
      }
      verified = Promise.resolve(true);
      return verified;
    },

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
     * Dry-run a transaction that has not been signed yet and report the wallet's balance afterwards,
     * plus the state after of every address in `watch` (token accounts, for the token preview).
     * @returns {{ err, postLamports, logs, accounts: ({ lamports, owner, data } | null)[] }}
     *   `accounts` lines up with `watch`.
     */
    async simulate(transaction, publicKey, watch = []) {
      const addresses = [publicKey, ...watch].map((key) => (typeof key === "string" ? key : key.toBase58()));
      const { value } = await connection.simulateTransaction(transaction, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        accounts: { encoding: "base64", addresses },
      });
      const returned = value.accounts || [];
      const account = returned[0];
      return {
        err: value.err || null,
        postLamports: account ? account.lamports : null,
        logs: value.logs || [],
        accounts: watch.map((_key, index) => decodeAccount(returned[index + 1])),
      };
    },

    /**
     * The accounts at these addresses right now: { lamports, owner, data } or null where there is none.
     * @param addresses PublicKey[]
     */
    async getAccounts(addresses) {
      const found = [];
      for (let i = 0; i < addresses.length; i += 100) {
        const infos = await connection.getMultipleAccountsInfo(addresses.slice(i, i + 100));
        for (const info of infos) {
          found.push(
            info ? { lamports: info.lamports, owner: info.owner.toBase58(), data: new Uint8Array(info.data) } : null,
          );
        }
      }
      return found;
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

/** An account as the RPC returns it in a simulation (base64 data) -> { lamports, owner, data }, or null. */
function decodeAccount(account) {
  if (!account || !Array.isArray(account.data)) return null;
  return { lamports: account.lamports, owner: account.owner, data: new Uint8Array(Buffer.from(account.data[0], "base64")) };
}

/** An ApprovalError, loaded lazily because approval.js requires this file's siblings. */
function networkError(code, message) {
  const { ApprovalError } = require("./approval");
  return new ApprovalError(code, message);
}

module.exports = { rpcChain };
