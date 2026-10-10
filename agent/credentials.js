"use strict";
/**
 * Where the laptop keeps its half of a pairing: the relay address and the agent
 * token. `agent/pair.js` writes it once the phone has scanned the code; the MCP
 * server and `agent/request.js` read it, so no config is needed after pairing.
 *
 * The file holds the agent key only. It cannot approve anything: only the phone
 * key can answer a request, and that never leaves the phone.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_RELAY = "http://localhost:8787";

const normalize = (url) => String(url || "").replace(/\/+$/, "");

function configDir(env = process.env) {
  return env.NOD_CONFIG_DIR || path.join(os.homedir(), ".nod");
}

function credentialsPath(env = process.env) {
  return path.join(configDir(env), "agent.json");
}

function saveAgentCredentials({ relay, token, id, label }, env = process.env) {
  const dir = configDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = credentialsPath(env);
  fs.writeFileSync(file, JSON.stringify({ relay: normalize(relay), token, id, label }, null, 2), { mode: 0o600 });
  return file;
}

function loadAgentCredentials(env = process.env) {
  try {
    const data = JSON.parse(fs.readFileSync(credentialsPath(env), "utf8"));
    if (typeof data.relay === "string" && typeof data.token === "string") return data;
  } catch (_err) {
    // No saved pairing.
  }
  return null;
}

function clearAgentCredentials(env = process.env) {
  try {
    fs.unlinkSync(credentialsPath(env));
    return true;
  } catch (_err) {
    return false;
  }
}

/**
 * Which relay and token should an agent tool use?
 *   relay: the --relay argument, else RELAY_URL, else the saved pairing, else localhost.
 *   token: RELAY_TOKEN, else the saved token, but only if the relay is the one
 *          that was paired. A saved key is never sent to a different server.
 */
function resolveAgentConnection({ env = process.env, relayArg } = {}) {
  const saved = loadAgentCredentials(env);
  const relay = normalize(relayArg || env.RELAY_URL || (saved && saved.relay) || DEFAULT_RELAY);
  let token = env.RELAY_TOKEN || "";
  if (!token && saved && normalize(saved.relay) === relay) token = saved.token;
  return { relay, token };
}

module.exports = {
  DEFAULT_RELAY,
  configDir,
  credentialsPath,
  saveAgentCredentials,
  loadAgentCredentials,
  clearAgentCredentials,
  resolveAgentConnection,
};
