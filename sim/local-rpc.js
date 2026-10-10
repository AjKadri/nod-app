#!/usr/bin/env node
"use strict";
/**
 * A stand-in for Solana devnet that runs on your laptop with no internet.
 * It executes transactions with LiteSVM (the real Solana runtime, in-process)
 * and answers the handful of JSON-RPC calls this project uses, so the ordinary
 * @solana/web3.js `Connection` can talk to it.
 *
 * For tests and offline demos only. It is NOT a full RPC node.
 *
 * Run:  node sim/local-rpc.js     (PORT env var, default 8899)
 */
const http = require("http");
const bs58pkg = require("bs58");
const bs58 = bs58pkg.default || bs58pkg;
const { LiteSVM, FailedTransactionMetadata } = require("litesvm");
const { PublicKey, VersionedMessage, VersionedTransaction } = require("@solana/web3.js");

const LAMPORTS_PER_SIGNATURE = 5000;
const TRANSACTION_ERRORS = {
  2: "AccountNotFound",
  4: "InsufficientFundsForFee",
  6: "AlreadyProcessed",
  7: "BlockhashNotFound",
  11: "SignatureFailure",
  13: "SanitizeFailure",
};
const ERROR_MESSAGES = {
  BlockhashNotFound: "Blockhash not found",
  AlreadyProcessed: "This transaction has already been processed",
  SignatureFailure: "Transaction did not pass signature verification",
  InsufficientFundsForFee: "Insufficient funds for fee",
  AccountNotFound: "Attempt to debit an account but found no record of a prior credit.",
};

function mapError(err) {
  if (typeof err === "number") return TRANSACTION_ERRORS[err] || `TransactionError(${err})`;
  if (err && typeof err.index === "number" && typeof err.err === "function") {
    const inner = err.err();
    const detail = inner && typeof inner.code === "number" ? { Custom: inner.code } : String(inner);
    return { InstructionError: [err.index, detail] };
  }
  return String(err);
}

function errorMessage(mapped) {
  if (typeof mapped === "string") return ERROR_MESSAGES[mapped] || mapped;
  return `Error processing Instruction ${mapped.InstructionError[0]}: ${JSON.stringify(mapped.InstructionError[1])}`;
}

