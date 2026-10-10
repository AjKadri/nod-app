# Nod with Codex

Your agent asks, your phone shows what would really happen, you nod. About two minutes. You need the Nod app paired with your wallet, and the relay registration key.

## 1. Pair this laptop (once)

From the `nod-app` folder, after `npm install`:

```sh
read -s RELAY_REGISTRATION_KEY && export RELAY_REGISTRATION_KEY   # type the key, press Enter; nothing is shown
npm run pair -- --relay https://relay.ajkadri.dev
unset RELAY_REGISTRATION_KEY
```

Scan the QR code in the Nod app (Settings, Pair with laptop). The relay address and this laptop's key are saved in `~/.nod/agent.json`, so the config below needs no secrets. Check any time with `npm run pair -- --status`.

## 2. Add Nod to Codex

Still in the `nod-app` folder:

```sh
codex mcp add nod --env AGENT_NAME=codex --env AGENT_ICON=terminal -- node "$PWD/agent/mcp-server.js"
```

Or edit `~/.codex/config.toml` yourself:

```toml
[mcp_servers.nod]
command = "node"
args = ["/path/to/nod-app/agent/mcp-server.js"]
env = { AGENT_NAME = "codex", AGENT_ICON = "terminal" }
```

Restart Codex. `codex mcp list` shows it.

`AGENT_NAME` is what the phone shows on each request; `AGENT_ICON` is optional (`code`, `terminal`, `sparkles`, `chat`, `search`, `globe`, `flash`, `cube`, or one emoji). Tools: `get_wallet_address`, `request_transfer`, `request_transaction`.

## 3. Try it

Ask the agent:

> Use the nod tools: call get_wallet_address, then request_transfer of 0.001 SOL to `<a devnet address>` with the note "Nod test".

The card appears on your phone. Approve it and the agent gets the transaction signature; reject it and the agent is told not to retry. With Pause everything on, it is told that instead of waiting.
