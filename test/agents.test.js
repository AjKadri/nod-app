"use strict";
/**
 * Task 4: many agents, one inbox, and "Pause everything".
 * No chain is needed: the phone is the relay's own HTTP/WebSocket API.
 */
const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const WebSocket = require("ws");

const { createRelay } = require("../relay/server");
const { pairForTesting } = require("../agent/pairing");
const { createRelayClient } = require("../shared/relayClient");
const { ICON_PRESETS, cleanAgentIcon, cleanAgentName, describeAgent } = require("../shared/agent");
const { groupByDay } = require("../shared/group");

const ROOT = path.join(__dirname, "..");
const TO = "11111111111111111111111111111111";
const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function start(options = {}) {
  const relay = createRelay({ port: 0, ...options });
  const { url } = await relay.listen();
  cleanups.push(() => relay.close());
  return { relay, url };
}

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nod-agents-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const bearer = (token) => ({ "content-type": "application/json", authorization: `Bearer ${token}` });
const post = (url, token, body) => fetch(url, { method: "POST", headers: bearer(token), body: JSON.stringify(body) });
const pending = async (url, token) => (await (await fetch(`${url}/requests?status=pending`, { headers: bearer(token) })).json()).requests;

async function waitFor(check, { timeoutMs = 5000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// ---------------------------------------------------------------- names and icons

test("an agent's name is cleaned: one plain line, 60 characters, nothing hidden", () => {
  assert.equal(cleanAgentName("  Claude   Code "), "Claude Code");
  assert.equal(cleanAgentName(undefined), "Unnamed agent");
  assert.equal(cleanAgentName("   "), "Unnamed agent");
  assert.equal(cleanAgentName(42), "Unnamed agent");
  assert.equal(cleanAgentName("a".repeat(100)).length, 60);
  // Text-direction overrides and zero-width characters cannot make one name pass as another.
  const rtl = String.fromCharCode(0x202e);
  const zero = String.fromCharCode(0x200b);
  assert.equal(cleanAgentName(`Cur${rtl}sor`), "Cur sor");
  assert.equal(cleanAgentName(`Cur${zero}sor`), "Cur sor");
  assert.equal(cleanAgentName("line one\nline two\u0007"), "line one line two");
  // Never splits an emoji in half when shortening.
  const robots = String.fromCodePoint(0x1f916).repeat(70);
  assert.equal(Array.from(cleanAgentName(robots)).length, 60);
});

test("an agent's icon is a preset or one emoji, and never anything that could be fetched or read as text", () => {
  for (const name of ICON_PRESETS) assert.deepEqual(cleanAgentIcon(name), { kind: "preset", name });
  assert.deepEqual(cleanAgentIcon("  Terminal "), { kind: "preset", name: "terminal" });
  const robot = String.fromCodePoint(0x1f916);
  assert.deepEqual(cleanAgentIcon(robot), { kind: "emoji", value: robot });
  const coder = String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb);
  assert.deepEqual(cleanAgentIcon(coder), { kind: "emoji", value: coder });

  for (const bad of [
    "https://example.com/icon.png",
    "data:image/png;base64,AAAA",
    "//evil.test/x",
    "OK",
    "Verified",
    "1",
    "<b>",
    "",
    "   ",
    robot.repeat(9),
    String.fromCodePoint(0x200d),
    `${robot}x`,
    null,
    undefined,
    7,
    {},
  ]) {
    assert.equal(cleanAgentIcon(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test("name and icon are read from the request payload together", () => {
  assert.deepEqual(describeAgent({ agent: "Cursor", agentIcon: "code" }), { name: "Cursor", icon: { kind: "preset", name: "code" } });
  assert.deepEqual(describeAgent({}), { name: "Unnamed agent", icon: null });
  assert.deepEqual(describeAgent(null), { name: "Unnamed agent", icon: null });
});

// ---------------------------------------------------------------- grouping by time

test("history is grouped Today, Yesterday, Earlier, newest first, with empty groups left out", () => {
  const now = new Date(2026, 9, 9, 15, 0, 0).getTime(); // Fri 9 Oct 2026, 15:00 local time
  const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute, 0).getTime();
  const entries = [
    { id: "two-days", at: at(7, 12) },
    { id: "today-early", at: at(9, 0, 0) },
    { id: "yesterday-late", at: at(8, 23, 59) },
    { id: "today-late", at: at(9, 14) },
    { id: "yesterday-early", at: at(8, 0, 0) },
    { id: "last-week", at: at(1, 9) },
  ];
  const groups = groupByDay(entries, now, (entry) => entry.at);
  assert.deepEqual(groups.map((g) => g.label), ["Today", "Yesterday", "Earlier"]);
  assert.deepEqual(groups[0].entries.map((e) => e.id), ["today-late", "today-early"]);
  assert.deepEqual(groups[1].entries.map((e) => e.id), ["yesterday-late", "yesterday-early"]);
  assert.deepEqual(groups[2].entries.map((e) => e.id), ["two-days", "last-week"]);

  assert.deepEqual(groupByDay([{ at: at(9, 8) }], now, (e) => e.at).map((g) => g.label), ["Today"]);
  assert.deepEqual(groupByDay([], now, (e) => e.at), []);
});

// ---------------------------------------------------------------- the relay

test("the relay keeps an agent's name short and drops an icon it cannot be", async () => {
  const { url } = await start();
  const pair = await pairForTesting({ relay: url });
  const make = async (extra) => (await (await post(`${url}/requests`, pair.agentToken, { type: "transfer", to: TO, lamports: 1, ...extra })).json());
  const long = await make({ agent: "x".repeat(200), agentIcon: "code" });
  assert.equal(long.payload.agent.length, 60);
  assert.equal(long.payload.agentIcon, "code");
  const odd = await make({ agent: { evil: true }, agentIcon: "x".repeat(100) });
  assert.equal("agent" in odd.payload, false);
  assert.equal("agentIcon" in odd.payload, false);
  const numeric = await make({ agentIcon: 5 });
  assert.equal("agentIcon" in numeric.payload, false);
});

test("pause: only the phone can switch it, and the laptop sees it", async () => {
  const { url } = await start();
  const pair = await pairForTesting({ relay: url });
  assert.equal((await post(`${url}/pause`, pair.agentToken, { paused: true })).status, 403, "an agent must not be able to pause or unpause itself");
  assert.equal((await post(`${url}/pause`, pair.phoneToken, { paused: "yes" })).status, 400);
  assert.equal((await post(`${url}/pause`, pair.phoneToken, {})).status, 400);

  const paused = await post(`${url}/pause`, pair.phoneToken, { paused: true });
  assert.deepEqual(await paused.json(), { paused: true });
  for (const token of [pair.agentToken, pair.phoneToken]) {
    assert.equal((await (await fetch(`${url}/pairing`, { headers: bearer(token) })).json()).paused, true);
  }
});

test("pause: new requests are refused with 423 and a plain message, and nothing reaches the phone", async () => {
  const { url } = await start();
  const pair = await pairForTesting({ relay: url });
  await post(`${url}/pause`, pair.phoneToken, { paused: true });

  const refused = await post(`${url}/requests`, pair.agentToken, { type: "transfer", to: TO, lamports: 1, agent: "Cursor" });
  assert.equal(refused.status, 423);
  const body = await refused.json();
  assert.equal(body.code, "paused");
  assert.match(body.error, /paused all approvals/i);
  assert.equal((await pending(url, pair.phoneToken)).length, 0);
  assert.equal((await (await fetch(`${url}/requests`, { headers: bearer(pair.phoneToken) })).json()).requests.length, 0);
});

test("pause: what was already waiting can still be answered, and unpausing lets new requests in", async () => {
  const { url } = await start();
  const pair = await pairForTesting({ relay: url });
  const early = await (await post(`${url}/requests`, pair.agentToken, { type: "transfer", to: TO, lamports: 1, agent: "Early" })).json();
  await post(`${url}/pause`, pair.phoneToken, { paused: true });

  assert.equal((await pending(url, pair.phoneToken)).length, 1, "the earlier request is still there");
  const answered = await post(`${url}/requests/${early.id}/result`, pair.phoneToken, { status: "denied", reason: "no" });
  assert.equal(answered.status, 200);

  assert.equal((await post(`${url}/requests`, pair.agentToken, { type: "transfer", to: TO, lamports: 1 })).status, 423);
  await post(`${url}/pause`, pair.phoneToken, { paused: false });
  const after = await post(`${url}/requests`, pair.agentToken, { type: "transfer", to: TO, lamports: 1, agent: "Later" });
  assert.equal(after.status, 201);
  assert.equal((await after.json()).status, "pending");
});

test("pause: it lasts through a restart, because an emergency stop must not undo itself", async () => {
  const stateFile = path.join(tempDir(), "state.json");
  const first = await start({ stateFile });
  const pair = await pairForTesting({ relay: first.url });
  await post(`${first.url}/pause`, pair.phoneToken, { paused: true });
  await first.relay.close();

  const second = await start({ stateFile });
  assert.equal((await post(`${second.url}/requests`, pair.agentToken, { type: "transfer", to: TO, lamports: 1 })).status, 423);
  assert.equal((await (await fetch(`${second.url}/pairing`, { headers: bearer(pair.phoneToken) })).json()).paused, true);
});

test("pause: one pairing's pause does not touch another's", async () => {
  const { url } = await start();
  const one = await pairForTesting({ relay: url });
  const two = await pairForTesting({ relay: url });
  await post(`${url}/pause`, one.phoneToken, { paused: true });
  assert.equal((await post(`${url}/requests`, one.agentToken, { type: "transfer", to: TO, lamports: 1 })).status, 423);
  assert.equal((await post(`${url}/requests`, two.agentToken, { type: "transfer", to: TO, lamports: 1 })).status, 201);
});

test("pause: the phone is told when it connects and whenever it changes", async () => {
  const { url } = await start();
  const pair = await pairForTesting({ relay: url });
  await post(`${url}/pause`, pair.phoneToken, { paused: true });

  const messages = [];
  const ws = new WebSocket(`${url.replace(/^http/, "ws")}/phone`, { headers: { authorization: `Bearer ${pair.phoneToken}` } });
  cleanups.push(async () => ws.terminate());
  ws.on("message", (data) => messages.push(JSON.parse(String(data))));
  await waitFor(() => messages.length >= 1, { label: "first message" });
  assert.equal(messages[0].kind, "pending");
  assert.equal(messages[0].paused, true);

  await post(`${url}/pause`, pair.phoneToken, { paused: false });
  await waitFor(() => messages.some((m) => m.kind === "paused" && m.paused === false), { label: "resume message" });
  // Saying the same thing twice is not news.
  const before = messages.length;
  await post(`${url}/pause`, pair.phoneToken, { paused: false });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(messages.length, before);
});

test("the phone's relay client reports the pause state and can change it", async () => {
  const { url } = await start();
  const pair = await pairForTesting({ relay: url });
  const seen = [];
  const client = createRelayClient({
    baseUrl: url,
    token: pair.phoneToken,
    WebSocketImpl: WebSocket,
    fetchImpl: fetch,
    onPaused: (paused) => seen.push(paused),
  });
  cleanups.push(async () => client.close());

  await waitFor(() => seen.length >= 1, { label: "initial state" });
  assert.deepEqual(seen, [false]);
  assert.equal(await client.setPaused(true), true);
  assert.equal((await post(`${url}/requests`, pair.agentToken, { type: "transfer", to: TO, lamports: 1 })).status, 423);
  assert.equal(await client.setPaused(false), false);
  assert.equal(seen.at(-1), false);
  assert.ok(seen.includes(true));
});

test("the relay client says so when the relay could not pause", async () => {
  const { url } = await start();
  const pair = await pairForTesting({ relay: url });
  const client = createRelayClient({ baseUrl: url, token: `${pair.id}.${"k".repeat(43)}`, WebSocketImpl: WebSocket, fetchImpl: fetch, reconnectMs: 60_000 });
  cleanups.push(async () => client.close());
  await assert.rejects(client.setPaused(true), /refused to pause \(401\)/);
});

// ---------------------------------------------------------------- real MCP servers

function mcpClient(env) {
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
  const client = new Client({ name: "test-agent", version: "0.0.1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, "agent/mcp-server.js")],
    env: { ...process.env, NOD_CONFIG_DIR: tempDir(), APPROVAL_TIMEOUT_SECONDS: "20", ...env },
  });
  cleanups.push(() => client.close().catch(() => {}));
  return client.connect(transport).then(() => client);
}

test("two agents with different names show up as distinct requests; pause blocks both; unpause resumes", async () => {
  const { url } = await start();
  const pair = await pairForTesting({ relay: url });
  const connection = { RELAY_URL: url, RELAY_TOKEN: pair.agentToken };
  const claude = await mcpClient({ ...connection, AGENT_NAME: "Claude Code", AGENT_ICON: "code" });
  const cursor = await mcpClient({ ...connection, AGENT_NAME: "Cursor", AGENT_ICON: String.fromCodePoint(0x1f916) });
  const ask = (client, note) => client.callTool({ name: "request_transfer", arguments: { to: TO, sol: 0.001, note } });

  // Both ask at once; the phone sees two rows, each with its own name and icon.
  const claudeCall = ask(claude, "from claude");
  const cursorCall = ask(cursor, "from cursor");
  const rows = await waitFor(async () => {
    const found = await pending(url, pair.phoneToken);
    return found.length === 2 ? found : null;
  }, { label: "two requests on the phone" });
  const byAgent = Object.fromEntries(rows.map((row) => [row.payload.agent, row]));
  assert.deepEqual(Object.keys(byAgent).sort(), ["Claude Code", "Cursor"]);
  assert.equal(byAgent["Claude Code"].payload.agentIcon, "code");
  assert.equal(byAgent.Cursor.payload.agentIcon, String.fromCodePoint(0x1f916));
  assert.notEqual(byAgent["Claude Code"].id, byAgent.Cursor.id);

  for (const row of rows) await post(`${url}/requests/${row.id}/result`, pair.phoneToken, { status: "denied", reason: "test" });
  for (const result of await Promise.all([claudeCall, cursorCall])) {
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^DENIED by the user/);
  }

  // Pause: both are stopped at once, told why, and nothing is queued.
  assert.equal((await post(`${url}/pause`, pair.phoneToken, { paused: true })).status, 200);
  for (const client of [claude, cursor]) {
    const blocked = await ask(client, "while paused");
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /^PAUSED: .*paused all approvals/i);
    assert.match(blocked.content[0].text, /Do not retry/);
  }
  assert.equal((await pending(url, pair.phoneToken)).length, 0);

  // Unpause: asking works again.
  assert.equal((await post(`${url}/pause`, pair.phoneToken, { paused: false })).status, 200);
  const resumed = ask(cursor, "after unpause");
  const [row] = await waitFor(async () => {
    const found = await pending(url, pair.phoneToken);
    return found.length === 1 ? found : null;
  }, { label: "request after unpause" });
  assert.equal(row.payload.agent, "Cursor");
  await post(`${url}/requests/${row.id}/result`, pair.phoneToken, { status: "denied", reason: "done" });
  assert.match((await resumed).content[0].text, /^DENIED/);
});

test("an MCP server with no AGENT_ICON sends only its name", async () => {
  const { url } = await start();
  const pair = await pairForTesting({ relay: url });
  const agent = await mcpClient({ RELAY_URL: url, RELAY_TOKEN: pair.agentToken, AGENT_NAME: "Plain agent" });
  const call = agent.callTool({ name: "request_transfer", arguments: { to: TO, sol: 0.001 } });
  const [row] = await waitFor(async () => {
    const found = await pending(url, pair.phoneToken);
    return found.length === 1 ? found : null;
  }, { label: "request" });
  assert.equal(row.payload.agent, "Plain agent");
  assert.equal("agentIcon" in row.payload, false);
  await post(`${url}/requests/${row.id}/result`, pair.phoneToken, { status: "denied" });
  await call;
});

test("the request script says PAUSED and exits with its own code", async () => {
  const { url } = await start();
  const pair = await pairForTesting({ relay: url });
  await post(`${url}/pause`, pair.phoneToken, { paused: true });
  const child = spawn(process.execPath, [path.join(ROOT, "agent/request.js"), "transfer", "--to", TO, "--sol", "0.001", "--agent", "Script"], {
    env: { PATH: process.env.PATH, NOD_CONFIG_DIR: tempDir(), RELAY_URL: url, RELAY_TOKEN: pair.agentToken },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 3);
  assert.match(output, /PAUSED:/);
});