function createLocalRpc({ port = 8899, host = "127.0.0.1" } = {}) {
  const svm = new LiteSVM().withTransactionHistory(10_000n);
  let slot = 1;

  const context = () => ({ apiVersion: "local-litesvm", slot });

  function decodeTransaction(encoded, options) {
    const encoding = (options && options.encoding) || "base58";
    const bytes = encoding === "base64" ? Buffer.from(encoded, "base64") : Buffer.from(bs58.decode(encoded));
    return VersionedTransaction.deserialize(bytes);
  }

  function accountJson(account) {
    if (!account) return null;
    return {
      lamports: Number(typeof account.lamports === "function" ? account.lamports() : account.lamports),
      owner: new PublicKey(typeof account.owner === "function" ? account.owner() : account.owner).toBase58(),
      data: [Buffer.from(typeof account.data === "function" ? account.data() : account.data).toString("base64"), "base64"],
      executable: Boolean(typeof account.executable === "function" ? account.executable() : account.executable),
      rentEpoch: 0,
    };
  }

  const methods = {
    getVersion: () => ({ "solana-core": "local-litesvm", "feature-set": 0 }),
    getHealth: () => "ok",
    getSlot: () => slot,
    getBlockHeight: () => slot,

    getLatestBlockhash: () => ({
      context: context(),
      value: { blockhash: svm.latestBlockhash(), lastValidBlockHeight: slot + 150 },
    }),

    getBalance: ([address]) => ({
      context: context(),
      value: Number(svm.getBalance(new PublicKey(address)) || 0n),
    }),

    getFeeForMessage: ([encodedMessage]) => {
      const message = VersionedMessage.deserialize(Buffer.from(encodedMessage, "base64"));
      return { context: context(), value: LAMPORTS_PER_SIGNATURE * message.header.numRequiredSignatures };
    },

    requestAirdrop: ([address, lamports]) => {
      const result = svm.airdrop(new PublicKey(address), BigInt(lamports));
      if (!result || result instanceof FailedTransactionMetadata) {
        throw Object.assign(new Error("Airdrop failed"), { code: -32003 });
      }
      slot += 1;
      return bs58.encode(result.signature());
    },

    simulateTransaction: ([encoded, options = {}]) => {
      const transaction = decodeTransaction(encoded, options);
      if (options.replaceRecentBlockhash) transaction.message.recentBlockhash = svm.latestBlockhash();
      const verify = options.sigVerify === true;
      if (!verify) svm.withSigverify(false);
      let result;
      try {
        result = svm.simulateTransaction(transaction);
      } finally {
        if (!verify) svm.withSigverify(true);
      }
      const addresses = (options.accounts && options.accounts.addresses) || null;
      if (result instanceof FailedTransactionMetadata) {
        return {
          context: context(),
          value: { err: mapError(result.err()), logs: result.meta().logs(), accounts: null, unitsConsumed: 0, returnData: null },
        };
      }
      const post = result.postAccounts();
      const accounts = addresses
        ? addresses.map((address) => {
            const key = new PublicKey(address);
            const found = post.find(([postKey]) => postKey.equals(key));
            return accountJson(found ? found[1] : svm.getAccount(key));
          })
        : null;
      return {
        context: context(),
        value: {
          err: null,
          logs: result.meta().logs(),
          accounts,
          unitsConsumed: Number(result.meta().computeUnitsConsumed()),
          returnData: null,
        },
      };
    },

    sendTransaction: ([encoded, options = {}]) => {
      const transaction = decodeTransaction(encoded, options);
      const reject = (failed) => {
        const mapped = mapError(failed.err());
        throw Object.assign(new Error(`Transaction simulation failed: ${errorMessage(mapped)}`), {
          code: -32002,
          data: { err: mapped, logs: failed.meta().logs(), accounts: null, unitsConsumed: 0 },
        });
      };
      // Like a real node: simulate first ("preflight") so a transaction that
      // would fail is rejected without landing and without charging a fee.
      if (!options.skipPreflight) {
        const preflight = svm.simulateTransaction(transaction);
        if (preflight instanceof FailedTransactionMetadata) reject(preflight);
      }
      const result = svm.sendTransaction(transaction);
      if (result instanceof FailedTransactionMetadata) reject(result);
      slot += 1;
      return bs58.encode(transaction.signatures[0]);
    },

    getSignatureStatuses: ([signatures]) => ({
      context: context(),
      value: signatures.map((signature) => {
        const found = svm.getTransaction(bs58.decode(signature));
        if (!found) return null;
        const failed = found instanceof FailedTransactionMetadata;
        return {
          slot,
          confirmations: null,
          err: failed ? mapError(found.err()) : null,
          status: failed ? { Err: mapError(found.err()) } : { Ok: null },
          confirmationStatus: "finalized",
        };
      }),
    }),
  };

  function reply(res, body) {
    const text = JSON.stringify(body);
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
  }

  function answer(call) {
    const base = { jsonrpc: "2.0", id: call && call.id !== undefined ? call.id : null };
    const method = call && methods[call.method];
    if (!method) return { ...base, error: { code: -32601, message: `Method not found: ${call && call.method}` } };
    try {
      return { ...base, result: method(call.params || []) };
    } catch (err) {
      return { ...base, error: { code: err.code || -32603, message: err.message, ...(err.data ? { data: err.data } : {}) } };
    }
  }

  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let call;
      try {
        call = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch (_err) {
        return reply(res, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }
      reply(res, Array.isArray(call) ? call.map(answer) : answer(call));
    });
  });

  return {
    svm,
    /** Make every blockhash issued so far invalid, like ~90 seconds passing on a real cluster. */
    expireBlockhash() {
      svm.expireBlockhash();
      slot += 151;
    },
    airdrop(publicKey, lamports) {
      svm.airdrop(new PublicKey(publicKey), BigInt(lamports));
      slot += 1;
    },
    balance(publicKey) {
      return Number(svm.getBalance(new PublicKey(publicKey)) || 0n);
    },
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const actual = server.address().port;
          resolve({ port: actual, url: `http://${host}:${actual}` });
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

if (require.main === module) {
  const rpc = createLocalRpc({ port: Number(process.env.PORT || 8899) });
  rpc.listen().then(({ url }) => {
    console.log(`[local-rpc] offline Solana stand-in listening on ${url}`);
    console.log("[local-rpc] fund an address with: solana airdrop 1 <ADDRESS> --url " + url);
  });
}

module.exports = { createLocalRpc };
