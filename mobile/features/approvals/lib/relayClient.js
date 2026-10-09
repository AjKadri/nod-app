"use strict";
/**
 * Phone-side connection to the relay. Used by the React Native app and by the
 * laptop phone simulator, so it takes its WebSocket and fetch from the caller.
 *
 *   const client = createRelayClient({
 *     baseUrl: "http://localhost:8787",
 *     token: "<pairing id>.<phone key>",   // from claimPairing()
 *     WebSocketImpl: WebSocket,   // global in React Native; `ws` package in Node
 *     fetchImpl: fetch,
 *     onRequest: (request) => ...,     // a new approval request arrived
 *     onResolved: (id, status) => ..., // a request was answered or expired
 *     onStatus: (status) => ...,       // "connecting" | "online" | "offline" | "replaced" | "revoked"
 *     onPaused: (paused) => ...,       // the relay's "Pause everything" state, on connect and whenever it changes
 *   });
 *   client.setWallet(address);
 *   await client.sendResult(id, { status: "approved", signature });
 */

// The relay closes a phone's socket with these codes.
const REPLACED_CODE = 4000; // a newer phone connected to the same pairing
const REVOKED_CODE = 4001; // the pairing was revoked

function toWsUrl(baseUrl) {
  return baseUrl.replace(/^http/i, "ws").replace(/\/+$/, "") + "/phone";
}

function createRelayClient({
  baseUrl,
  token = "",
  WebSocketImpl,
  fetchImpl,
  onRequest = () => {},
  onResolved = () => {},
  onStatus = () => {},
  onPaused = () => {},
  reconnectMs = 2000,
}) {
  if (!baseUrl) throw new Error("baseUrl is required");
  if (!WebSocketImpl) throw new Error("WebSocketImpl is required");
  if (!fetchImpl) throw new Error("fetchImpl is required");

  const httpBase = baseUrl.replace(/\/+$/, "");
  let socket = null;
  let closed = false;
  let wallet = "";
  let retryTimer = null;
  const seen = new Set();

  function deliver(request) {
    if (closed || !request || typeof request.id !== "string" || seen.has(request.id)) return;
    seen.add(request.id);
    onRequest(request);
  }

  function sendHello() {
    if (socket && socket.readyState === 1) {
      socket.send(JSON.stringify({ kind: "hello", wallet }));
    }
  }

  function connect() {
    if (closed) return;
    onStatus("connecting");
    // The key goes in a header, never in the URL, so it stays out of access logs.
    // React Native and the `ws` package both accept headers as the third argument.
    const ws = new WebSocketImpl(
      toWsUrl(httpBase),
      undefined,
      token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
    );
    socket = ws;

    ws.onopen = () => {
      onStatus("online");
      sendHello();
    };
    ws.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch (_err) {
        return;
      }
      if (message.kind === "pending" && Array.isArray(message.requests)) {
        if (typeof message.paused === "boolean") onPaused(message.paused);
        message.requests.forEach(deliver);
      } else if (message.kind === "paused" && typeof message.paused === "boolean") {
        onPaused(message.paused);
      } else if (message.kind === "request") {
        deliver(message.request);
      } else if (message.kind === "resolved" && typeof message.id === "string") {
        onResolved(message.id, message.status);
      }
    };
    ws.onerror = () => {
      // onclose always follows; reconnect is handled there.
    };
    ws.onclose = (event) => {
      if (socket === ws) socket = null;
      if (closed) return;
      if (event && event.code === REPLACED_CODE) {
        // Another phone took over. Do not fight it for the connection.
        closed = true;
        onStatus("replaced");
        return;
      }
      if (event && event.code === REVOKED_CODE) {
        closed = true;
        onStatus("revoked");
        return;
      }
      onStatus("offline");
      checkStillPaired();
      retryTimer = setTimeout(connect, reconnectMs);
    };
  }

  function headers() {
    const base = { "content-type": "application/json" };
    if (token) base.authorization = `Bearer ${token}`;
    return base;
  }

  // A socket that cannot connect may mean the pairing was revoked while we were
  // offline. Ask the relay: a 401 means the keys are gone, so stop trying.
  function checkStillPaired() {
    if (!token) return;
    Promise.resolve(fetchImpl(`${httpBase}/pairing`, { headers: headers() }))
      .then((response) => {
        if (response && response.status === 401 && !closed) {
          closed = true;
          if (retryTimer) clearTimeout(retryTimer);
          onStatus("revoked");
        }
      })
      .catch(() => {});
  }

  connect();

  return {
    /** Tell the relay which wallet this phone signs with, so agents can build transactions for it. */
    setWallet(address) {
      wallet = address || "";
      sendHello();
    },

    /** Report the outcome of a request: approved (with signature), denied, or failed. */
    async sendResult(id, result) {
      const response = await fetchImpl(`${httpBase}/requests/${encodeURIComponent(id)}/result`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(result),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`Relay rejected the result (${response.status}): ${text}`);
      }
      return response.json();
    },

    /**
     * "Pause everything": make the relay refuse new requests from this pairing's laptop (or accept
     * them again). Resolves with the state the relay now has, so the caller never has to assume.
     */
    async setPaused(paused) {
      const response = await fetchImpl(`${httpBase}/pause`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ paused: !!paused }),
      });
      if (!response.ok) throw new Error(`Relay refused to ${paused ? "pause" : "resume"} (${response.status})`);
      const body = await response.json();
      onPaused(body.paused === true);
      return body.paused === true;
    },

    /** Fallback for when the socket is down: ask for everything still waiting. */
    async fetchPending() {
      const response = await fetchImpl(`${httpBase}/requests?status=pending`, { headers: headers() });
      if (!response.ok) throw new Error(`Relay error ${response.status}`);
      const body = await response.json();
      (body.requests || []).forEach(deliver);
      return body.requests || [];
    },

    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (socket) socket.close();
    },
  };
}

module.exports = { createRelayClient };
