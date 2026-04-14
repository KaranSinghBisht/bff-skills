---
name: agent-trust-ledger
description: "Writes on-chain reputation between AIBTC agents via ERC-8004 reputation-registry-v2 — client approvals, feedback ratings, and owner responses for completed agent transactions."
metadata:
  author: "KaranSinghBisht"
  author-agent: "Encrypted Zara"
  user-invocable: "false"
  arguments: "doctor | install-packs | status | approve-client | submit-feedback | respond | run"
  entry: "agent-trust-ledger/agent-trust-ledger.ts"
  requires: "wallet, signing, settings"
  tags: "write, mainnet-only, sensitive, infrastructure, l2"
---

# Agent Trust Ledger

## What it does

Writes the trust primitive that autonomous agent commerce on AIBTC has been missing. Every completed x402 payment, P2P ordinals trade, or inbox settlement leaves a counterparty relationship unrecorded. This skill turns those relationships into durable on-chain reputation through the ERC-8004 reputation registry, exposing each of the three on-chain write methods as a single commander sub-command with guardrails, per-counterparty cooldowns, and `PostConditionMode.Deny` enforcement.

## Why agents need it

Reputation-gated services are coming. A correspondent who wants to publish signals backed by a track record, a paymaster that only accepts work from approved ICs, a classifieds marketplace that rotates trusted sellers — all need a primitive that proves on-chain: "this agent has done N successful transactions with M distinct counterparties, rated 4.2 WAD-average." The registry exposes exactly that, but it demands a three-step handshake per relationship. That handshake is what this skill automates.

## The three WRITE actions

1. **approve-client** — the agent owner pre-approves a specific client's Stacks address up to an index limit. When a client has an unused approved-index slot, feedback is routed through `give-feedback-approved`, which carries the approved-client provenance. Without an approval, the skill falls back to the unrestricted `give-feedback` entry point.
2. **submit-feedback** — a client files a rating (integer `--value` with separate `--value-decimals`; 18-decimal WAD values are supported via BigInt parsing) against an agent they transacted with. Includes optional tags, an endpoint URI, a feedback URI pointing to off-chain context (e.g., the x402 transaction hash), and a required 32-byte hash (defaults to zero hash if unknown).
3. **respond** — the agent owner appends a response to a specific `(client, index)` feedback item. Responses are append-only and preflighted against `identity-registry-v2.get-owner` so non-owners are blocked before a fee is spent.

All three go on-chain through `SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.reputation-registry-v2` on Stacks mainnet.

## Safety notes

- Writes to chain. Every write command requires `--confirm=TRUST`; without it, the skill emits `status: blocked` and exits 2 without touching the wallet.
- Mainnet only. All registry addresses point to Stacks mainnet; no testnet fallback.
- Wallet password required. The skill unlocks the local AIBTC wallet via `AIBTC_WALLET_PASSWORD` env var and re-locks it in a `finally` block regardless of success, error, or blocked status.
- Ownership preflight. `approve-client` and `respond` read `identity-registry-v2.get-owner(agent-id)` before broadcasting and block with `not-agent-owner` if the unlocked wallet is not the owner.
- Self-feedback preflight. `submit-feedback` reads `get-owner(agent-id)` and blocks with `self-feedback` if the target agent is owned by the signer wallet; the contract rejects this via `ERR_SELF_FEEDBACK` otherwise.
- Cooldown enforced per counterparty. `submit-feedback` refuses to rate the same `--agent-id` within `--cooldown-days` (default 7). Tracked in a local state file at `~/.agent-trust-ledger-state.json`.
- Post-conditions enforced. Every write uses `PostConditionMode.Deny` so stray token movements block the transaction.
- Hash validation. `--feedback-hash` and `--response-hash` are validated as 32-byte hex before any broadcast; non-hex or wrong-length inputs error locally.
- State file is best-effort. The state file is written synchronously but is not exclusively locked across processes. Do not run multiple concurrent invocations against the same wallet.

## Commands

### doctor
Verifies the local wallet is resolvable, the Hiro mainnet API is reachable, and reports the reputation/identity contract IDs, state file path, and whether the `AIBTC_WALLET_PASSWORD` env var is set. Does not broadcast anything and does not require the password.

```bash
bun run skills/agent-trust-ledger/agent-trust-ledger.ts doctor
```

### install-packs
Lists the runtime packages the skill depends on.

```bash
bun run skills/agent-trust-ledger/agent-trust-ledger.ts install-packs
```

### status
Reports the active wallet and the cooldown/approval state file. With optional `--agent-id`, also fetches `get-summary` for that agent on-chain. Read-only; does not unlock the wallet.

```bash
bun run skills/agent-trust-ledger/agent-trust-ledger.ts status --agent-id 138
```

### approve-client
Pre-approves a client Stacks address up to `--index-limit` feedback slots. Ownership of `--agent-id` is preflighted.

```bash
bun run skills/agent-trust-ledger/agent-trust-ledger.ts approve-client \
  --agent-id 138 --client SP... --index-limit 10 --confirm TRUST
```

### submit-feedback
Submits a rating for another agent you have transacted with. Auto-selects `give-feedback-approved` when the signer sits inside the target's approved-index window, otherwise uses `give-feedback`.

```bash
bun run skills/agent-trust-ledger/agent-trust-ledger.ts submit-feedback \
  --agent-id 138 --value 5 --value-decimals 0 \
  --tag1 x402 --tag2 bitflow-swap \
  --feedback-uri https://explorer.hiro.so/txid/0x... \
  --feedback-hash 0000000000000000000000000000000000000000000000000000000000000000 \
  --confirm TRUST
```

### respond
Appends a response to a specific `(client, index)` feedback item. Ownership of `--agent-id` is preflighted. `--response-uri` and `--response-hash` are both required.

```bash
bun run skills/agent-trust-ledger/agent-trust-ledger.ts respond \
  --agent-id 138 --client SP... --index 0 \
  --response-uri https://... \
  --response-hash 0000000000000000000000000000000000000000000000000000000000000000 \
  --confirm TRUST
```

### run
Plan-only survey mode. Walks the local `approvedClients` state list and reports STX balance plus enumerated approval state, without broadcasting any writes. `--confirm=TRUST` is still required to signal intent, but no transaction is submitted. For actual writes, invoke `approve-client`, `submit-feedback`, or `respond` directly.

```bash
bun run skills/agent-trust-ledger/agent-trust-ledger.ts run \
  --mode auto --max-actions-per-run 5 --cooldown-days 7 --confirm TRUST
```

## Tags and attribution

Every feedback submission accepts `--tag1` and `--tag2` (each ≤ 64 utf-8 chars). Recommended conventions: `tag1` identifies the venue (`x402`, `ordinals-p2p`, `inbox`, `bounty`), `tag2` identifies the service (`bitflow-swap`, `zest-supply`, `signal-correction`). This lets downstream reputation-reading agents filter by context.

## Output contract

All command executions emit a single JSON object to stdout with schema `{ status, action, data, error }` and exit 0 on `status: success`, 1 on `status: error`, 2 on `status: blocked`. `blocked` covers cooldown, missing confirmation, ownership preflight fail, self-feedback preflight fail, agent-not-found, owner-unknown, and Commander parse errors (missing required option, unknown command). The only exceptions that do not emit JSON are `--help` and `--version`, which produce Commander's default text output and exit 0.
