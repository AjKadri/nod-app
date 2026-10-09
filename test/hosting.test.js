"use strict";
/**
 * Running the relay for real: it survives a restart, it refuses to be hosted
 * without a registration key, and it only talks HTTPS when it is hosted.
 */
const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");

const { createRelay } = require("../relay/server");
const { createPairing, pairForTesting } = require("../agent/pairing");
const { claimPairing, parsePairingUrl } = require("../shared/pairing");

const TRANSFER = { type: "transfer", to: "11111111111111111111111111111111", lamports: 1, agent: "Research agent", note: "x" };
const KEY = "a-long-registration-key-0123456789";

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

function tempFile(name = "state.json") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nod-state-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, name);
}

async function start(options = {}) {
  const relay = createRelay({ port: 0, ...options });
  const { url } = await relay.listen();
  cleanups.push(() => relay.close());
  return { relay, url };
}

const bearer = (token, extra = {}) => ({ "content-type": "application/json", authorization: `Bearer ${token}`, ...extra });
const post = (url, token, body) => fetch(url, { method: "POST", headers: bearer(token), body: JSON.stringify(body) });

async function waitFor(check, { timeoutMs = 4000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Restart: close the relay and open a new one on the same file. */
async function restart(first, options) {
  await first.relay.close();
  return start(options);
}

async function fakeExpo(respond = () => ({ data: { status: "ok" } })) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      seen.push({ headers: req.headers, body: JSON.parse(data) });
      const reply = respond(seen.length);
      if (reply === "hang") return; // never answers
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => (server.closeAllConnections?.(), server.close(resolve))));
  return { seen, url: `http://127.0.0.1:${server.address().port}/send` };
}

// ---------------------------------------------------------------- survives a restart

test("a restart does not unpair the phone or the laptop", async () => {
  const stateFile = tempFile();
  const first = await start({ stateFile });
  const pair = await pairForTesting({ relay: first.url });

  const second = await restart(first, { stateFile });
  const asAgent = await fetch(`${second.url}/pairing`, { headers: bearer(pair.agentToken) });
  const asPhone = await fetch(`${second.url}/pairing`, { headers: bearer(pair.phoneToken) });
  assert.equal(asAgent.status, 200);
  assert.equal((await asAgent.json()).state, "active");
  assert.equal(asPhone.status, 200);
  assert.equal((await asPhone.json()).role, "phone");
});

test("a request waiting for approval is still waiting after a restart, and can still be answered", async () => {
  const stateFile = tempFile();
  const first = await start({ stateFile });
  const pair = await pairForTesting({ relay: first.url });
  const created = await (await post(`${first.url}/requests`, pair.agentToken, TRANSFER)).json();
  assert.equal(created.status, "pending");

  const second = await restart(first, { stateFile });
  const listed = await (await fetch(`${second.url}/requests?status=pending`, { headers: bearer(pair.phoneToken) })).json();
  assert.deepEqual(listed.requests.map((r) => r.id), [created.id]);
  assert.equal(listed.requests[0].payload.agent, "Research agent");

  // The phone reconnecting is told about it, as it would be on a normal start.
  const ws = new WebSocket(`${second.url.replace(/^http/, "ws")}/phone`, { headers: { authorization: `Bearer ${pair.phoneToken}` } });
  cleanups.push(async () => ws.terminate());
  const first_message = await new Promise((resolve) => ws.once("message", (data) => resolve(JSON.parse(String(data)))));
  assert.equal(first_message.kind, "pending");
  assert.equal(first_message.requests[0].id, created.id);

  const answered = await post(`${second.url}/requests/${created.id}/result`, pair.phoneToken, { status: "approved", signature: "sig123" });
  assert.equal(answered.status, 200);
  const asked = await (await fetch(`${second.url}/requests/${created.id}`, { headers: bearer(pair.agentToken) })).json();
  assert.equal(asked.status, "approved");
  assert.equal(asked.result.signature, "sig123");
});

test("an answer given before the restart is still there for the agent afterwards", async () => {
  const stateFile = tempFile();
  const first = await start({ stateFile });
  const pair = await pairForTesting({ relay: first.url });
  const created = await (await post(`${first.url}/requests`, pair.agentToken, TRANSFER)).json();
  await post(`${first.url}/requests/${created.id}/result`, pair.phoneToken, { status: "denied", reason: "no" });

  const second = await restart(first, { stateFile });
  const asked = await (await fetch(`${second.url}/requests/${created.id}`, { headers: bearer(pair.agentToken) })).json();
  assert.equal(asked.status, "denied");
  assert.equal(asked.result.reason, "no");
});

