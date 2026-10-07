"use strict";
/**
 * Relay between agents and the phone. In memory, no database.
 *
 *   Agent  --POST /requests-->  relay  --WebSocket /phone-->  phone
 *   Agent  <--result (long-poll)--  relay  <--POST /requests/:id/result--  phone
 *
 * Request statuses: pending -> approved | denied | failed (set by the phone),
 * expired (nobody answered in time) or cancelled (the agent gave up).
 *
 * The relay only passes messages. It never sees a private key and cannot sign.
 * The phone re-validates everything it receives.
 *
 * SPIKE ONLY: there is no pairing. Anyone who can reach this server can post a
 * request to the phone. It binds to 127.0.0.1 by default; do not expose it.
 *
 * Run:  node relay/server.js            (PORT, HOST, RELAY_TOKEN env vars)
 */
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const MAX_BODY_BYTES = 16 * 1024;
const MAX_WAIT_SECONDS = 120;
const MAX_PENDING = 50;
const FINAL_STATUSES = new Set(["approved", "denied", "failed"]);

function createRelay({
  port = 8787,
  host = "127.0.0.1",
  token = "",
  requestTtlMs = 10 * 60 * 1000,
  expoPushUrl = "https://exp.host/--/api/v2/push/send",
  log = () => {},
} = {}) {
  /** @type {Map<string, any>} */
  const requests = new Map();
  /** @type {Map<string, Set<Function>>} */
  const waiters = new Map();
  const phones = new Set();
  let walletAddress = null;
  let pushToken = null;

  function publicView(request) {
    const { timer, ...rest } = request;
    return rest;
  }

  function pendingList() {
    return [...requests.values()].filter((r) => r.status === "pending").map(publicView);
  }

  function broadcast(message) {
    const text = JSON.stringify(message);
    for (const phone of phones) {
      if (phone.readyState === 1) phone.send(text);
    }
  }

  function settle(request, status, result) {
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
    broadcast({ kind: "resolved", id: request.id, status });
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

  async function sendPush(request) {
    if (!pushToken) return;
    const body = {
      to: pushToken,
      title: "Approval needed",
      body: request.payload.note || `An agent is asking to ${request.payload.type === "transfer" ? "send SOL" : "run a transaction"}`,
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

  function tokenOk(provided) {
    if (!token) return true;
    if (typeof provided !== "string") return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function authorized(req, url) {
    const header = req.headers.authorization || "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : undefined;
    return tokenOk(bearer) || tokenOk(url.searchParams.get("token") || undefined);
  }

  function clampWait(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;
    return Math.min(seconds, MAX_WAIT_SECONDS);
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://relay.local");
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && path === "/health") {
      return send(res, 200, { ok: true, phones: phones.size, pending: pendingList().length });
    }
    if (!authorized(req, url)) return send(res, 401, { error: "Missing or wrong relay token" });

    if (req.method === "GET" && path === "/wallet") {
      return send(res, 200, { address: walletAddress, phones: phones.size });
    }

    if (req.method === "POST" && path === "/push-token") {
      const body = await readJson(req);
      if (typeof body.token !== "string" || body.token.length > 300) {
        return send(res, 400, { error: "token must be a string" });
      }
      pushToken = body.token;
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && path === "/requests") {
      const payload = await readJson(req);
      if (!payload || (payload.type !== "transfer" && payload.type !== "raw")) {
        return send(res, 400, { error: 'type must be "transfer" or "raw"' });
      }
      if (pendingList().length >= MAX_PENDING) {
        return send(res, 429, { error: "Too many requests are already waiting" });
      }
      const now = Date.now();
      const request = {
        id: crypto.randomUUID(),
        status: "pending",
        createdAt: now,
        expiresAt: now + requestTtlMs,
        payload,
        result: null,
        timer: null,
      };
      request.timer = setTimeout(() => settle(request, "expired", { reason: "No answer in time" }), requestTtlMs);
      if (request.timer.unref) request.timer.unref();
      requests.set(request.id, request);
      log(`request ${request.id} created (${payload.type}), phones online: ${phones.size}`);
      broadcast({ kind: "request", request: publicView(request) });
      sendPush(request);
      await waitFor(request, clampWait(url.searchParams.get("wait")));
      return send(res, 201, { ...publicView(request), phonesOnline: phones.size });
    }

    if (req.method === "GET" && path === "/requests") {
      const status = url.searchParams.get("status");
      const list = [...requests.values()].filter((r) => !status || r.status === status).map(publicView);
      return send(res, 200, { requests: list });
    }

    const match = path.match(/^\/requests\/([0-9a-f-]{36})(\/result|\/cancel)?$/);
    if (match) {
      const request = requests.get(match[1]);
      if (!request) return send(res, 404, { error: "No such request" });

      if (req.method === "GET" && !match[2]) {
        await waitFor(request, clampWait(url.searchParams.get("wait")));
        return send(res, 200, publicView(request));
      }

      if (req.method === "POST" && match[2] === "/cancel") {
        // The agent stopped waiting. Pull the request so nobody approves into the void.
        settle(request, "cancelled", { reason: "The agent stopped waiting" });
        return send(res, 200, publicView(request));
      }

      if (req.method === "POST" && match[2] === "/result") {
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
        if (!settle(request, body.status, result)) {
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
    if (url.pathname !== "/phone" || !authorized(req, url)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // One phone at a time. If two phones both saw a request, both could sign
      // it and the money would move twice. The newest connection wins.
      for (const other of phones) {
        phones.delete(other);
        other.close(4000, "replaced by a newer connection");
      }
      phones.add(ws);
      log(`phone connected (${phones.size} online)`);
      ws.send(JSON.stringify({ kind: "pending", requests: pendingList() }));
      ws.on("message", (data) => {
        let message;
        try {
          message = JSON.parse(String(data));
        } catch (_err) {
          return;
        }
        if (message.kind === "hello" && typeof message.wallet === "string" && message.wallet.length <= 64) {
          walletAddress = message.wallet || walletAddress;
        }
      });
      ws.on("close", () => {
        phones.delete(ws);
        log(`phone disconnected (${phones.size} online)`);
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
      for (const request of requests.values()) if (request.timer) clearTimeout(request.timer);
      for (const phone of phones) phone.terminate();
      wss.close();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || "127.0.0.1";
  const token = process.env.RELAY_TOKEN || "";
  const relay = createRelay({ port, host, token, log: (line) => console.log(`[relay] ${line}`) });
  relay
    .listen()
    .then(({ url }) => {
      console.log(`[relay] listening on ${url}  (token ${token ? "required" : "NOT set"})`);
      if (host !== "127.0.0.1" && host !== "localhost" && !token) {
        console.log("[relay] WARNING: reachable from the network with no token. Set RELAY_TOKEN.");
      }
    })
    .catch((err) => {
      console.error(`[relay] could not start: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { createRelay };
