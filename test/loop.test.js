"use strict";
/**
 * End-to-end tests for everything that does not need a phone.
 *
 * Real pieces: the relay, the agent client, the MCP server, the approval logic
 * the phone app runs (shared/), @solana/web3.js, and the Solana runtime
 * (LiteSVM) behind a local RPC stand-in.
 *
 * Stand-ins: the phone is sim/phone.js (signs with a test key instead of a
 * mobile wallet), and devnet is sim/local-rpc.js.
 */
const { test, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} = require("@solana/web3.js");

const { createRelay } = require("../relay/server");
const { createLocalRpc } = require("../sim/local-rpc");
const { createSimPhone } = require("../sim/phone");
const { requestApproval, buildRawTransfer, getWalletAddress } = require("../agent/client");
const {
  ApprovalError,
  validateRequest,
  prepareTransaction,
  summarizeTransaction,
  reviewRequest,
} = require("../shared/approval");
const { rpcChain } = require("../shared/chain");

const FEE = 5000;
const ROOT = path.join(__dirname, "..");

let rpc;
let rpcUrl;
let relay;
let relayUrl;
let connection;
const openPhones = new Set();

/** Start a simulated phone with 1 SOL. `decide` is the "human". */
function startPhone({ decide = async () => "approve", fund = LAMPORTS_PER_SOL, token = "", relayOverride } = {}) {
  const keypair = Keypair.generate();
  if (fund > 0) rpc.airdrop(keypair.publicKey, fund);
  const events = [];
  const phone = createSimPhone({
    relayUrl: relayOverride || relayUrl,
    rpcUrl,
    keypair,
    token,
    decide,
    onEvent: (event) => events.push({ ...event, at: Date.now() }),
  });
  openPhones.add(phone);
  return { phone, keypair, events };
}