test("a request that runs out while the relay is down is expired when it comes back", async () => {
  const stateFile = tempFile();
  const first = await start({ stateFile, requestTtlMs: 250 });
  const pair = await pairForTesting({ relay: first.url });
  const created = await (await post(`${first.url}/requests`, pair.agentToken, TRANSFER)).json();
  await first.relay.close();
  await new Promise((resolve) => setTimeout(resolve, 350));

  const second = await start({ stateFile, requestTtlMs: 250 });
  const asked = await (await fetch(`${second.url}/requests/${created.id}`, { headers: bearer(pair.agentToken) })).json();
  assert.equal(asked.status, "expired");
  const pending = await (await fetch(`${second.url}/requests?status=pending`, { headers: bearer(pair.phoneToken) })).json();
  assert.equal(pending.requests.length, 0);
});

test("a restored request still expires on time", async () => {
  const stateFile = tempFile();
  const first = await start({ stateFile, requestTtlMs: 700 });
  const pair = await pairForTesting({ relay: first.url });
  const created = await (await post(`${first.url}/requests`, pair.agentToken, TRANSFER)).json();
  const second = await restart(first, { stateFile, requestTtlMs: 700 });
  await waitFor(
    async () => (await (await fetch(`${second.url}/requests/${created.id}`, { headers: bearer(pair.agentToken) })).json()).status === "expired",
    { label: "expiry after restart" },
  );
});

test("a revoked pairing stays revoked after a restart", async () => {
  const stateFile = tempFile();
  const first = await start({ stateFile });
  const pair = await pairForTesting({ relay: first.url });
  await fetch(`${first.url}/pairing`, { method: "DELETE", headers: bearer(pair.phoneToken) });
  const second = await restart(first, { stateFile });
  assert.equal((await fetch(`${second.url}/pairing`, { headers: bearer(pair.agentToken) })).status, 401);
  assert.equal((await fetch(`${second.url}/pairing`, { headers: bearer(pair.phoneToken) })).status, 401);
});

test("the push token and wallet survive a restart", async () => {
  const stateFile = tempFile();
  const expo = await fakeExpo();
  const first = await start({ stateFile, expoPushUrl: expo.url });
  const pair = await pairForTesting({ relay: first.url });
  await post(`${first.url}/push-token`, pair.phoneToken, { token: "ExponentPushToken[abc]" });

  const second = await restart(first, { stateFile, expoPushUrl: expo.url });
  await post(`${second.url}/requests`, pair.agentToken, TRANSFER);
  await waitFor(() => expo.seen.length === 1, { label: "push after restart" });
  assert.equal(expo.seen[0].body.to, "ExponentPushToken[abc]");
});

test("an unclaimed pairing code still works after a restart, once", async () => {
  const stateFile = tempFile();
  const first = await start({ stateFile });
  const created = await createPairing({ relay: first.url });
  const second = await restart(first, { stateFile });
  const link = { ...parsePairingUrl(created.pairingUrl), relay: second.url };
  const claimed = await claimPairing({ link, fetchImpl: fetch });
  assert.equal(claimed.id, created.id);
  await assert.rejects(claimPairing({ link, fetchImpl: fetch }), /already used|expired/i);
});

// ---------------------------------------------------------------- what is on disk

test("the state file holds hashes, never the keys or the code that opens a pairing", async () => {
  const stateFile = tempFile();
  const { url } = await start({ stateFile });
  const created = await createPairing({ relay: url });
  const claimed = await claimPairing({ link: created.pairingUrl, fetchImpl: fetch });
  const agentKey = created.agentToken.split(".")[1];
  const phoneKey = claimed.token.split(".")[1];
  const secret = new URL(created.pairingUrl.replace("nod://", "http://")).searchParams.get("secret");
  assert.ok(agentKey && phoneKey && secret);

  const text = fs.readFileSync(stateFile, "utf8");
  for (const forbidden of [agentKey, phoneKey, secret]) {
    assert.equal(text.includes(forbidden), false, "a secret was written to the state file");
  }
  const data = JSON.parse(text);
  assert.match(data.pairings[0].agentKeyHash, /^[0-9a-f]{64}$/);
  assert.match(data.pairings[0].phoneKeyHash, /^[0-9a-f]{64}$/);
  assert.equal(data.pairings[0].claimHash, null, "the claim hash is dropped once the code is used");
});

