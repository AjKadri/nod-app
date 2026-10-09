"use strict";
/**
 * Pairing: who may talk to the relay, and what each side may do.
 * No chain is needed here, so the phone is a bare WebSocket.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const WebSocket = require("ws");

const { createRelay } = require("../relay/server");
const { createPairing, pairForTesting, pairingStatus, revokePairing } = require("../agent/pairing");
const {
  loadAgentCredentials,
  resolveAgentConnection,
  saveAgentCredentials,
} = require("../agent/credentials");
const {
  PairingError,
  buildPairingUrl,
  claimPairing,
  encodeBase64Url,
  parsePairingUrl,
  randomKey,
} = require("../shared/pairing");
const { createRelayClient } = require("../shared/relayClient");

const ROOT = path.join(__dirname, "..");
const TRANSFER = { type: "transfer", to: "11111111111111111111111111111111", lamports: 1, agent: "bot", note: "x" };

let relay;
let url;

before(async () => {
  relay = createRelay({ port: 0 });
  url = (await relay.listen()).url;
});

after(async () => {
  await relay.close();
});

const bearer = (token) => ({ "content-type": "application/json", authorization: `Bearer ${token}` });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, { timeoutMs = 5000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await wait(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Open the phone socket. Resolves { ws, messages } if accepted, { status } if refused. */
function connectPhone(base, token) {
  return new Promise((resolve) => {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/phone`, { headers });
    const messages = [];
    const closed = {};
    ws.on("message", (data) => messages.push(JSON.parse(String(data))));
    ws.on("close", (code) => (closed.code = code));
    ws.on("unexpected-response", (_req, res) => resolve({ status: res.statusCode }));
    ws.on("error", () => {});
    ws.on("open", () => resolve({ ws, messages, closed }));
  });
}

async function newPairing(base = url) {
  return pairForTesting({ relay: base });
}

function post(base, route, token, body) {
  return fetch(`${base}${route}`, {
    method: "POST",
    headers: token ? bearer(token) : { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

// ---------------------------------------------------------------- the link

test("pairing link: built, read back, and junk is refused", () => {
  const id = "a".repeat(22);
  const secret = "b".repeat(43);
  const link = buildPairingUrl({ relay: "http://localhost:8787", id, secret });
  assert.equal(link, `nod://pair?relay=http%3A%2F%2Flocalhost%3A8787&id=${id}&secret=${secret}`);
  assert.deepEqual(parsePairingUrl(link), { relay: "http://localhost:8787", id, secret });
  assert.deepEqual(parsePairingUrl(`  ${link}\n`).id, id, "whitespace from a paste is fine");

  for (const junk of [
    "",
    "https://example.com",
    "nod://pair?relay=http%3A%2F%2Fx&id=short&secret=short",
    `nod://pair?relay=ftp%3A%2F%2Fx&id=${id}&secret=${secret}`,
    `nod://pair?id=${id}&secret=${secret}`,
    `nod://send?relay=http%3A%2F%2Fx&id=${id}&secret=${secret}`,
    null,
  ]) {
    assert.throws(() => parsePairingUrl(junk), (err) => err instanceof PairingError && err.code === "invalid_code", String(junk));
  }
});

test("keys are 256 bits of base64url and the phone-safe encoder matches Node's", () => {
  const bytes = require("node:crypto").randomBytes(32);
  assert.equal(encodeBase64Url(bytes), bytes.toString("base64url"));
  assert.equal(encodeBase64Url(bytes.subarray(0, 5)), bytes.subarray(0, 5).toString("base64url"));
  const a = randomKey();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, randomKey());
});

// ---------------------------------------------------------------- strangers

