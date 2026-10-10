"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Keypair } = require("@solana/web3.js");
const { STEPS, validateRecipient, selectSteps, runDemo, parseArgs } = require("../scripts/demo-video");

const recipient = Keypair.generate().publicKey.toBase58();

test("recipient must be set and be a valid address", () => {
  assert.throws(() => validateRecipient(""), /NOD_DEMO_RECIPIENT is not set/);
  assert.throws(() => validateRecipient("nope"), /not a valid Solana address/);
  assert.equal(validateRecipient(recipient), recipient);
});

test("the three steps are the ones the video needs", () => {
  const [a, b, c] = STEPS;
  assert.deepEqual([a.agent, a.sol], ["Research agent", 0.002]);
  assert.deepEqual([b.agent, b.sol, b.note], ["Trading agent", 0.03, "tiny 0.001 SOL test payment"]);
  assert.equal(c.sol, 0.001);
});

test("--only picks steps and rejects unknown ones", () => {
  assert.deepEqual(selectSteps("a,c").map((s) => s.id), ["a", "c"]);
  assert.equal(selectSteps(undefined).length, 3);
  assert.throws(() => selectSteps("z"), /--only/);
  assert.deepEqual(parseArgs(["--only", "b"]), { only: "b" });
});

test("waits for Enter before each step and sends the right payloads", async () => {
  const events = [];
  const sent = [];
  const out = await runDemo({
    relay: "http://r",
    token: "t",
    recipient,
    ask: async () => events.push("enter"),
    log: (line) => events.push(`log:${line}`),
    request: async ({ payload }) => {
      events.push("send");
      sent.push(payload);
      return { status: payload.lamports === 30_000_000 ? "denied" : "approved", result: { signature: "SIG" } };
    },
  });
  const order = events.filter((e) => e === "enter" || e === "send");
  assert.deepEqual(order, ["enter", "send", "enter", "send", "enter", "send"]);
  assert.deepEqual(sent.map((p) => p.lamports), [2_000_000, 30_000_000, 1_000_000]);
  assert.ok(sent.every((p) => p.type === "transfer" && p.to === recipient));
  assert.deepEqual(sent.map((p) => p.agent), ["Research agent", "Trading agent", "Payments agent"]);
  assert.equal(sent[1].note, "tiny 0.001 SOL test payment");
  assert.deepEqual(out.map((r) => r.status), ["approved", "denied", "approved"]);
});

test("a paused phone is reported and the demo carries on", async () => {
  const lines = [];
  const out = await runDemo({
    relay: "http://r",
    token: "t",
    recipient,
    steps: selectSteps("a"),
    ask: async () => {},
    log: (l) => lines.push(l),
    request: async () => {
      throw Object.assign(new Error("Approvals are paused on the phone"), { code: "paused" });
    },
  });
  assert.equal(out[0].status, "paused");
  assert.ok(lines.some((l) => l.includes("PAUSED")));
});

test("other errors stop the demo", async () => {
  await assert.rejects(
    runDemo({ relay: "r", token: "t", recipient, steps: selectSteps("a"), ask: async () => {}, log: () => {}, request: async () => { throw new Error("boom"); } }),
    /boom/
  );
});

test("npm run demo:video fails clearly without a recipient or pairing", () => {
  const { spawnSync } = require("node:child_process");
  const os = require("node:os");
  const path = require("node:path");
  const fs = require("node:fs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nod-dv-"));
  const env = { ...process.env, NOD_CONFIG_DIR: dir };
  delete env.NOD_DEMO_RECIPIENT;
  delete env.RELAY_TOKEN;
  const script = path.join(__dirname, "..", "scripts", "demo-video.js");
  const noRecipient = spawnSync(process.execPath, [script], { env, encoding: "utf8" });
  assert.equal(noRecipient.status, 2);
  assert.match(noRecipient.stderr, /NOD_DEMO_RECIPIENT is not set/);
  const noPairing = spawnSync(process.execPath, [script], { env: { ...env, NOD_DEMO_RECIPIENT: recipient }, encoding: "utf8" });
  assert.equal(noPairing.status, 2);
  assert.match(noPairing.stderr, /No saved pairing/);
  fs.rmSync(dir, { recursive: true, force: true });
});