async function waitFor(check, { timeoutMs = 5000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function phoneOnline(base = relayUrl) {
  await waitFor(async () => (await (await fetch(`${base}/health`)).json()).phones > 0, { label: "phone online" });
}

function newAddress() {
  return Keypair.generate().publicKey.toBase58();
}

before(async () => {
  rpc = createLocalRpc({ port: 0 });
  rpcUrl = (await rpc.listen()).url;
  relay = createRelay({ port: 0 });
  relayUrl = (await relay.listen()).url;
  connection = new Connection(rpcUrl, "confirmed");
});

// Close every simulated phone after each test, pass or fail, so a leftover
// phone can never answer the next test's request.
afterEach(() => {
  for (const phone of openPhones) phone.close();
  openPhones.clear();
});

after(async () => {
  await relay.close();
  await rpc.close();
});

// ---------------------------------------------------------------- Test 3

test("Test 3: agent asks, phone approves, agent gets a confirmed signature", async () => {
  const { phone, keypair, events } = startPhone();
  await phoneOnline();
  const to = newAddress();
  const lamports = 1_000_000;

  const sentAt = Date.now();
  const outcome = await requestApproval({
    relay: relayUrl,
    payload: { type: "transfer", to, lamports, note: "from laptop agent" },
  });

  assert.equal(outcome.status, "approved");
  assert.match(outcome.result.signature, /^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
  assert.equal(rpc.balance(to), lamports, "recipient received exactly the amount");
  assert.equal(rpc.balance(keypair.publicKey), LAMPORTS_PER_SOL - lamports - FEE, "wallet paid amount + fee");

  const status = await connection.getSignatureStatuses([outcome.result.signature]);
  assert.equal(status.value[0].err, null, "signature is confirmed on chain");

  const received = events.find((e) => e.type === "received");
  assert.ok(received.at - sentAt < 2000, "request reached the phone within 2 seconds");
});

test("Test 3: phone denies, agent is told, nothing moves", async () => {
  const { phone, keypair } = startPhone({ decide: async () => "deny" });
  await phoneOnline();
  const to = newAddress();

  const outcome = await requestApproval({
    relay: relayUrl,
    payload: { type: "transfer", to, lamports: 1_000_000 },
  });

  assert.equal(outcome.status, "denied");
  assert.equal(outcome.result.signature, undefined);
  assert.equal(rpc.balance(to), 0);
  assert.equal(rpc.balance(keypair.publicKey), LAMPORTS_PER_SOL, "wallet untouched, not even a fee");
});

test("a request sent while the phone is offline is delivered when it connects", async () => {
  const to = newAddress();
  const pending = requestApproval({ relay: relayUrl, payload: { type: "transfer", to, lamports: 2_000_000 } });
  await waitFor(async () => (await (await fetch(`${relayUrl}/health`)).json()).pending === 1, { label: "request queued" });

  const { phone } = startPhone();
  const outcome = await pending;
  assert.equal(outcome.status, "approved");
  assert.equal(rpc.balance(to), 2_000_000);
});

// ---------------------------------------------------------------- Test 4

test("Test 4: a pre-built transaction with an expired blockhash still goes through", async () => {
  const { phone, keypair } = startPhone();
  await phoneOnline();
  const to = newAddress();
  const lamports = 3_000_000;

  const built = await buildRawTransfer({ rpc: rpcUrl, from: phone.address, to, lamports });
  rpc.expireBlockhash(); // the agent's blockhash is now dead

  // Control: prove the blockhash really is dead, so this test means something.
  const stale = VersionedTransaction.deserialize(Buffer.from(built.transactionBase64, "base64"));
  stale.sign([keypair]);
  await assert.rejects(connection.sendRawTransaction(stale.serialize()), /Blockhash not found/);
  assert.equal(rpc.balance(to), 0);

  const outcome = await requestApproval({
    relay: relayUrl,
    payload: { type: "raw", transactionBase64: built.transactionBase64 },
  });

  assert.equal(outcome.status, "approved");
  assert.equal(outcome.result.refreshed, true);
  assert.equal(rpc.balance(to), lamports);
});

test("Test 4: a slow human (blockhash expires while the request is on screen) still works", async () => {
  const { phone } = startPhone({
    decide: async () => {
      rpc.expireBlockhash(); // stands in for "wait 3 minutes, then tap Approve"
      return "approve";
    },
  });
  await phoneOnline();
  const to = newAddress();
  const built = await buildRawTransfer({ rpc: rpcUrl, from: phone.address, to, lamports: 4_000_000 });

  const outcome = await requestApproval({
    relay: relayUrl,
    payload: { type: "raw", transactionBase64: built.transactionBase64 },
  });

  assert.equal(outcome.status, "approved");
  assert.equal(rpc.balance(to), 4_000_000);
});

test("known limit: a multi-signer transaction cannot be refreshed", async () => {
  const cosigner = Keypair.generate();
  rpc.airdrop(cosigner.publicKey, LAMPORTS_PER_SOL);
  let expireBeforeApproving = false;
  const { phone } = startPhone({
    decide: async () => {
      if (expireBeforeApproving) rpc.expireBlockhash();
      return "approve";
    },
  });
  await phoneOnline();
  const wallet = new PublicKey(phone.address);

  async function buildTwoSigner(to) {
    const { blockhash } = await connection.getLatestBlockhash();
    const message = new TransactionMessage({
      payerKey: wallet,
      recentBlockhash: blockhash,
      instructions: [
        SystemProgram.transfer({ fromPubkey: wallet, toPubkey: to, lamports: 1_000_000 }),
        SystemProgram.transfer({ fromPubkey: cosigner.publicKey, toPubkey: to, lamports: 1_000_000 }),
      ],
    }).compileToLegacyMessage();
    const transaction = new VersionedTransaction(message);
    transaction.sign([cosigner]); // the other party signs first
    return Buffer.from(transaction.serialize()).toString("base64");
  }

  // Approved in time: works, and the co-signer's signature is preserved.
  const to1 = Keypair.generate().publicKey;
  const fast = await requestApproval({
    relay: relayUrl,
    payload: { type: "raw", transactionBase64: await buildTwoSigner(to1) },
  });
  assert.equal(fast.status, "approved");
  assert.equal(fast.result.refreshed, false);
  assert.equal(rpc.balance(to1), 2_000_000);

  // Approved too late: fails cleanly with a plain-language reason.
  expireBeforeApproving = true;
  const to2 = Keypair.generate().publicKey;
  const slow = await requestApproval({
    relay: relayUrl,
    payload: { type: "raw", transactionBase64: await buildTwoSigner(to2) },
  });
  assert.equal(slow.status, "failed");
  assert.match(slow.result.reason, /expired/i);
  assert.equal(rpc.balance(to2), 0);
});

// ---------------------------------------------------------------- Test 5

test("Test 5: the preview shown before signing matches what actually leaves the wallet", async () => {
  let shown;
  const { phone, keypair } = startPhone({
    decide: async (review) => {
      shown = review;
      return "approve";
    },
  });
  await phoneOnline();
  const to = newAddress();
  const lamports = 1_000_000;
  const before = rpc.balance(keypair.publicKey);

  const outcome = await requestApproval({ relay: relayUrl, payload: { type: "transfer", to, lamports } });
  assert.equal(outcome.status, "approved");

  const actualChange = rpc.balance(keypair.publicKey) - before;
  assert.equal(shown.preview.ok, true);
  assert.equal(shown.preview.deltaLamports, actualChange, "previewed change equals real change");
  assert.equal(shown.preview.deltaLamports, -(lamports + FEE));
  assert.equal(shown.preview.feeLamports, FEE);
  assert.equal(shown.headline, "You send 0.001005 SOL (network fee included)");
  assert.deepEqual(shown.summary.transfers, [{ from: phone.address, to, lamports }]);
  assert.equal(shown.summary.programs[0].name, "System Program");
});

test("the preview shows what the transaction really does, not what the agent's note claims", async () => {
  let shown;
  const { phone } = startPhone({
    decide: async (review) => {
      shown = review;
      return "deny";
    },
  });
  await phoneOnline();
  const attacker = newAddress();
  const built = await buildRawTransfer({ rpc: rpcUrl, from: phone.address, to: attacker, lamports: 900_000_000 });

  const outcome = await requestApproval({
    relay: relayUrl,
    payload: { type: "raw", transactionBase64: built.transactionBase64, note: "tiny 0.001 SOL test payment" },
  });

  assert.equal(outcome.status, "denied");
  assert.equal(shown.headline, "You send 0.900005 SOL (network fee included)");
  assert.equal(shown.summary.transfers[0].lamports, 900_000_000);
  assert.equal(rpc.balance(attacker), 0);
});

test("a transaction that would fail is flagged in the preview and fails cleanly if approved", async () => {
  let shown;
  const { phone, keypair } = startPhone({
    fund: 10_000_000,
    decide: async (review) => {
      shown = review;
      return "approve";
    },
  });
  await phoneOnline();
  const to = newAddress();

  const outcome = await requestApproval({
    relay: relayUrl,
    payload: { type: "transfer", to, lamports: 2 * LAMPORTS_PER_SOL },
  });

  assert.equal(shown.preview.ok, false);
  assert.match(shown.headline, /Could not simulate/);
  assert.equal(outcome.status, "failed");
  assert.match(outcome.result.reason, /not enough sol|insufficient|custom/i);
  assert.equal(rpc.balance(to), 0);
  assert.equal(rpc.balance(keypair.publicKey), 10_000_000, "preflight stopped it, no fee was charged");
});

// ---------------------------------------------------------------- hostile or broken input

test("a transaction built for a different wallet is refused before the human is asked", async () => {
  let asked = false;
  const { phone } = startPhone({
    decide: async () => {
      asked = true;
      return "approve";
    },
  });
  await phoneOnline();
  const someoneElse = Keypair.generate();
  rpc.airdrop(someoneElse.publicKey, LAMPORTS_PER_SOL);
  const built = await buildRawTransfer({
    rpc: rpcUrl,
    from: someoneElse.publicKey.toBase58(),
    to: newAddress(),
    lamports: 1_000_000,
  });

  const outcome = await requestApproval({
    relay: relayUrl,
    payload: { type: "raw", transactionBase64: built.transactionBase64 },
  });

  assert.equal(outcome.status, "failed");
  assert.match(outcome.result.reason, /fee payer/i);
  assert.equal(asked, false);
});

test("garbage from the agent is refused, and the phone keeps working afterwards", async () => {
  const { phone } = startPhone();
  await phoneOnline();

  const junk = await requestApproval({
    relay: relayUrl,
    payload: { type: "raw", transactionBase64: Buffer.from("not a transaction").toString("base64") },
  });
  assert.equal(junk.status, "failed");

  const badAddress = await requestApproval({
    relay: relayUrl,
    payload: { type: "transfer", to: "definitely-not-an-address", lamports: 1000 },
  });
  assert.equal(badAddress.status, "failed");
  assert.match(badAddress.result.reason, /valid Solana address/);

  const to = newAddress();
  const good = await requestApproval({ relay: relayUrl, payload: { type: "transfer", to, lamports: 1_000_000 } });
  assert.equal(good.status, "approved");
});

test("request validation rejects malformed payloads", () => {
  const to = newAddress();
  assert.throws(() => validateRequest(null), ApprovalError);
  assert.throws(() => validateRequest({ type: "swap" }), /Unknown request type/);
  assert.throws(() => validateRequest({ type: "transfer", to, lamports: 0 }), /positive whole number/);
  assert.throws(() => validateRequest({ type: "transfer", to, lamports: 1.5 }), /positive whole number/);
  assert.throws(() => validateRequest({ type: "transfer", to, lamports: "1000" }), /positive whole number/);
  assert.throws(() => validateRequest({ type: "transfer", to, lamports: 1, note: "x".repeat(281) }), /note/);
  assert.throws(() => validateRequest({ type: "raw", transactionBase64: "" }), /missing/);
  assert.throws(() => validateRequest({ type: "raw", transactionBase64: "@@@@" }), /base64/);
  assert.throws(() => validateRequest({ type: "raw", transactionBase64: "A".repeat(2000) }), /base64/);
  assert.deepEqual(validateRequest({ type: "transfer", to, lamports: 5, extra: "dropped" }), {
    type: "transfer",
    to,
    lamports: 5,
    note: "",
    agent: "",
  });
});

test("transactions calling unrecognised programs are flagged in the summary", async () => {
  const wallet = Keypair.generate().publicKey;
  const mystery = Keypair.generate().publicKey;
  const { blockhash } = await connection.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: wallet,
    recentBlockhash: blockhash,
    instructions: [
      SystemProgram.transfer({ fromPubkey: wallet, toPubkey: Keypair.generate().publicKey, lamports: 7 }),
      new TransactionInstruction({ programId: mystery, keys: [], data: Buffer.from([1, 2, 3]) }),
    ],
  }).compileToV0Message();
  const base64 = Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");

  const { transaction, refreshed } = prepareTransaction({ type: "raw", transactionBase64: base64 }, wallet, blockhash);
  const summary = summarizeTransaction(transaction);

  assert.equal(refreshed, true, "v0 transactions are handled too");
  assert.equal(summary.instructionCount, 2);
  assert.deepEqual(summary.unknownPrograms, [mystery.toBase58()]);
  assert.equal(summary.transfers[0].lamports, 7);
});

test("review works through the same RPC wrapper the phone app uses", async () => {
  const wallet = Keypair.generate();
  rpc.airdrop(wallet.publicKey, LAMPORTS_PER_SOL);
  const review = await reviewRequest({
    payload: { type: "transfer", to: newAddress(), lamports: 250_000_000, note: "rent", agent: "bot" },
    walletAddress: wallet.publicKey.toBase58(),
    chain: rpcChain(connection),
  });
  assert.equal(review.headline, "You send 0.250005 SOL (network fee included)");
  assert.equal(review.request.agent, "bot");
  assert.equal(review.refreshable, true);
});

// ---------------------------------------------------------------- relay behaviour

test("relay: a request can only be answered once", async () => {
  const created = await (
    await fetch(`${relayUrl}/requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "transfer", to: newAddress(), lamports: 1 }),
    })
  ).json();
  const answer = (body) =>
    fetch(`${relayUrl}/requests/${created.id}/result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  assert.equal((await answer({ status: "approved" })).status, 400, "approval without a signature is rejected");
  assert.equal((await answer({ status: "maybe" })).status, 400);
  assert.equal((await answer({ status: "denied" })).status, 200);
  assert.equal((await answer({ status: "approved", signature: "abc" })).status, 409, "cannot flip a denial");
  const final = await (await fetch(`${relayUrl}/requests/${created.id}`)).json();
  assert.equal(final.status, "denied");
});

test("relay: unanswered requests expire and the agent is told", async () => {
  const quick = createRelay({ port: 0, requestTtlMs: 150 });
  const { url } = await quick.listen();
  const outcome = await requestApproval({
    relay: url,
    payload: { type: "transfer", to: newAddress(), lamports: 1 },
  });
  assert.equal(outcome.status, "expired");
  await quick.close();
});

test("relay: when the agent gives up, the request is withdrawn", async () => {
  const outcome = await requestApproval({
    relay: relayUrl,
    payload: { type: "transfer", to: newAddress(), lamports: 1 },
    timeoutMs: 300,
  });
  assert.equal(outcome.status, "timeout");
  const stored = await (await fetch(`${relayUrl}/requests/${outcome.id}`)).json();
  assert.equal(stored.status, "cancelled");
  assert.equal((await (await fetch(`${relayUrl}/health`)).json()).pending, 0);
});

test("if the agent gives up while the human is still deciding, the phone signs nothing", async () => {
  let release;
  const humanDecides = new Promise((resolve) => (release = resolve));
  const { phone, keypair, events } = startPhone({
    decide: async () => {
      await humanDecides;
      return "approve";
    },
  });
  await phoneOnline();
  const to = newAddress();

  const outcome = await requestApproval({
    relay: relayUrl,
    payload: { type: "transfer", to, lamports: 1_000_000 },
    timeoutMs: 300,
  });
  assert.equal(outcome.status, "timeout");

  release(); // the human taps Approve after the agent has gone
  await phone.idle();
  assert.ok(events.some((e) => e.type === "skipped"));
  assert.equal(rpc.balance(to), 0);
  assert.equal(rpc.balance(keypair.publicKey), LAMPORTS_PER_SOL);
});

test("relay: with a token set, strangers are locked out and the owner still works", async () => {
  const locked = createRelay({ port: 0, token: "s3cret-token" });
  const { url } = await locked.listen();
  const body = JSON.stringify({ type: "transfer", to: newAddress(), lamports: 1_000_000 });
  const headers = { "content-type": "application/json" };

  assert.equal((await fetch(`${url}/requests`, { method: "POST", headers, body })).status, 401);
  assert.equal((await fetch(`${url}/wallet`)).status, 401);
  assert.equal(
    (await fetch(`${url}/requests`, { method: "POST", headers: { ...headers, authorization: "Bearer wrong" }, body })).status,
    401
  );
  await assert.rejects(requestApproval({ relay: url, payload: JSON.parse(body) }), /401/);

  const { phone } = startPhone({ token: "s3cret-token", relayOverride: url });
  await phoneOnline(url);
  const to = newAddress();
  const outcome = await requestApproval({
    relay: url,
    token: "s3cret-token",
    payload: { type: "transfer", to, lamports: 1_000_000 },
  });
  assert.equal(outcome.status, "approved");
  assert.equal(await getWalletAddress({ relay: url, token: "s3cret-token" }), phone.address);
  await locked.close();
});

test("relay: only one phone is live at a time, so a request can never be signed twice", async () => {
  const first = startPhone();
  await phoneOnline();
  startPhone();
  await waitFor(() => first.events.some((e) => e.type === "status" && e.status === "replaced"), {
    label: "first phone replaced",
  });
  const to = newAddress();

  const outcome = await requestApproval({ relay: relayUrl, payload: { type: "transfer", to, lamports: 1_000_000 } });

  assert.equal(outcome.status, "approved");
  assert.equal(rpc.balance(to), 1_000_000, "the money moved once, not twice");
  assert.equal(rpc.balance(first.keypair.publicKey), LAMPORTS_PER_SOL, "the replaced phone signed nothing");
  assert.equal((await (await fetch(`${relayUrl}/health`)).json()).phones, 1);
});

test("relay: rejects unknown request types and oversized bodies", async () => {
  const post = (body) =>
    fetch(`${relayUrl}/requests`, { method: "POST", headers: { "content-type": "application/json" }, body });
  assert.equal((await post(JSON.stringify({ type: "drain-everything" }))).status, 400);
  assert.equal((await post("{not json")).status, 400);
  assert.equal((await post(JSON.stringify({ type: "raw", transactionBase64: "A".repeat(20_000) }))).status, 413);
});

test("relay: fires a push notification when a request arrives", async () => {
  const pushes = [];
  const fakeExpo = http.createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      pushes.push(JSON.parse(data));
      res.end("{}");
    });
  });
  await new Promise((resolve) => fakeExpo.listen(0, "127.0.0.1", resolve));
  const pushy = createRelay({ port: 0, expoPushUrl: `http://127.0.0.1:${fakeExpo.address().port}/send` });
  const { url } = await pushy.listen();
  const headers = { "content-type": "application/json" };

  await fetch(`${url}/push-token`, { method: "POST", headers, body: JSON.stringify({ token: "ExponentPushToken[test]" }) });
  const created = await (
    await fetch(`${url}/requests`, {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "transfer", to: newAddress(), lamports: 1, note: "pay the invoice" }),
    })
  ).json();

  await waitFor(() => pushes.length === 1, { label: "push sent" });
  assert.equal(pushes[0].to, "ExponentPushToken[test]");
  assert.equal(pushes[0].body, "pay the invoice");
  assert.deepEqual(pushes[0].data, { requestId: created.id });
  await pushy.close();
  await new Promise((resolve) => fakeExpo.close(resolve));
});