test("an unpaired client cannot create requests, see the wallet or open the phone socket", async () => {
  const owner = await newPairing();
  const stranger = [
    undefined,
    "not-a-token",
    `${owner.id}.${"x".repeat(43)}`, // real pairing, wrong key
    `${"z".repeat(22)}.${"x".repeat(43)}`, // unknown pairing
  ];
  for (const token of stranger) {
    const headers = token ? bearer(token) : { "content-type": "application/json" };
    const label = String(token);
    assert.equal((await fetch(`${url}/requests`, { method: "POST", headers, body: JSON.stringify(TRANSFER) })).status, 401, label);
    assert.equal((await fetch(`${url}/wallet`, { headers })).status, 401, label);
    assert.equal((await fetch(`${url}/requests?status=pending`, { headers })).status, 401, label);
    assert.equal((await fetch(`${url}/pairing`, { headers })).status, 401, label);
    assert.equal((await fetch(`${url}/pairing`, { method: "DELETE", headers })).status, 401, label);
    assert.equal((await post(url, "/push-token", token, { token: "ExponentPushToken[x]" })).status, 401, label);
    assert.equal((await connectPhone(url, token)).status, 401, label);
  }
  // The owner is untouched by all of that.
  assert.equal((await pairingStatus({ relay: url, token: owner.agentToken })).state, "active");
  const health = await (await fetch(`${url}/health`)).json();
  assert.deepEqual(Object.keys(health).sort(), ["ok", "pending", "phones"], "health shows counts only");
});

test("an old query-string token no longer opens anything", async () => {
  const owner = await newPairing();
  const response = await fetch(`${url}/wallet?token=${encodeURIComponent(owner.agentToken)}`);
  assert.equal(response.status, 401);
});

// ---------------------------------------------------------------- roles

test("the agent key asks and the phone key answers; neither can do the other's job", async () => {
  const { agentToken, phoneToken } = await newPairing();

  // The agent cannot answer, cannot pose as the phone, cannot set the push token.
  const phone = await connectPhone(url, phoneToken);
  assert.ok(phone.ws, "the phone key opens the socket");
  assert.equal((await connectPhone(url, agentToken)).status, 403, "the agent key cannot open the phone socket");

  const created = await (await post(url, "/requests", agentToken, TRANSFER)).json();
  assert.equal(created.status, "pending");
  assert.equal(created.phonesOnline, 1);
  assert.equal((await post(url, `/requests/${created.id}/result`, agentToken, { status: "approved", signature: "fake" })).status, 403);
  assert.equal((await post(url, "/push-token", agentToken, { token: "ExponentPushToken[x]" })).status, 403);

  // The phone cannot ask, cannot read the wallet as an agent, cannot poll as one.
  assert.equal((await post(url, "/requests", phoneToken, TRANSFER)).status, 403);
  assert.equal((await fetch(`${url}/wallet`, { headers: bearer(phoneToken) })).status, 403);
  assert.equal((await fetch(`${url}/requests/${created.id}`, { headers: bearer(phoneToken) })).status, 403);
  assert.equal((await post(url, `/requests/${created.id}/cancel`, phoneToken)).status, 403);

  // The request reached the phone, and only the phone can settle it.
  await waitFor(() => phone.messages.some((m) => m.kind === "request" && m.request.id === created.id), { label: "request on the phone" });
  phone.ws.send(JSON.stringify({ kind: "hello", wallet: "WalletAddr1111111111111111111111111111111111" }));
  assert.equal((await post(url, `/requests/${created.id}/result`, phoneToken, { status: "approved", signature: "sig123" })).status, 200);
  const done = await (await fetch(`${url}/requests/${created.id}`, { headers: bearer(agentToken) })).json();
  assert.equal(done.status, "approved");
  assert.equal(done.result.signature, "sig123");
  assert.equal((await (await fetch(`${url}/wallet`, { headers: bearer(agentToken) })).json()).address, "WalletAddr1111111111111111111111111111111111");
  phone.ws.close();
});

// ---------------------------------------------------------------- claiming

