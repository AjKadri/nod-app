"use strict";
/**
 * Which Solana network a request is for, and which one this phone is on.
 *
 * Every request names its network. The phone refuses a request whose network is not its own, and it
 * also checks the RPC server it talks to (by the genesis hash of the chain) so that a wrong RPC
 * address can never make it sign for the other network. Both checks fail closed.
 */

const NETWORKS = Object.freeze({
  devnet: Object.freeze({
    id: "devnet",
    label: "Devnet",
    /** Wallet Standard / Mobile Wallet Adapter chain id. */
    cluster: "solana:devnet",
    /** The public RPC. It can be replaced in the app's settings. */
    rpc: "https://api.devnet.solana.com",
    genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    realMoney: false,
  }),
  mainnet: Object.freeze({
    id: "mainnet",
    label: "Mainnet",
    cluster: "solana:mainnet",
    rpc: "https://api.mainnet-beta.solana.com",
    genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    realMoney: true,
  }),
});

const DEFAULT_NETWORK = "devnet";

/**
 * "devnet", "mainnet", "mainnet-beta", "solana:mainnet" (any case) -> "devnet" | "mainnet".
 * Anything else gives null: an unknown name is never guessed.
 */
function parseNetwork(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase().replace(/^solana:/, "");
  if (name === "devnet") return "devnet";
  if (name === "mainnet" || name === "mainnet-beta") return "mainnet";
  return null;
}

function networkLabel(id) {
  return NETWORKS[id] ? NETWORKS[id].label : String(id);
}

/** The words shown when a request is for the other network. */
function networkMismatchMessage(requestNetwork, phoneNetwork) {
  if (!requestNetwork) {
    return `This request does not say which network it is for, so Nod refused it. This phone is on ${networkLabel(phoneNetwork)}. Nothing was signed.`;
  }
  return `This request is for ${networkLabel(requestNetwork)}, but this phone is on ${networkLabel(phoneNetwork)}. Nothing was signed.`;
}

// ------------------------------------------------------------------ what the phone saves

/**
 * An RPC address the person typed, or null if it is not acceptable. Only https is accepted (release
 * builds block plain http, and an RPC server sees every address the wallet asks about). Whether the
 * server really is the chosen network is checked separately, by its genesis hash, before signing.
 */
function validateRpcUrl(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 300) return null;
  let url;
  try {
    url = new URL(trimmed);
  } catch (_err) {
    return null;
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
  return trimmed;
}

/**
 * Read what was saved: { network, rpc: { devnet?, mainnet? } }. Anything wrong falls back to Devnet
 * and the public RPC. Mainnet is never the result of damaged storage by accident: it needs the
 * exact word.
 */
function parseNetworkSettings(text) {
  const fallback = { network: DEFAULT_NETWORK, rpc: {} };
  let data;
  try {
    data = JSON.parse(text);
  } catch (_err) {
    return fallback;
  }
  if (!data || typeof data !== "object") return fallback;
  const network = data.network === "mainnet" ? "mainnet" : DEFAULT_NETWORK;
  const rpc = {};
  for (const id of Object.keys(NETWORKS)) {
    const valid = data.rpc && validateRpcUrl(data.rpc[id]);
    if (valid) rpc[id] = valid;
  }
  return { network, rpc };
}

/** The RPC address in use for a network: the person's own, else the public one. */
function rpcFor(network, settings) {
  return (settings && settings.rpc && settings.rpc[network]) || NETWORKS[network].rpc;
}

module.exports = {
  NETWORKS,
  DEFAULT_NETWORK,
  parseNetwork,
  networkLabel,
  networkMismatchMessage,
  validateRpcUrl,
  parseNetworkSettings,
  rpcFor,
};
