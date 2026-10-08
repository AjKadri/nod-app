"use strict";
/**
 * Relay between agents and phones. Requests live in memory; pairings can be
 * saved to a file so they survive a restart.
 *
 *   Agent  --POST /requests-->  relay  --WebSocket /phone-->  phone
 *   Agent  <--result (long-poll)--  relay  <--POST /requests/:id/result--  phone
 *
 * Request statuses: pending -> approved | denied | failed (set by the phone),
 * expired (nobody answered in time) or cancelled (the agent gave up, or the
 * pairing was revoked).
 *
 * The relay only passes messages. It never sees a private key and cannot sign.
 * The phone re-validates everything it receives.
 *
 * PAIRING. Nothing works without one. Each pairing is one laptop and one phone,
 * and is isolated from every other pairing.
 *
 *   1. The laptop picks an id, an agent key and a one-time claim code, and
 *      registers only their SHA-256 hashes:  POST /pairings
 *      It shows the id and claim code to the phone as a QR code.
 *   2. The phone scans it, picks its own phone key and claims the pairing:
 *      POST /pairings/:id/claim  { claim, phoneKey }. The claim code works once
 *      and expires (default 10 minutes), so a photo of the QR code is useless
 *      afterwards.
 *   3. From then on every call carries  Authorization: Bearer <id>.<key>.
 *      The agent key may create and cancel requests. The phone key may answer
 *      them and open the phone socket. Neither can do the other's job, so an
 *      agent that leaks or misuses its key cannot approve its own requests.
 *
 * The relay stores hashes, never the keys. Over plain HTTP a key can be read by
 * anyone on the network path: use HTTPS anywhere but localhost.
 *
 * Run:  node relay/server.js
 * Env:  PORT, HOST, RELAY_PAIRINGS_FILE (default ./.relay-pairings.json),
 *       RELAY_REGISTRATION_KEY (if set, only holders can register pairings)
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const MAX_BODY_BYTES = 16 * 1024;
const MAX_WAIT_SECONDS = 120;
const MAX_PENDING = 50;
const MAX_PAIRINGS = 500;
const MAX_UNCLAIMED_PAIRINGS = 50;
const MAX_CLAIM_FAILURES = 5;
const FINAL_STATUSES = new Set(["approved", "denied", "failed"]);

const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const KEY_RE = /^[A-Za-z0-9_-]{32,128}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

// WebSocket close codes the phone understands.
const REPLACED_CODE = 4000;
const REVOKED_CODE = 4001;

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const NO_SUCH_PAIRING_HASH = sha256("nod: no such pairing");

function sameHash(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function createRelay({
  port = 8787,
  host = "127.0.0.1",
  requestTtlMs = 10 * 60 * 1000,
  pairingTtlMs = 10 * 60 * 1000,
  pairingsFile = "",
  registrationKey = "",
  expoPushUrl = "https://exp.host/--/api/v2/push/send",
  log = () => {},
} = {}) {
  /** @type {Map<string, any>} */
  const pairings = new Map();
  /** @type {Map<string, Set<Function>>} */
  const waiters = new Map();

  // ------------------------------------------------------------ pairings on disk

  function newPairing(base) {
    return {
      id: base.id,
      label: base.label || "Laptop",
      createdAt: base.createdAt || Date.now(),
      state: base.state === "active" ? "active" : "pending",
      agentKeyHash: base.agentKeyHash,
      phoneKeyHash: base.phoneKeyHash || null,
      claimHash: base.claimHash || null,
      claimExpiresAt: base.claimExpiresAt || 0,
      claimFailures: 0,
      walletAddress: base.walletAddress || null,
      pushToken: base.pushToken || null,
      requests: new Map(),
      phones: new Set(),
    };
  }

  function save() {
    if (!pairingsFile) return;
    const data = {
      version: 1,
      pairings: [...pairings.values()].map((p) => ({
        id: p.id,
        label: p.label,
        createdAt: p.createdAt,
        state: p.state,
        agentKeyHash: p.agentKeyHash,
        phoneKeyHash: p.phoneKeyHash,
        claimHash: p.claimHash,
        claimExpiresAt: p.claimExpiresAt,
        walletAddress: p.walletAddress,
        pushToken: p.pushToken,
      })),
    };
    try {
      const tmp = `${pairingsFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, pairingsFile);
    } catch (err) {
      log(`could not save pairings: ${err.message}`);
    }
  }

  function load() {
    if (!pairingsFile || !fs.existsSync(pairingsFile)) return;
    try {
      const data = JSON.parse(fs.readFileSync(pairingsFile, "utf8"));
      for (const entry of Array.isArray(data.pairings) ? data.pairings : []) {
        if (!entry || !ID_RE.test(entry.id) || !HASH_RE.test(entry.agentKeyHash)) continue;
        if (entry.phoneKeyHash && !HASH_RE.test(entry.phoneKeyHash)) continue;
        pairings.set(entry.id, newPairing(entry));
      }
      log(`loaded ${pairings.size} pairing(s) from ${pairingsFile}`);
    } catch (err) {
      log(`could not read ${pairingsFile}: ${err.message}`);
    }
  }
  load();

  /** The pairing, unless it was never claimed in time (then it is dropped). */
  function livePairing(id) {
    const pairing = pairings.get(id);
    if (!pairing) return null;
    if (pairing.state === "pending" && Date.now() > pairing.claimExpiresAt) {
      pairings.delete(id);
      save();
      return null;
    }
    return pairing;
  }

  function sweepUnclaimed() {
    for (const pairing of [...pairings.values()]) livePairing(pairing.id);
  }

  // ------------------------------------------------------------ requests

  function publicView(request) {
    const { timer, pairingId, ...rest } = request;
    return rest;
  }

  function pendingList(pairing) {
    return [...pairing.requests.values()].filter((r) => r.status === "pending").map(publicView);
  }

  function broadcast(pairing, message) {
    const text = JSON.stringify(message);
    for (const phone of pairing.phones) {
      if (phone.readyState === 1) phone.send(text);
    }
  }

  function settle(pairing, request, status, result) {
    if (request.status !== "pending") return false;
    request.status = status;
    request.result = result || null;
    request.resolvedAt = Date.now();
    if (request.timer) clearTimeout(request.timer);
    request.timer = null;
    const callbacks = waiters.get(request.id);
    if (callbacks) {
      waiters.delete(request.id);
      for (const callback of callbacks) callback();
    }
    broadcast(pairing, { kind: "resolved", id: request.id, status });
    log(`request ${request.id} -> ${status}`);
    return true;
  }

  function waitFor(request, seconds) {
    return new Promise((resolve) => {
      if (request.status !== "pending" || seconds <= 0) return resolve();
      const set = waiters.get(request.id) || new Set();
      waiters.set(request.id, set);
      const timeout = setTimeout(() => {
        set.delete(done);
        resolve();
      }, seconds * 1000);
      function done() {
        clearTimeout(timeout);
        resolve();
      }
      set.add(done);
    });
  }

  async function sendPush(pairing, request) {
    if (!pairing.pushToken) return;
    const body = {
      to: pairing.pushToken,
      title: "Approval needed",
      body:
        request.payload.note ||
        `An agent is asking to ${request.payload.type === "transfer" ? "send SOL" : "run a transaction"}`,
      data: { requestId: request.id },
      priority: "high",
      channelId: "approvals",
    };
    try {
      await fetch(expoPushUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      log(`push failed: ${err.message}`);
    }
  }

  /** Remove a pairing: cancel what is waiting, drop the phone, forget the keys. */
  function revoke(pairing, reason) {
    for (const request of pairing.requests.values()) settle(pairing, request, "cancelled", { reason });
    pairings.delete(pairing.id);
    for (const phone of pairing.phones) phone.close(REVOKED_CODE, "pairing revoked");
    pairing.phones.clear();
    save();
    log(`pairing ${pairing.id} revoked`);
  }

  // ------------------------------------------------------------ http helpers

  function send(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(text),
    });
    res.end(text);
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      let tooLarge = false;
      req.on("data", (chunk) => {
        if (tooLarge) return; // keep draining so the client can read our 413
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          tooLarge = true;
          chunks.length = 0;
          reject(Object.assign(new Error("Body too large"), { status: 413 }));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (tooLarge) return;
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
        } catch (_err) {
          reject(Object.assign(new Error("Body is not valid JSON"), { status: 400 }));
        }
      });
      req.on("error", reject);
    });
  }

  /** Who is calling? Reads `Authorization: Bearer <id>.<key>`. */
  function authenticate(req) {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) return null;
    const token = header.slice(7).trim();
    const dot = token.indexOf(".");
    if (dot < 1) return null;
    const id = token.slice(0, dot);
    const key = token.slice(dot + 1);
    if (!ID_RE.test(id) || !KEY_RE.test(key)) return null;
    const pairing = livePairing(id);
    const hash = sha256(key);
    // Compare even when the pairing is unknown, so timing does not reveal which ids exist.
    const agentOk = sameHash(hash, pairing ? pairing.agentKeyHash : NO_SUCH_PAIRING_HASH);
    const phoneOk = !!(pairing && pairing.phoneKeyHash) && sameHash(hash, pairing.phoneKeyHash);
    if (!pairing) return null;
    if (agentOk) return { pairing, role: "agent" };
    if (phoneOk) return { pairing, role: "phone" };
    return null;
  }

  function registrationOk(req) {
    if (!registrationKey) return true;
    const provided = req.headers["x-nod-registration-key"];
    return typeof provided === "string" && sameHash(sha256(provided), sha256(registrationKey));
  }

  function clampWait(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;
    return Math.min(seconds, MAX_WAIT_SECONDS);
  }

  const totalPhones = () => [...pairings.values()].reduce((sum, p) => sum + p.phones.size, 0);
  const totalPending = () => [...pairings.values()].reduce((sum, p) => sum + pendingList(p).length, 0);

  // ------------------------------------------------------------ routes

  async function handle(req, res) {
    const url = new URL(req.url, "http://relay.local");
    const route = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && route === "/health") {
      return send(res, 200, { ok: true, phones: totalPhones(), pending: totalPending() });
    }

    // ---- pairing: the only calls that need no key

    if (req.method === "POST" && route === "/pairings") {
      if (!registrationOk(req)) return send(res, 401, { error: "This relay needs a registration key to create pairings" });
      const body = await readJson(req);
      if (!ID_RE.test(String(body.id)) || !HASH_RE.test(String(body.agentKeyHash)) || !HASH_RE.test(String(body.claimHash))) {
        return send(res, 400, { error: "id, agentKeyHash and claimHash are required" });
      }
      sweepUnclaimed();
      if (pairings.has(body.id)) return send(res, 409, { error: "That pairing id is taken" });
      if (pairings.size >= MAX_PAIRINGS) return send(res, 429, { error: "This relay has too many pairings" });
      const unclaimed = [...pairings.values()].filter((p) => p.state === "pending").length;
      if (unclaimed >= MAX_UNCLAIMED_PAIRINGS) return send(res, 429, { error: "Too many pairings are waiting to be claimed" });
      const now = Date.now();
      pairings.set(
        body.id,
        newPairing({
          id: body.id,
          label: typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 60) : "Laptop",
          createdAt: now,
          state: "pending",
          agentKeyHash: body.agentKeyHash,
          claimHash: body.claimHash,
          claimExpiresAt: now + pairingTtlMs,
        })
      );
      save();
      log(`pairing ${body.id} registered, waiting to be claimed`);
      return send(res, 201, { id: body.id, expiresAt: now + pairingTtlMs });
    }

    const claimMatch = route.match(/^\/pairings\/([A-Za-z0-9_-]{16,64})\/claim$/);
    if (req.method === "POST" && claimMatch) {
      const body = await readJson(req);
      const pairing = livePairing(claimMatch[1]);
      if (!pairing) return send(res, 404, { error: "Unknown or expired pairing code" });
      if (pairing.state !== "pending") return send(res, 409, { error: "This pairing code was already used" });
      if (typeof body.claim !== "string" || !KEY_RE.test(String(body.phoneKey))) {
        return send(res, 400, { error: "claim and phoneKey are required" });
      }
      if (!sameHash(sha256(body.claim), pairing.claimHash)) {
        pairing.claimFailures += 1;
        if (pairing.claimFailures >= MAX_CLAIM_FAILURES) {
          pairings.delete(pairing.id);
          save();
          log(`pairing ${pairing.id} dropped after wrong codes`);
        }
        return send(res, 403, { error: "Wrong pairing code" });
      }
      const phoneKeyHash = sha256(body.phoneKey);
      if (sameHash(phoneKeyHash, pairing.agentKeyHash)) return send(res, 400, { error: "phoneKey must differ from the agent key" });
      pairing.phoneKeyHash = phoneKeyHash;
      pairing.state = "active";
      pairing.claimHash = null;
      pairing.claimExpiresAt = 0;
      save();
      log(`pairing ${pairing.id} claimed`);
      return send(res, 200, { ok: true, label: pairing.label });
    }

    // ---- everything else needs a key

    const caller = authenticate(req);
    if (!caller) return send(res, 401, { error: "Not paired: missing or wrong pairing key" });
    const { pairing, role } = caller;
    const only = (...roles) => {
      if (roles.includes(role)) return true;
      send(res, 403, { error: `A ${role} key cannot do that` });
      return false;
    };

    if (req.method === "GET" && route === "/pairing") {
      return send(res, 200, {
        id: pairing.id,
        label: pairing.label,
        role,
        state: pairing.state,
        phoneOnline: pairing.phones.size > 0,
        ...(pairing.state === "pending" ? { claimExpiresAt: pairing.claimExpiresAt } : {}),
      });
    }

    if (req.method === "DELETE" && route === "/pairing") {
      revoke(pairing, "The pairing was revoked");
      return send(res, 200, { ok: true });
    }

    if (pairing.state !== "active") {
      return send(res, 409, { error: "Pairing not finished: scan the code with the Nod app first" });
    }

    if (req.method === "GET" && route === "/wallet") {
      if (!only("agent")) return;
      return send(res, 200, { address: pairing.walletAddress, phones: pairing.phones.size });
    }

    if (req.method === "POST" && route === "/push-token") {
      if (!only("phone")) return;
      const body = await readJson(req);
      if (typeof body.token !== "string" || body.token.length > 300) {
        return send(res, 400, { error: "token must be a string" });
      }
      pairing.pushToken = body.token;
      save();
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && route === "/requests") {
      if (!only("agent")) return;
      const payload = await readJson(req);
      if (!payload || (payload.type !== "transfer" && payload.type !== "raw")) {
        return send(res, 400, { error: 'type must be "transfer" or "raw"' });
      }
      if (pendingList(pairing).length >= MAX_PENDING) {
        return send(res, 429, { error: "Too many requests are already waiting" });
      }
      const now = Date.now();
      const request = {
        id: crypto.randomUUID(),
        pairingId: pairing.id,
        status: "pending",
        createdAt: now,
        expiresAt: now + requestTtlMs,
        payload,
        result: null,
        timer: null,
      };
      request.timer = setTimeout(
        () => settle(pairing, request, "expired", { reason: "No answer in time" }),
        requestTtlMs
      );
      if (request.timer.unref) request.timer.unref();
      pairing.requests.set(request.id, request);
      log(`request ${request.id} created (${payload.type}), phones online: ${pairing.phones.size}`);
      broadcast(pairing, { kind: "request", request: publicView(request) });
      sendPush(pairing, request);
      await waitFor(request, clampWait(url.searchParams.get("wait")));
      return send(res, 201, { ...publicView(request), phonesOnline: pairing.phones.size });
    }

    if (req.method === "GET" && route === "/requests") {
      if (!only("phone")) return;
      const status = url.searchParams.get("status");
      const list = [...pairing.requests.values()].filter((r) => !status || r.status === status).map(publicView);
      return send(res, 200, { requests: list });
    }

    const match = route.match(/^\/requests\/([0-9a-f-]{36})(\/result|\/cancel)?$/);
    if (match) {
      // Another pairing's request looks exactly like one that does not exist.
      const request = pairing.requests.get(match[1]);
      if (!request) return send(res, 404, { error: "No such request" });

      if (req.method === "GET" && !match[2]) {
        if (!only("agent")) return;
        await waitFor(request, clampWait(url.searchParams.get("wait")));
        return send(res, 200, publicView(request));
      }

      if (req.method === "POST" && match[2] === "/cancel") {
        if (!only("agent")) return;
        // The agent stopped waiting. Pull the request so nobody approves into the void.
        settle(pairing, request, "cancelled", { reason: "The agent stopped waiting" });
        return send(res, 200, publicView(request));
      }

      if (req.method === "POST" && match[2] === "/result") {
        if (!only("phone")) return;
        const body = await readJson(req);
        if (!FINAL_STATUSES.has(body.status)) {
          return send(res, 400, { error: "status must be approved, denied or failed" });
        }
        if (body.status === "approved" && (typeof body.signature !== "string" || !body.signature)) {
          return send(res, 400, { error: "approved results need a signature" });
        }
        const result = {};
        if (typeof body.signature === "string") result.signature = body.signature.slice(0, 128);
        if (typeof body.reason === "string") result.reason = body.reason.slice(0, 500);
        if (typeof body.refreshed === "boolean") result.refreshed = body.refreshed;
        if (!settle(pairing, request, body.status, result)) {
          return send(res, 409, { error: `Request is already ${request.status}` });
        }
        return send(res, 200, publicView(request));
      }
    }

    return send(res, 404, { error: "Not found" });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) send(res, err.status || 500, { error: err.message });
      else res.end();
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://relay.local");
    const caller = url.pathname === "/phone" ? authenticate(req) : null;
    if (!caller) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    if (caller.role !== "phone" || caller.pairing.state !== "active") {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const { pairing } = caller;
    wss.handleUpgrade(req, socket, head, (ws) => {
      // One phone at a time per pairing. If two phones both saw a request, both
      // could sign it and the money would move twice. The newest connection wins.
      for (const other of pairing.phones) {
        pairing.phones.delete(other);
        other.close(REPLACED_CODE, "replaced by a newer connection");
      }
      pairing.phones.add(ws);
      log(`phone connected to ${pairing.id} (${pairing.phones.size} online)`);
      ws.send(JSON.stringify({ kind: "pending", requests: pendingList(pairing) }));
      ws.on("message", (data) => {
        let message;
        try {
          message = JSON.parse(String(data));
        } catch (_err) {
          return;
        }
        if (message.kind === "hello" && typeof message.wallet === "string" && message.wallet.length <= 64) {
          const wallet = message.wallet || pairing.walletAddress;
          if (wallet !== pairing.walletAddress) {
            pairing.walletAddress = wallet;
            save();
          }
        }
      });
      ws.on("close", () => {
        pairing.phones.delete(ws);
        log(`phone disconnected from ${pairing.id} (${pairing.phones.size} online)`);
      });
      ws.on("error", () => {});
    });
  });

  return {
    /** @returns {Promise<{ port: number, url: string }>} */
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const actual = server.address().port;
          resolve({ port: actual, url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${actual}` });
        });
      });
    },
    close() {
      for (const pairing of pairings.values()) {
        for (const request of pairing.requests.values()) if (request.timer) clearTimeout(request.timer);
        for (const phone of pairing.phones) phone.terminate();
      }
      wss.close();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || "127.0.0.1";
  const pairingsFile = process.env.RELAY_PAIRINGS_FILE || path.join(process.cwd(), ".relay-pairings.json");
  const registrationKey = process.env.RELAY_REGISTRATION_KEY || "";
  const relay = createRelay({
    port,
    host,
    pairingsFile,
    registrationKey,
    log: (line) => console.log(`[relay] ${line}`),
  });
  relay
    .listen()
    .then(({ url }) => {
      console.log(`[relay] listening on ${url}`);
      console.log(`[relay] pairings are saved in ${pairingsFile}`);
      if (host !== "127.0.0.1" && host !== "localhost") {
        console.log("[relay] reachable from the network: serve it over HTTPS, because pairing keys travel in headers.");
        if (!registrationKey) console.log("[relay] tip: set RELAY_REGISTRATION_KEY so only you can create pairings.");
      }
    })
    .catch((err) => {
      console.error(`[relay] could not start: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { createRelay };
