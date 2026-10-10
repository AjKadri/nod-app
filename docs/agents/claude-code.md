# Nod with Claude Code

Your agent asks, your phone shows what would really happen, you nod. About two minutes. You need the Nod app paired with your wallet, and the relay registration key.

## 1. Pair this laptop (once)

From the `nod-app` folder, after `npm install`:

```sh
read -s RELAY_REGISTRATION_KEY && export RELAY_REGISTRATION_KEY   # type the key, press Enter; nothing is shown
npm run pair -- --relay https://relay.ajkadri.dev
unset RELAY_REGISTRATION_KEY
```

Scan the QR code in the Nod app (Settings, Pair with laptop). The relay address and this laptop's key are saved in `~/.nod/agent.json`, so the config below needs no secrets. Check any time with `npm run pair -- --status`.

## 2. Add Nod to Claude Code

Still in the `nod-app` folder:

```sh
claude mcp add --transport stdio --env AGENT_NAME=claude-code --env AGENT_ICON=code nod -- node "$PWD/agent/mcp-server.js"
```

Add `--scope user` to use it in every project, not just this one. Check with `claude mcp list`, or `/mcp` inside Claude Code.

`AGENT_NAME` is what the phone shows on each request; `AGENT_ICON` is optional (`code`, `terminal`, `sparkles`, `chat`, `search`, `globe`, `flash`, `cube`, or one emoji). Tools: `get_wallet_address`, `request_transfer`, `request_token_transfer` (SPL and Token-2022 tokens such as SKR) and `request_transaction`. Add `NETWORK=mainnet` to the server's environment to ask for Mainnet (real money); the default is Devnet, and a phone on the other network refuses the request.

## 3. Try it

Ask the agent:

> Use the nod tools: call get_wallet_address, then request_transfer of 0.001 SOL to `<a devnet address>` with the note "Nod test".

The card appears on your phone. Approve it and the agent gets the transaction signature; reject it and the agent is told not to retry. With Pause everything on, it is told that instead of waiting.
