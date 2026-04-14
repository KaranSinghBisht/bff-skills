---
name: agent-trust-ledger-agent
skill: agent-trust-ledger
description: "Writes ERC-8004 reputation for completed agent transactions. Covers approve-client, submit-feedback, respond — each guarded by confirm token, cooldown state file, ownership preflight, and post-condition deny."
---

# Agent Trust Ledger Agent

## Purpose

Convert completed agent interactions into durable on-chain reputation. Every x402 payment, P2P ordinals trade, inbox settlement, or bounty claim leaves a counterparty relationship unrecorded. This skill walks that relationship through the ERC-8004 three-step handshake — approve-client, submit-feedback, respond — so downstream reputation-gated services have verifiable signal.

## Decision order

1. Run `doctor` on first use and whenever the wallet or ERC-8004 anchor changes.
2. Run `status --agent-id <yourId>` before any write action to inspect current reputation summary, your cooldown/approval state file, and local responded-feedback keys.
3. Use `approve-client` when a new counterparty has completed a transaction with you and you want to let them file approved-provenance feedback. Set `--index-limit` conservatively (5-10 for first-time clients).
4. Use `submit-feedback` when the underlying transaction is confirmed on-chain. Always supply `--feedback-uri` pointing to transaction proof. If you know the target has approved you, your approved slot is used automatically via `give-feedback-approved`; otherwise the unrestricted `give-feedback` entry is used.
5. Use `respond` within 24 hours of receiving a new feedback. Responses convert asymmetric ratings into bilateral trust records.
6. Use `run --mode=auto` as a plan-only survey of approved-client state. It does not auto-broadcast; it exists so operators can diff local state before hand-picking writes.

## Guardrails

- Never execute any write command without `AIBTC_WALLET_PASSWORD` in env.
- Never write without `--confirm=TRUST` on the invocation.
- Never re-rate the same `--agent-id` within `--cooldown-days` (default 7). The state file enforces this across runs.
- Never submit feedback without a verifiable `--feedback-uri`. Unrooted ratings degrade the registry.
- Never approve a client you have not transacted with. The approval list is scanned during reputation audits.
- Never try to respond as a non-owner — the skill preflights `identity-registry-v2.get-owner` and blocks before fee spend.
- Never rate an agent whose owner is your own wallet — the skill preflights for self-feedback and blocks before the contract's `ERR_SELF_FEEDBACK` refund-less revert.
- Always re-lock the wallet on exit via the skill's `finally` block, regardless of success, error, or blocked status.

## Tag conventions

- `--tag1`: venue. One of `x402`, `ordinals-p2p`, `inbox`, `bounty`, `classifieds`, `signal-correction`.
- `--tag2`: service. Examples: `bitflow-swap`, `zest-supply`, `jingswap-cycle`, `dca-deposit`, `bounty-fulfilled`.

Consistent tagging is what makes the registry filterable downstream.

## Failure modes

- `cooldown-active`: counterparty was rated within `--cooldown-days`. Skill returns `status: blocked`, exit 2. Retry after cooldown expires.
- `self-feedback`: target `--agent-id` is owned by the signer wallet. Skill returns `status: blocked` before broadcast. Pick a different counterparty.
- `not-agent-owner`: `approve-client` or `respond` invoked with an `--agent-id` not owned by the signer wallet. Skill returns `status: blocked` before broadcast.
- `agent-not-found`: `--agent-id` has no entry in `identity-registry-v2` (NFT not minted). Skill returns `status: blocked` before broadcast.
- `owner-unknown`: ownership preflight read failed (RPC error or `(err …)` response). Skill fails closed with `status: blocked` — no broadcast, no fee spend. Retry once Hiro API is reachable.
- `already-responded`: a response has already been recorded locally for this `(agentId, client, index)`. Remove the state entry to force retry.
- `missing-confirm`: write command invoked without `--confirm=TRUST`. Skill returns `status: blocked`, exit 2.
- `insufficient-gas`: wallet STX balance below `--min-gas-reserve-ustx`. Fund the wallet before retrying.
- Broadcast-time rejections (nonce gap, bad sig, etc.) surface as `status: error` with the broadcast error text. Post-condition denies happen at contract-execution time: the skill returns `status: success` with a txid from broadcast, and the reversion becomes visible via the explorer URL included in `data.explorer`.

## Output contract

Single JSON object on stdout: `{ status: "success" | "error" | "blocked", action, data, error: null | { code, message, next } }`. Exit 0 on success, 1 on error, 2 on blocked. Commander parse errors (missing required flag, unknown command) are routed through the same contract as `status: blocked` with `action: "cli"` and `error.code: "cli-parse-error"`. `--help` and `--version` are the only non-JSON exits (plain text, exit 0).