test("the state file is private to the relay's user and no temp file is left behind", { skip: process.platform === "win32" }, async () => {
  const stateFile = tempFile();
  const { url } = await start({ stateFile });
  await pairForTesting({ relay: url });
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${stateFile}.tmp`), false);
});

test("a state file that cannot be read is kept aside, not overwritten", async () => {
  const stateFile = tempFile();
  fs.writeFileSync(stateFile, '{"version":2,"pairings":[{"id":"oops"');
  const { url } = await start({ stateFile });
  const aside = fs.readdirSync(path.dirname(stateFile)).filter((name) => name.includes(".corrupt-"));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(stateFile), aside[0]), "utf8"), '{"version":2,"pairings":[{"id":"oops"');
  // And it works as a fresh relay.
  const pair = await pairForTesting({ relay: url });
  assert.equal((await fetch(`${url}/pairing`, { headers: bearer(pair.agentToken) })).status, 200);
});

test("entries in the state file that are not well formed are ignored", async () => {
  const stateFile = tempFile();
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      version: 2,
      pairings: [
        { id: "short", agentKeyHash: "x" },
        { id: "A".repeat(22), agentKeyHash: "not-a-hash", state: "active" },
        { id: "B".repeat(22), agentKeyHash: "0".repeat(64), state: "active" }, // active but no phone key
      ],
    }),
  );
  const { url } = await start({ stateFile });
  const health = await (await fetch(`${url}/health`)).json();
  assert.equal(health.phones, 0);
  assert.equal((await fetch(`${url}/pairing`, { headers: bearer(`${"B".repeat(22)}.${"k".repeat(40)}`) })).status, 401);
});

test("old answers are forgotten: only the newest 100 are kept", async () => {
  const stateFile = tempFile();
  const { url } = await start({ stateFile });
  const pair = await pairForTesting({ relay: url });
  for (let i = 0; i < 104; i += 1) {
    const created = await (await post(`${url}/requests`, pair.agentToken, TRANSFER)).json();
    await post(`${url}/requests/${created.id}/cancel`, pair.agentToken, {});
  }
  const all = await (await fetch(`${url}/requests`, { headers: bearer(pair.phoneToken) })).json();
  assert.equal(all.requests.length, 100);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).pairings[0].requests.length, 100);
});

// ---------------------------------------------------------------- hosted mode

test("a relay on a public address will not start without a registration key", () => {
  assert.throws(() => createRelay({ host: "0.0.0.0", stateFile: tempFile() }), /RELAY_REGISTRATION_KEY is required/);
  assert.throws(() => createRelay({ host: "0.0.0.0", stateFile: tempFile(), registrationKey: "short" }), /at least 24/);
  assert.throws(() => createRelay({ host: "10.1.2.3", stateFile: tempFile(), registrationKey: "" }), /RELAY_REGISTRATION_KEY/);
});

test("a relay on a public address will not start without somewhere to keep its state", () => {
  assert.throws(() => createRelay({ host: "0.0.0.0", registrationKey: KEY }), /RELAY_STATE_FILE is required/);
});

test("a relay on a public address will not start if it cannot write its state", () => {
  const blocker = tempFile("blocker");
  fs.writeFileSync(blocker, "a file, not a folder");
  assert.throws(() => createRelay({ host: "0.0.0.0", registrationKey: KEY, stateFile: path.join(blocker, "state.json") }), /Cannot write the state file/);
});

test("localhost needs no registration key, so development stays easy", async () => {
  const { url } = await start({ host: "127.0.0.1" });
  const pair = await pairForTesting({ relay: url });
  assert.ok(pair.id);
});

test("on a public address, pairings can only be registered with the key", async () => {
  const { url } = await start({ host: "0.0.0.0", registrationKey: KEY, stateFile: tempFile(), requireHttps: false });
  const base = url.replace("127.0.0.1", "127.0.0.1");
  await assert.rejects(createPairing({ relay: base }), /401/);
  await assert.rejects(createPairing({ relay: base, registrationKey: `${KEY}x` }), /401/);
  const ok = await createPairing({ relay: base, registrationKey: KEY });
  assert.ok(ok.pairingUrl.startsWith("nod://pair?"));
});

test("with HTTPS required, plain requests are refused and proxied HTTPS ones work", async () => {
  const { url } = await start({ requireHttps: true });
  const body = JSON.stringify({ id: "A".repeat(22), agentKeyHash: "0".repeat(64), claimHash: "1".repeat(64) });
  const plain = await fetch(`${url}/pairings`, { method: "POST", headers: { "content-type": "application/json" }, body });
  assert.equal(plain.status, 403);
  assert.match((await plain.json()).error, /HTTPS/);
  const lying = await fetch(`${url}/pairings`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-proto": "http" }, body });
  assert.equal(lying.status, 403);
  const proxied = await fetch(`${url}/pairings`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-proto": "https" }, body });
  assert.equal(proxied.status, 201);
  // The host's health check runs inside the network and must still pass.
  assert.equal((await fetch(`${url}/health`)).status, 200);
});

test("with HTTPS required, the phone socket needs it too", async () => {
  const { url } = await start({ requireHttps: true });
  const pair = await pairForTesting({ relay: url.replace("http://", "http://"), label: "x" }).catch(() => null);
  assert.equal(pair, null, "pairing over plain http must fail when HTTPS is required");

  const plainRelay = await start({});
  const real = await pairForTesting({ relay: plainRelay.url });
  const secure = await start({ requireHttps: true, stateFile: tempFile() });
  // Same keys are unknown there; the point is the 403 before any key check.
  const outcome = await new Promise((resolve) => {
    const ws = new WebSocket(`${secure.url.replace(/^http/, "ws")}/phone`, { headers: { authorization: `Bearer ${real.phoneToken}` } });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode));
    ws.on("open", () => resolve("open"));
    ws.on("error", () => {});
  });
  assert.equal(outcome, 403);
});

test("a public relay does not tell strangers how busy it is", async () => {
  const { url } = await start({ publicStats: false });
  assert.deepEqual(await (await fetch(`${url}/health`)).json(), { ok: true });
});

// ---------------------------------------------------------------- push

test("the push names the agent and opens the right request, but never repeats the agent's note", async () => {
  const expo = await fakeExpo();
  const { url } = await start({ expoPushUrl: expo.url, expoAccessToken: "expo-secret" });
  const pair = await pairForTesting({ relay: url });
  await post(`${url}/push-token`, pair.phoneToken, { token: "ExponentPushToken[abc]" });
  const created = await (
    await post(`${url}/requests`, pair.agentToken, { ...TRANSFER, note: "tiny 0.001 SOL test payment", agent: "Research agent" })
  ).json();
  await waitFor(() => expo.seen.length === 1, { label: "push" });
  const { body, headers } = expo.seen[0];
  assert.equal(body.title, "Approval needed");
  assert.equal(body.body, "Research agent is waiting for your approval");
  assert.equal(JSON.stringify(body).includes("0.001"), false, "the agent's note must not reach the lock screen");
  assert.deepEqual(body.data, { requestId: created.id, pairingId: pair.id });
  assert.equal(body.channelId, "approvals");
  assert.equal(body.priority, "high");
  assert.ok(body.ttl > 0 && body.ttl <= 600, `ttl ${body.ttl}`);
  assert.equal(headers.authorization, "Bearer expo-secret");
});

test("with no agent name the push still says something plain", async () => {
  const expo = await fakeExpo();
  const { url } = await start({ expoPushUrl: expo.url });
  const pair = await pairForTesting({ relay: url });
  await post(`${url}/push-token`, pair.phoneToken, { token: "ExponentPushToken[abc]" });
  await post(`${url}/requests`, pair.agentToken, { type: "transfer", to: TRANSFER.to, lamports: 1 });
  await waitFor(() => expo.seen.length === 1, { label: "push" });
  assert.equal(expo.seen[0].body.body, "An agent is waiting for your approval");
});

test("a push token the phone no longer has is dropped", async () => {
  const expo = await fakeExpo(() => ({ data: { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } } }));
  const { url } = await start({ expoPushUrl: expo.url });
  const pair = await pairForTesting({ relay: url });
  await post(`${url}/push-token`, pair.phoneToken, { token: "ExponentPushToken[dead]" });
  await post(`${url}/requests`, pair.agentToken, TRANSFER);
  await waitFor(() => expo.seen.length === 1, { label: "first push" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await post(`${url}/requests`, pair.agentToken, TRANSFER);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(expo.seen.length, 1, "no second push to a dead token");
});

test("a push service that never answers does not hold up the request", async () => {
  const expo = await fakeExpo(() => "hang");
  const { url } = await start({ expoPushUrl: expo.url });
  const pair = await pairForTesting({ relay: url });
  await post(`${url}/push-token`, pair.phoneToken, { token: "ExponentPushToken[slow]" });
  const started = Date.now();
  const response = await post(`${url}/requests`, pair.agentToken, TRANSFER);
  assert.equal(response.status, 201);
  assert.ok(Date.now() - started < 2000);
});

test("only the phone can register a push token", async () => {
  const { url } = await start({});
  const pair = await pairForTesting({ relay: url });
  const asAgent = await post(`${url}/push-token`, pair.agentToken, { token: "ExponentPushToken[evil]" });
  assert.equal(asAgent.status, 403);
});