test("a claim code works once, only for the right code, and a pending pairing cannot ask yet", async () => {
  const created = await createPairing({ relay: url, label: "Claim test" });

  // Not claimed yet: the agent key exists but nothing can be asked.
  assert.equal((await pairingStatus({ relay: url, token: created.agentToken })).state, "pending");
  assert.equal((await post(url, "/requests", created.agentToken, TRANSFER)).status, 409);
  assert.equal((await fetch(`${url}/wallet`, { headers: bearer(created.agentToken) })).status, 409);

  // Wrong code.
  const { id } = created;
  const wrong = await post(url, `/pairings/${id}/claim`, null, { claim: "w".repeat(43), phoneKey: randomKey() });
  assert.equal(wrong.status, 403);

  // Right code.
  const claimed = await claimPairing({ link: created.pairingUrl, fetchImpl: fetch });
  assert.equal(claimed.label, "Claim test");
  assert.equal(claimed.token.startsWith(`${id}.`), true);
  assert.equal((await pairingStatus({ relay: url, token: created.agentToken })).state, "active");

  // The same code again, from the same phone or a thief with a photo of the QR code.
  await assert.rejects(claimPairing({ link: created.pairingUrl, fetchImpl: fetch }), (err) => err.code === "used");
  // And an id that never existed.
  await assert.rejects(
    claimPairing({ link: buildPairingUrl({ relay: url, id: "q".repeat(22), secret: "s".repeat(43) }), fetchImpl: fetch }),
    (err) => err.code === "expired"
  );
});

test("an unclaimed pairing expires, and five wrong codes burn it", async () => {
  const short = createRelay({ port: 0, pairingTtlMs: 120 });
  const base = (await short.listen()).url;
  const stale = await createPairing({ relay: base });
  await wait(200);
  await assert.rejects(claimPairing({ link: stale.pairingUrl, fetchImpl: fetch }), (err) => err.code === "expired");
  await assert.rejects(pairingStatus({ relay: base, token: stale.agentToken }), (err) => err.status === 401);
  await short.close();

  const burned = await createPairing({ relay: url });
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await post(url, `/pairings/${burned.id}/claim`, null, { claim: "g".repeat(43), phoneKey: randomKey() })).status, 403);
  }
  await assert.rejects(claimPairing({ link: burned.pairingUrl, fetchImpl: fetch }), (err) => err.code === "expired");
});

test("claiming cannot reuse the agent key as the phone key", async () => {
  const created = await createPairing({ relay: url });
  const agentKey = created.agentToken.slice(created.id.length + 1);
  const { secret } = parsePairingUrl(created.pairingUrl);
  const response = await post(url, `/pairings/${created.id}/claim`, null, { claim: secret, phoneKey: agentKey });
  assert.equal(response.status, 400);
});

test("a relay can require a registration key before it creates pairings", async () => {
  const locked = createRelay({ port: 0, registrationKey: "let-me-in" });
  const base = (await locked.listen()).url;
  await assert.rejects(createPairing({ relay: base }), /401/);
  await assert.rejects(createPairing({ relay: base, registrationKey: "wrong" }), /401/);
  const ok = await createPairing({ relay: base, registrationKey: "let-me-in" });
  await claimPairing({ link: ok.pairingUrl, fetchImpl: fetch }); // claiming needs no registration key: the code is the proof
  await locked.close();
});

// ---------------------------------------------------------------- isolation

test("two pairings on one relay never see each other", async () => {
  const a = await newPairing();
  const b = await newPairing();
  const phoneA = await connectPhone(url, a.phoneToken);
  const phoneB = await connectPhone(url, b.phoneToken);
  assert.ok(phoneA.ws && phoneB.ws, "each pairing has its own phone, so B did not replace A");
  assert.equal(phoneA.closed.code, undefined);

  const created = await (await post(url, "/requests", a.agentToken, TRANSFER)).json();
  await waitFor(() => phoneA.messages.some((m) => m.kind === "request"), { label: "A's phone gets A's request" });
  await wait(150);
  assert.equal(phoneB.messages.filter((m) => m.kind === "request").length, 0, "B's phone gets nothing");

  // B cannot read, cancel or answer A's request, and the relay says it does not exist.
  assert.equal((await fetch(`${url}/requests/${created.id}`, { headers: bearer(b.agentToken) })).status, 404);
  assert.equal((await post(url, `/requests/${created.id}/cancel`, b.agentToken)).status, 404);
  assert.equal((await post(url, `/requests/${created.id}/result`, b.phoneToken, { status: "denied" })).status, 404);
  const listB = await (await fetch(`${url}/requests?status=pending`, { headers: bearer(b.phoneToken) })).json();
  assert.deepEqual(listB.requests, []);

  // A is unaffected.
  assert.equal((await post(url, `/requests/${created.id}/result`, a.phoneToken, { status: "denied" })).status, 200);
  phoneA.ws.close();
  phoneB.ws.close();
});