// ---------------------------------------------------------------- Test 8 and the CLI

test("Test 8: a real MCP client can ask the phone through the MCP server", async () => {
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

  let choice = "approve";
  let lastReview;
  const { phone } = startPhone({
    decide: async (review) => {
      lastReview = review;
      return choice;
    },
  });
  await phoneOnline();

  const client = new Client({ name: "test-agent", version: "0.0.1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, "agent/mcp-server.js")],
      env: { ...process.env, RELAY_URL: relayUrl, AGENT_NAME: "claude-code", APPROVAL_TIMEOUT_SECONDS: "20" },
    })
  );

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["get_wallet_address", "request_transaction", "request_transfer"]);

  const wallet = await client.callTool({ name: "get_wallet_address", arguments: {} });
  assert.equal(wallet.content[0].text, phone.address);

  const to = newAddress();
  const approved = await client.callTool({
    name: "request_transfer",
    arguments: { to, sol: 0.001, note: "send 0.001 SOL on devnet" },
  });
  assert.ok(!approved.isError);
  assert.match(approved.content[0].text, /^APPROVED by the user\. Transaction signature: [1-9A-HJ-NP-Za-km-z]{80,90}$/);
  assert.equal(rpc.balance(to), 1_000_000);
  assert.equal(lastReview.request.agent, "claude-code", "the phone sees which agent asked");

  // The agent builds its own transaction using the wallet address it was given.
  const to2 = newAddress();
  const built = await buildRawTransfer({ rpc: rpcUrl, from: wallet.content[0].text, to: to2, lamports: 2_000_000 });
  const raw = await client.callTool({
    name: "request_transaction",
    arguments: { transactionBase64: built.transactionBase64 },
  });
  assert.ok(!raw.isError);
  assert.equal(rpc.balance(to2), 2_000_000);

  choice = "deny";
  const denied = await client.callTool({ name: "request_transfer", arguments: { to: newAddress(), sol: 0.5 } });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /^DENIED by the user/);

  await client.close();
});

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "agent/request.js"), ...args], {
      env: { ...process.env, ...env },
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => resolve({ code, output }));
  });
}

test("the agent command-line script works for both request styles", async () => {
  let choice = "approve";
  const { phone } = startPhone({ decide: async () => choice });
  await phoneOnline();
  const common = ["--relay", relayUrl, "--rpc", rpcUrl, "--timeout", "20"];

  const to1 = newAddress();
  const transfer = await runCli(["transfer", "--to", to1, "--sol", "0.001", ...common]);
  assert.equal(transfer.code, 0, transfer.output);
  assert.match(transfer.output, /APPROVED after [\d.]+s\nsignature: /);
  assert.equal(rpc.balance(to1), 1_000_000);

  const to2 = newAddress();
  const raw = await runCli(["raw", "--to", to2, "--sol", "0.002", ...common]);
  assert.equal(raw.code, 0, raw.output);
  assert.match(raw.output, /Built an unsigned transaction/);
  assert.equal(rpc.balance(to2), 2_000_000);

  choice = "deny";
  const denied = await runCli(["transfer", "--to", newAddress(), "--sol", "0.001", ...common]);
  assert.equal(denied.code, 1);
  assert.match(denied.output, /DENIED after/);

  const usage = await runCli(["transfer", "--sol", "0.001", ...common]);
  assert.equal(usage.code, 2);
});
