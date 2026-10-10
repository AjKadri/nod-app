"use strict";
/**
 * Task 8A: every request names its network, and the phone never signs for the wrong one.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Connection, Keypair, LAMPORTS_PER_SOL } = require("@solana/web3.js");

const { createRelay } = require("../relay/server");
const { pairForTesting } = require("../agent/pairing");
const { createLocalRpc } = require("../sim/local-rpc");
const { createSimPhone } = require("../sim/phone");
const { requestApproval } = require("../agent/client");
const { resolveNetwork } = require("../agent/credentials");
const { reviewRequest, approveRequest, validateRequest } = require("../shared/approval");
const { rpcChain } = require("../shared/chain");
const { NETWORKS, parseNetwork, networkMismatchMessage } = require("../shared/network");

let rpc;
let rpcUrl;
let relay;
let relayUrl;
let agentToken;
let phoneToken;
let connection;
const phones = new Set();

before(async () => {
  rpc = createLocalRpc({ port: 0 });
  rpcUrl = (await rpc.listen()).url;
  relay = createRelay({ port: 0 });
  relayUrl = (await relay.listen()).url;
  ({ agentToken, phoneToken } = await pairForTesting({ relay: relayUrl }));
  connection = new Connection(rpcUrl, "confirmed");
});

after(async () => {
  for (const phone of phones) phone.close();
  await relay.close();
  await rpc.close();
});

const newAddress = () => Keypair.generate().publicKey.toBase58();

async function waitFor(check, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test("network names: only devnet and mainnet are understood", () => {
  assert.equal(parseNetwork("devnet"), "devnet");
  assert.equal(parseNetwork(" Mainnet "), "mainnet");
  assert.equal(parseNetwork("mainnet-beta"), "mainnet");
  assert.equal(parseNetwork("solana:mainnet"), "mainnet");
  assert.equal(parseNetwork("testnet"), null);
  assert.equal(parseNetwork(""), null);
  assert.equal(parseNetwork(undefined), null);
  assert.equal(NETWORKS.mainnet.realMoney, true);
  assert.equal(NETWORKS.devnet.realMoney, false);
});

test("agent side: --network and NETWORK, default devnet, unknown names are errors", () => {
  assert.equal(resolveNetwork({ env: {} }), "devnet");
  assert.equal(resolveNetwork({ env: { NETWORK: "mainnet" } }), "mainnet");
  assert.equal(resolveNetwork({ env: { NETWORK: "devnet" }, arg: "mainnet" }), "mainnet", "the flag beats the env var");
  assert.throws(() => resolveNetwork({ env: { NETWORK: "mainet" } }), /Unknown network "mainet"/);
});

test("validateRequest keeps a known network and drops an unknown one", () => {
  const base = { type: "transfer", to: newAddress(), lamports: 1 };
  assert.equal(validateRequest({ ...base, network: "mainnet" }).network, "mainnet");
  assert.equal(validateRequest({ ...base, network: "solana:devnet" }).network, "devnet");
  assert.equal("network" in validateRequest({ ...base, network: "testnet" }), false);
  assert.equal("network" in validateRequest(base), false);
});

test("a request that does not say its network is refused", async () => {
  const wallet = Keypair.generate();
  rpc.airdrop(wallet.publicKey, LAMPORTS_PER_SOL);
  await assert.rejects(
    reviewRequest({
      payload: { type: "transfer", to: newAddress(), lamports: 1000 },
      walletAddress: wallet.publicKey.toBase58(),
      chain: rpcChain(connection, "devnet"),
    }),
    (err) => err.code === "wrong_network" && /does not say which network/.test(err.message) && /Nothing was signed/.test(err.message),
  );
});

test("a mainnet request on a devnet phone is refused with a clear reason, and nothing is signed", async () => {
  const wallet = Keypair.generate();
  rpc.airdrop(wallet.publicKey, LAMPORTS_PER_SOL);
  const chain = rpcChain(connection, "devnet");
  const payload = { type: "transfer", to: newAddress(), lamports: 1000, network: "mainnet" };
  await assert.rejects(
    reviewRequest({ payload, walletAddress: wallet.publicKey.toBase58(), chain }),
    (err) => err.code === "wrong_network" && err.message === networkMismatchMessage("mainnet", "devnet"),
  );
  let asked = false;
  await assert.rejects(
    approveRequest({ payload, walletAddress: wallet.publicKey.toBase58(), chain, signAndSend: async () => void (asked = true) }),
    (err) => err.code === "wrong_network",
  );
  assert.equal(asked, false, "the wallet was never asked to sign");
  assert.match(networkMismatchMessage("mainnet", "devnet"), /for Mainnet.*on Devnet/);
});

test("a devnet request on a mainnet phone is refused too", async () => {
  const chain = rpcChain(connection, "mainnet");
  await assert.rejects(
    reviewRequest({ payload: { type: "transfer", to: newAddress(), lamports: 1, network: "devnet" }, walletAddress: newAddress(), chain }),
    (err) => err.code === "wrong_network" && /for Devnet.*on Mainnet/.test(err.message),
  );
});

test("a chain that does not know its network refuses everything", async () => {
  const payload = { type: "transfer", to: newAddress(), lamports: 1, network: "devnet" };
  await assert.rejects(reviewRequest({ payload, walletAddress: newAddress(), chain: {} }), (err) => err.code === "no_network");
  await assert.rejects(
    reviewRequest({ payload, walletAddress: newAddress(), chain: { network: "devnet" } }),
    (err) => err.code === "no_network",
    "a chain that cannot verify itself is refused",
  );
});

test("an RPC server on the wrong cluster is caught by its genesis hash, even if the request matches", async () => {
  // A stand-in that says it is mainnet, while the phone is set to Devnet.
  const impostor = createLocalRpc({ port: 0, genesisHash: NETWORKS.mainnet.genesisHash });
  const url = (await impostor.listen()).url;
  try {
    const wallet = Keypair.generate();
    impostor.airdrop(wallet.publicKey, LAMPORTS_PER_SOL);
    const chain = rpcChain(new Connection(url, "confirmed"), "devnet");
    await assert.rejects(chain.verifyNetwork(), (err) => err.code === "wrong_cluster" && /Check the RPC address/.test(err.message));
    await assert.rejects(
      reviewRequest({ payload: { type: "transfer", to: newAddress(), lamports: 1000, network: "devnet" }, walletAddress: wallet.publicKey.toBase58(), chain }),
      (err) => err.code === "wrong_cluster",
    );
    let asked = false;
    await assert.rejects(
      approveRequest({
        payload: { type: "transfer", to: newAddress(), lamports: 1000, network: "devnet" },
        walletAddress: wallet.publicKey.toBase58(),
        chain,
        signAndSend: async () => void (asked = true),
      }),
      (err) => err.code === "wrong_cluster",
    );
    assert.equal(asked, false);
    // And the matching pair works.
    const ok = rpcChain(new Connection(url, "confirmed"), "mainnet");
    await ok.verifyNetwork();
  } finally {
    await impostor.close();
  }
});

test("an unreachable RPC server cannot be verified, so it is refused rather than trusted", async () => {
  const chain = rpcChain(new Connection("http://127.0.0.1:1", "confirmed"), "devnet");
  await assert.rejects(chain.verifyNetwork(), (err) => err.code === "network_unreachable");
});

test("end to end: the agent asks for mainnet, the devnet phone refuses, the agent is told why, no money moves", async () => {
  const keypair = Keypair.generate();
  rpc.airdrop(keypair.publicKey, LAMPORTS_PER_SOL);
  const phone = createSimPhone({ relayUrl, rpcUrl, keypair, token: phoneToken, decide: async () => "approve" });
  phones.add(phone);
  await waitFor(async () => (await (await fetch(`${relayUrl}/health`)).json()).phones > 0, "phone online");
  const to = newAddress();
  const outcome = await requestApproval({
    relay: relayUrl,
    token: agentToken,
    network: "mainnet",
    payload: { type: "transfer", to, lamports: 1_000_000, note: "pay" },
  });
  assert.equal(outcome.status, "failed");
  assert.match(outcome.result.reason, /for Mainnet.*on Devnet.*Nothing was signed/);
  assert.equal(rpc.balance(to), 0);
  assert.equal(rpc.balance(keypair.publicKey), LAMPORTS_PER_SOL);

  // The default is devnet, and that one goes through.
  const ok = await requestApproval({ relay: relayUrl, token: agentToken, payload: { type: "transfer", to, lamports: 1_000_000, note: "pay" } });
  assert.equal(ok.status, "approved");
  assert.equal(rpc.balance(to), 1_000_000);
});

test("the CLI refuses an unknown network before it contacts anything", () => {
  const script = path.join(__dirname, "..", "agent", "request.js");
  const result = spawnSync(process.execPath, [script, "transfer", "--to", newAddress(), "--sol", "0.1", "--network", "mainet"], { encoding: "utf8", env: { ...process.env, RELAY_URL: "http://127.0.0.1:1" } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown network "mainet"/);
});

test("saved network settings: only the exact word 'mainnet' selects mainnet, bad RPC addresses are dropped", () => {
  const { parseNetworkSettings, validateRpcUrl, rpcFor } = require("../shared/network");
  assert.deepEqual(parseNetworkSettings(""), { network: "devnet", rpc: {} });
  assert.deepEqual(parseNetworkSettings("{broken"), { network: "devnet", rpc: {} });
  assert.equal(parseNetworkSettings(JSON.stringify({ network: "Mainnet" })).network, "devnet");
  assert.equal(parseNetworkSettings(JSON.stringify({ network: "mainnet" })).network, "mainnet");
  const saved = parseNetworkSettings(
    JSON.stringify({ network: "mainnet", rpc: { devnet: "http://insecure.example", mainnet: "https://rpc.example.com/key" } }),
  );
  assert.deepEqual(saved.rpc, { mainnet: "https://rpc.example.com/key" });
  assert.equal(rpcFor("mainnet", saved), "https://rpc.example.com/key");
  assert.equal(rpcFor("devnet", saved), "https://api.devnet.solana.com", "public RPC by default");
  assert.equal(rpcFor("mainnet", undefined), "https://api.mainnet-beta.solana.com");
  assert.equal(validateRpcUrl("  https://a.example/x "), "https://a.example/x");
  for (const bad of ["http://a.example", "ftp://a.example", "not a url", "", "https://user:pw@a.example", 42, null]) {
    assert.equal(validateRpcUrl(bad), null, String(bad));
  }
});