// ---------------------------------------------------------------- revoking

test("revoking from the phone cancels what is waiting, drops the socket and locks the agent out", async () => {
  const { agentToken, phoneToken } = await newPairing();
  const phone = await connectPhone(url, phoneToken);
  const created = await (await post(url, "/requests", agentToken, TRANSFER)).json();
  await waitFor(() => phone.messages.some((m) => m.kind === "request"), { label: "request on the phone" });

  const response = await fetch(`${url}/pairing`, { method: "DELETE", headers: bearer(phoneToken) });
  assert.equal(response.status, 200);

  await waitFor(() => phone.closed.code === 4001, { label: "phone socket closed with the revoked code" });
  assert.ok(phone.messages.some((m) => m.kind === "resolved" && m.id === created.id && m.status === "cancelled"));
  assert.equal((await fetch(`${url}/requests/${created.id}`, { headers: bearer(agentToken) })).status, 401);
  assert.equal((await post(url, "/requests", agentToken, TRANSFER)).status, 401);
  assert.equal((await connectPhone(url, phoneToken)).status, 401);
});

test("revoking from the laptop locks the phone out too", async () => {
  const { agentToken, phoneToken } = await newPairing();
  await revokePairing({ relay: url, token: agentToken });
  assert.equal((await fetch(`${url}/requests?status=pending`, { headers: bearer(phoneToken) })).status, 401);
  assert.equal((await post(url, "/requests", agentToken, TRANSFER)).status, 401);
});

test("the phone client reports 'revoked' whether it was online or offline when it happened", async () => {
  // Online: the relay closes the socket with the revoked code.
  const online = await newPairing();
  const seen = [];
  const client = createRelayClient({
    baseUrl: url,
    token: online.phoneToken,
    WebSocketImpl: WebSocket,
    fetchImpl: fetch,
    reconnectMs: 50,
    onStatus: (status) => seen.push(status),
  });
  await waitFor(() => seen.includes("online"), { label: "client online" });
  await revokePairing({ relay: url, token: online.agentToken });
  await waitFor(() => seen.includes("revoked"), { label: "client told it was revoked" });
  client.close();

  // Offline: it only finds out when it tries to come back.
  const offline = await newPairing();
  await revokePairing({ relay: url, token: offline.agentToken });
  const seen2 = [];
  const late = createRelayClient({
    baseUrl: url,
    token: offline.phoneToken,
    WebSocketImpl: WebSocket,
    fetchImpl: fetch,
    reconnectMs: 50,
    onStatus: (status) => seen2.push(status),
  });
  await waitFor(() => seen2.includes("revoked"), { label: "late client told it was revoked" });
  const count = seen2.length;
  await wait(200);
  assert.equal(seen2.length, count, "and it stops retrying");
  late.close();
});

// ---------------------------------------------------------------- persistence

test("pairings survive a relay restart, and the file holds hashes, never keys", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nod-relay-"));
  const file = path.join(dir, "pairings.json");
  const first = createRelay({ port: 0, pairingsFile: file });
  const base1 = (await first.listen()).url;
  const paired = await pairForTesting({ relay: base1, label: "Saved laptop" });
  await first.close();

  const text = fs.readFileSync(file, "utf8");
  const agentKey = paired.agentToken.slice(paired.id.length + 1);
  const phoneKey = paired.phoneToken.slice(paired.id.length + 1);
  assert.ok(!text.includes(agentKey) && !text.includes(phoneKey), "no raw key on disk");
  assert.equal(fs.statSync(file).mode & 0o077, 0, "only the owner can read it");

  const second = createRelay({ port: 0, pairingsFile: file });
  const base2 = (await second.listen()).url;
  const status = await pairingStatus({ relay: base2, token: paired.agentToken });
  assert.equal(status.state, "active");
  assert.equal(status.label, "Saved laptop");
  const phone = await connectPhone(base2, paired.phoneToken);
  assert.ok(phone.ws, "the phone key still works");
  phone.ws.close();
  await revokePairing({ relay: base2, token: paired.agentToken });
  await second.close();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).pairings, [], "a revoked pairing is gone from disk");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- the laptop's saved key

