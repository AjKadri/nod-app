#!/usr/bin/env node
"use strict";
/**
 * MCP server: the one plug that lets a real AI agent (Claude Code, Cursor,
 * Codex, OpenClaw and others that speak MCP) ask the phone for approval.
 *
 * Tools:
 *   get_wallet_address   the paired phone wallet, so the agent can build transactions for it
 *   request_transfer     ask the phone to send SOL
 *   request_transaction  ask the phone to sign and send a transaction the agent built
 *
 * Setup: run `node agent/pair.js` once. The pairing it saves is used automatically.
 * Env (optional): NETWORK (devnet or mainnet, default devnet), RELAY_URL, RELAY_TOKEN, AGENT_NAME (shown on the phone), AGENT_ICON (a preset name such as
 *   code, terminal, sparkles, chat, search, globe, flash, cube, or one emoji), APPROVAL_TIMEOUT_SECONDS
 *
 * Example client config:
 *   { "mcpServers": { "phone-approvals": { "command": "node",
 *       "args": ["/absolute/path/to/agent/mcp-server.js"],
 *       "env": { "RELAY_URL": "http://localhost:8787" } } } }
 */
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { getWalletAddress, requestApproval } = require("./client");
const { resolveAgentConnection, resolveNetwork } = require("./credentials");

// RELAY_URL / RELAY_TOKEN, or else the pairing saved by `node agent/pair.js`.
const { relay, token } = resolveAgentConnection();
const agentName = (process.env.AGENT_NAME || "mcp-agent").slice(0, 60);
const agentIcon = (process.env.AGENT_ICON || "").trim().slice(0, 32);
// NETWORK=devnet (default) or mainnet. Every request names it; the phone refuses one for the other network.
const network = resolveNetwork();
// Who is asking, as the phone will show it, and which network the request is for.
const identity = { agent: agentName, network, ...(agentIcon ? { agentIcon } : {}) };
const timeoutMs = Number(process.env.APPROVAL_TIMEOUT_SECONDS || 300) * 1000;

const TOOLS = [
  {
    name: "get_wallet_address",
    description:
      "Get the Solana address of the user's phone wallet. Use it as the fee payer when building a transaction for request_transaction.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "request_transfer",
    description:
      "Ask the user to approve sending SOL from their phone wallet. Blocks until the user approves or denies on their phone. You never receive the key; you get back a transaction signature or a refusal.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Destination Solana address (base58)" },
        sol: { type: "number", description: "Amount of SOL to send, e.g. 0.001", exclusiveMinimum: 0 },
        note: { type: "string", description: "One short line telling the user why you are asking", maxLength: 280 },
      },
      required: ["to", "sol"],
      additionalProperties: false,
    },
  },
  {
    name: "request_transaction",
    description:
      "Ask the user to approve a transaction you built. Pass the UNSIGNED transaction, base64 encoded, with the user's wallet (see get_wallet_address) as fee payer. Blocks until the user approves or denies on their phone. The phone shows a simulated balance change before signing.",
    inputSchema: {
      type: "object",
      properties: {
        transactionBase64: { type: "string", description: "Serialized unsigned transaction, base64" },
        note: { type: "string", description: "One short line telling the user why you are asking", maxLength: 280 },
      },
      required: ["transactionBase64"],
      additionalProperties: false,
    },
  },
];

function text(message, isError = false) {
  return { content: [{ type: "text", text: message }], isError };
}

function describeOutcome(outcome) {
  if (outcome.status === "approved") {
    return text(`APPROVED by the user. Transaction signature: ${outcome.result.signature}`);
  }
  if (outcome.status === "denied") {
    return text(
      `DENIED by the user${outcome.result && outcome.result.reason ? `: ${outcome.result.reason}` : ""}. Do not retry the same request unless the user asks you to.`,
      true
    );
  }
  if (outcome.status === "failed") {
    return text(`FAILED on the phone: ${(outcome.result && outcome.result.reason) || "unknown error"}`, true);
  }
  if (outcome.status === "expired" || outcome.status === "timeout") {
    return text("NO ANSWER: the user did not respond on their phone in time. Nothing was signed.", true);
  }
  return text(`Unexpected status: ${outcome.status}`, true);
}

async function callTool(name, args) {
  if (name === "get_wallet_address") {
    const address = await getWalletAddress({ relay, token });
    return address
      ? text(address)
      : text("No phone is paired yet. Ask the user to open the approval app and connect their wallet.", true);
  }

  if (name === "request_transfer") {
    const sol = Number(args.sol);
    if (typeof args.to !== "string" || !Number.isFinite(sol) || sol <= 0) {
      return text("request_transfer needs `to` (address) and a positive `sol` amount.", true);
    }
    const payload = {
      type: "transfer",
      to: args.to,
      lamports: Math.round(sol * 1_000_000_000),
      note: typeof args.note === "string" ? args.note : "",
      ...identity,
    };
    return describeOutcome(await requestApproval({ relay, token, payload, timeoutMs }));
  }

  if (name === "request_transaction") {
    if (typeof args.transactionBase64 !== "string" || !args.transactionBase64) {
      return text("request_transaction needs `transactionBase64`.", true);
    }
    const payload = {
      type: "raw",
      transactionBase64: args.transactionBase64,
      note: typeof args.note === "string" ? args.note : "",
      ...identity,
    };
    return describeOutcome(await requestApproval({ relay, token, payload, timeoutMs }));
  }

  return text(`Unknown tool: ${name}`, true);
}

async function main() {
  const server = new Server({ name: "phone-approvals", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await callTool(request.params.name, request.params.arguments || {});
    } catch (err) {
      if (err && err.code === "paused") return text(`PAUSED: ${err.message}`, true);
      return text(`Could not reach the approval relay at ${relay}: ${err.message}`, true);
    }
  });
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(`phone-approvals MCP server failed: ${err.message}`);
  process.exit(1);
});