test("the saved agent key is only ever sent to the relay it was paired with", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nod-cfg-"));
  const env = { NOD_CONFIG_DIR: dir };
  assert.equal(loadAgentCredentials(env), null);
  assert.deepEqual(resolveAgentConnection({ env }), { relay: "http://localhost:8787", token: "" });

  const file = saveAgentCredentials({ relay: "https://relay.example/", token: "id.key", id: "id", label: "L" }, env);
  assert.equal(fs.statSync(file).mode & 0o077, 0);
  assert.deepEqual(resolveAgentConnection({ env }), { relay: "https://relay.example", token: "id.key" });
  assert.deepEqual(resolveAgentConnection({ env, relayArg: "https://relay.example" }).token, "id.key");
  assert.deepEqual(resolveAgentConnection({ env: { ...env, RELAY_URL: "https://elsewhere.example" } }), {
    relay: "https://elsewhere.example",
    token: "",
  });
  assert.equal(resolveAgentConnection({ env: { ...env, RELAY_TOKEN: "env.token" } }).token, "env.token");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- the pairing command

function runPair(args, env) {
  const child = spawn(process.execPath, [path.join(ROOT, "agent/pair.js"), ...args], {
    env: { ...process.env, ...env },
  });
  const state = { output: "", code: undefined };
  child.stdout.on("data", (chunk) => (state.output += chunk));
  child.stderr.on("data", (chunk) => (state.output += chunk));
  state.done = new Promise((resolve) =>
    child.on("close", (code) => {
      state.code = code;
      resolve(state);
    })
  );
  state.child = child;
  return state;
}

test("`pair.js` shows a link, waits for the phone, saves the agent key, and can revoke", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nod-cli-"));
  const env = { NOD_CONFIG_DIR: dir };

  const pairing = runPair(["--relay", url, "--label", "CLI laptop"], env);
  const link = await waitFor(() => (pairing.output.match(/nod:\/\/pair\?\S+/) || [])[0], { label: "pairing link printed" });
  assert.equal(loadAgentCredentials(env), null, "nothing is saved before the phone scans");

  await claimPairing({ link, fetchImpl: fetch });
  await pairing.done;
  assert.equal(pairing.code, 0, pairing.output);
  assert.match(pairing.output, /Paired\./);

  const saved = loadAgentCredentials(env);
  assert.equal(saved.relay, url);
  assert.equal(saved.label, "CLI laptop");
  assert.equal(fs.statSync(path.join(dir, "agent.json")).mode & 0o077, 0);
  assert.equal((await pairingStatus({ relay: url, token: saved.token })).state, "active");

  const status = runPair(["--status"], env);
  await status.done;
  assert.match(status.output, /active, phone offline/);

  const revoke = runPair(["--revoke"], env);
  await revoke.done;
  assert.equal(revoke.code, 0, revoke.output);
  assert.equal(loadAgentCredentials(env), null);
  await assert.rejects(pairingStatus({ relay: url, token: saved.token }), (err) => err.status === 401);

  const after = runPair(["--status"], env);
  await after.done;
  assert.equal(after.code, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("`pair.js` refuses plain http to a relay that is not on this machine", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nod-cli-"));
  const run = runPair(["--relay", "http://relay.example.com"], { NOD_CONFIG_DIR: dir });
  await run.done;
  assert.equal(run.code, 1);
  assert.match(run.output, /plain http/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the phone can refuse a relay that is not HTTPS before sending anything", async () => {
  const created = await createPairing({ relay: url });
  let called = false;
  const spy = async () => {
    called = true;
    throw new Error("must not be called");
  };
  await assert.rejects(
    claimPairing({ link: created.pairingUrl, fetchImpl: spy, allowInsecure: false }),
    (err) => err instanceof PairingError && err.code === "insecure_relay",
  );
  assert.equal(called, false, "nothing may be sent to an http relay");
  // The default stays permissive so the laptop tools and tests keep working locally.
  const claimed = await claimPairing({ link: created.pairingUrl, fetchImpl: fetch });
  assert.equal(claimed.id, created.id);
});
