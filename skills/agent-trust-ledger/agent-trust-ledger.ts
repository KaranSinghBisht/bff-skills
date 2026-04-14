#!/usr/bin/env bun

/**
 * agent-trust-ledger
 *
 * Walks the ERC-8004 reputation-registry-v2 three-step handshake for
 * completed agent transactions: approve-client, give-feedback, append-response.
 *
 * All WRITE commands require `--confirm=TRUST`. State file at
 * ~/.agent-trust-ledger-state.json enforces per-counterparty cooldowns.
 */

import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  makeContractCall,
  broadcastTransaction,
  PostConditionMode,
  uintCV,
  intCV,
  standardPrincipalCV,
  bufferCV,
  stringUtf8CV,
  cvToJSON,
  fetchCallReadOnlyFunction,
  ClarityValue,
} from "@stacks/transactions";
import { STACKS_MAINNET } from "@stacks/network";
import { getWalletManager } from "@aibtc/mcp-server/dist/services/wallet-manager.js";
import { getExplorerTxUrl } from "@aibtc/mcp-server/dist/config/networks.js";

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

const NETWORK = "mainnet";
const HIRO_API = "https://api.mainnet.hiro.so";

const REPUTATION_CONTRACT =
  "SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.reputation-registry-v2";
const IDENTITY_CONTRACT =
  "SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2";

const FETCH_TIMEOUT_MS = 30_000;
const CONFIRM_TOKEN = "TRUST";
const DEFAULT_COOLDOWN_DAYS = 7;
const DEFAULT_MAX_ACTIONS_PER_RUN = 5;
const DEFAULT_INDEX_LIMIT = 10;
const DEFAULT_FEE_USTX = 10_000n;

const STATE_FILE = join(homedir(), ".agent-trust-ledger-state.json");

// ERC-8004 schema limits.
const MAX_TAG_LEN = 64;
const MAX_URI_LEN = 512;
const HASH_LEN_BYTES = 32;
const ZERO_HASH_HEX = "0".repeat(64);

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

type SkillStatus = "success" | "error" | "blocked";

interface SkillOutput {
  status: SkillStatus;
  action: string;
  data: Record<string, unknown>;
  error: { code: string; message: string; next: string } | null;
}

interface LedgerState {
  lastRun?: string;
  feedbackCooldowns: Record<string, string>;
  approvedClients: Array<{ agentId: number; client: string }>;
  respondedFeedback: string[]; // key: "agentId:client:index"
}

interface WalletInfo {
  id: string;
  stxAddress: string;
  btcAddress: string;
}

interface ReputationSummary {
  count: number;
  summaryValue: string;
  summaryValueDecimals: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

class SkillExit extends Error {
  constructor(public code: number) {
    super(`skill-exit-${code}`);
  }
}

function bigintReplacer(_: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v;
}

function emit(output: SkillOutput): never {
  console.log(JSON.stringify(output, bigintReplacer, 2));
  const code = output.status === "success" ? 0 : output.status === "blocked" ? 2 : 1;
  throw new SkillExit(code);
}

function handleTopLevel(e: unknown, action: string, data: Record<string, unknown>): never {
  if (e instanceof SkillExit) process.exit(e.code);
  try {
    emit({
      status: "error",
      action,
      data,
      error: {
        code: `${action}-exception`,
        message: (e as Error).message ?? String(e),
        next: "Check args and retry.",
      },
    });
  } catch (e2: unknown) {
    if (e2 instanceof SkillExit) process.exit(e2.code);
    process.exit(1);
  }
}

function loadState(): LedgerState {
  const empty: LedgerState = {
    feedbackCooldowns: {},
    approvedClients: [],
    respondedFeedback: [],
  };
  if (!existsSync(STATE_FILE)) return empty;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return empty;
  }
  const obj = (raw ?? {}) as {
    lastRun?: unknown;
    feedbackCooldowns?: unknown;
    approvedClients?: unknown;
    respondedFeedback?: unknown;
  };
  const state: LedgerState = {
    feedbackCooldowns:
      obj.feedbackCooldowns && typeof obj.feedbackCooldowns === "object"
        ? (obj.feedbackCooldowns as Record<string, string>)
        : {},
    approvedClients: [],
    respondedFeedback: [],
  };
  if (typeof obj.lastRun === "string") state.lastRun = obj.lastRun;
  // Migrate approvedClients: tolerate old string[] format by dropping entries
  // with unknown agentId rather than silently keeping malformed data.
  if (Array.isArray(obj.approvedClients)) {
    for (const entry of obj.approvedClients) {
      if (entry && typeof entry === "object" && "agentId" in entry && "client" in entry) {
        const agentId = Number((entry as { agentId: unknown }).agentId);
        const client = String((entry as { client: unknown }).client);
        if (Number.isInteger(agentId) && agentId >= 0) {
          state.approvedClients.push({ agentId, client });
        }
      }
    }
  }
  // Migrate respondedFeedback: accept "agentId:client:index" (3-part) only.
  // Old "client:index" (2-part) entries are dropped because agentId is unknown.
  if (Array.isArray(obj.respondedFeedback)) {
    for (const key of obj.respondedFeedback) {
      if (typeof key === "string" && key.split(":").length === 3) {
        state.respondedFeedback.push(key);
      }
    }
  }
  return state;
}

function saveState(state: LedgerState): void {
  state.lastRun = new Date().toISOString();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function cooldownActive(
  state: LedgerState,
  agentId: number,
  cooldownDays: number,
): boolean {
  const last = state.feedbackCooldowns[String(agentId)];
  if (!last) return false;
  const elapsedMs = Date.now() - new Date(last).getTime();
  return elapsedMs < cooldownDays * 24 * 60 * 60 * 1000;
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function splitContract(id: string): [string, string] {
  const [addr, name] = id.split(".");
  if (!addr || !name) throw new Error(`Invalid contract id: ${id}`);
  return [addr, name];
}

function hashCV(hex: string | undefined): ClarityValue {
  const clean = (hex ?? ZERO_HASH_HEX).replace(/^0x/, "");
  if (!/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error(`hash must be hex-encoded (got non-hex char)`);
  }
  if (clean.length !== HASH_LEN_BYTES * 2) {
    throw new Error(`hash must be ${HASH_LEN_BYTES} bytes (${HASH_LEN_BYTES * 2} hex chars)`);
  }
  const buf = Buffer.from(clean, "hex");
  if (buf.length !== HASH_LEN_BYTES) {
    throw new Error(`hash decoded to ${buf.length} bytes, expected ${HASH_LEN_BYTES}`);
  }
  return bufferCV(buf);
}

function parseBigIntArg(s: string | undefined, name: string): bigint {
  if (s === undefined || s === "") throw new Error(`Invalid ${name}.`);
  const clean = s.trim();
  if (!/^-?\d+$/.test(clean)) throw new Error(`Invalid ${name} (must be an integer).`);
  return BigInt(clean);
}

type OwnerLookup =
  | { available: true; owner: string | null }
  | { available: false; reason: string };

async function getIdentityOwner(
  agentId: number,
  senderAddress: string,
): Promise<OwnerLookup> {
  const [addr, name] = splitContract(IDENTITY_CONTRACT);
  let result;
  try {
    result = await fetchCallReadOnlyFunction({
      contractAddress: addr,
      contractName: name,
      functionName: "get-owner",
      functionArgs: [uintCV(agentId)],
      network: STACKS_MAINNET,
      senderAddress,
    });
  } catch (e: unknown) {
    return { available: false, reason: `rpc-error: ${(e as Error).message}` };
  }
  const parsed = cvToJSON(result) as {
    type?: string;
    success?: boolean;
    value?: unknown;
  };
  // SIP-009 get-owner returns (response (optional principal) uint).
  if (parsed?.success === false) {
    const errVal = (parsed.value as { value?: unknown })?.value ?? parsed.value;
    return { available: false, reason: `contract-err: ${String(errVal)}` };
  }
  // ok branch: inner is (optional principal).
  const inner = (parsed.value as { value?: unknown; type?: string }) ?? {};
  if (inner.value === null || inner.value === undefined) {
    // (ok none) — agent id does not exist
    return { available: true, owner: null };
  }
  // (ok (some principal)): inner.value is {type:"principal", value:"SP..."}
  const principal =
    typeof inner.value === "string"
      ? inner.value
      : (inner.value as { value?: unknown })?.value;
  if (typeof principal !== "string" || !/^S[PT][0-9A-Z]{38,39}$/.test(principal)) {
    return {
      available: false,
      reason: `unexpected-shape: ${JSON.stringify(parsed).slice(0, 160)}`,
    };
  }
  return { available: true, owner: principal };
}

async function requireOwnership(
  action: string,
  agentId: number,
  signer: string,
): Promise<string> {
  const lookup = await getIdentityOwner(agentId, signer);
  if (!lookup.available) {
    emit({
      status: "blocked",
      action,
      data: { agentId, signer, ownerReadFailure: lookup.reason },
      error: {
        code: "owner-unknown",
        message: `Could not confirm owner of agent ${agentId} (${lookup.reason}); refusing to broadcast.`,
        next: "Check Hiro API reachability and agent-id validity, then retry.",
      },
    });
  }
  if (lookup.owner === null) {
    emit({
      status: "blocked",
      action,
      data: { agentId, signer },
      error: {
        code: "agent-not-found",
        message: `Agent ${agentId} has no owner in identity-registry-v2 (NFT not minted).`,
        next: "Verify --agent-id or register the identity via identity_register first.",
      },
    });
  }
  if (lookup.owner !== signer) {
    emit({
      status: "blocked",
      action,
      data: { agentId, owner: lookup.owner, signer },
      error: {
        code: "not-agent-owner",
        message: `Agent ${agentId} is owned by ${lookup.owner}, not ${signer}.`,
        next: "Switch to the owning wallet or pass a different --agent-id.",
      },
    });
  }
  return lookup.owner;
}

async function requireNotSelfFeedback(
  agentId: number,
  signer: string,
): Promise<void> {
  const lookup = await getIdentityOwner(agentId, signer);
  if (!lookup.available) {
    emit({
      status: "blocked",
      action: "submit-feedback",
      data: { agentId, signer, ownerReadFailure: lookup.reason },
      error: {
        code: "owner-unknown",
        message: `Could not confirm owner of target agent ${agentId} (${lookup.reason}); refusing to broadcast.`,
        next: "Check Hiro API reachability and agent-id validity, then retry.",
      },
    });
  }
  if (lookup.owner === null) {
    emit({
      status: "blocked",
      action: "submit-feedback",
      data: { agentId, signer },
      error: {
        code: "agent-not-found",
        message: `Target agent ${agentId} has no owner in identity-registry-v2.`,
        next: "Verify --agent-id points at a registered agent.",
      },
    });
  }
  if (lookup.owner === signer) {
    emit({
      status: "blocked",
      action: "submit-feedback",
      data: { agentId, owner: lookup.owner, signer },
      error: {
        code: "self-feedback",
        message: `Target agent ${agentId} is owned by your wallet. Contract rejects self-feedback.`,
        next: "Submit feedback for a different agent.",
      },
    });
  }
}

function utf8CV(s: string, max: number): ClarityValue {
  return stringUtf8CV((s ?? "").slice(0, max));
}

// ────────────────────────────────────────────────────────────────────────────
// Contract reads
// ────────────────────────────────────────────────────────────────────────────

async function getReputationSummary(
  agentId: number,
  senderAddress: string,
): Promise<ReputationSummary | null> {
  const [addr, name] = splitContract(REPUTATION_CONTRACT);
  try {
    const result = await fetchCallReadOnlyFunction({
      contractAddress: addr,
      contractName: name,
      functionName: "get-summary",
      functionArgs: [uintCV(agentId)],
      network: STACKS_MAINNET,
      senderAddress,
    });
    const parsed = cvToJSON(result);
    const tuple = parsed?.value;
    if (!tuple) return null;
    return {
      count: Number(tuple["count"]?.value ?? 0),
      summaryValue: String(tuple["summary-value"]?.value ?? "0"),
      summaryValueDecimals: Number(tuple["summary-value-decimals"]?.value ?? 0),
    };
  } catch {
    return null;
  }
}

function parseUintScalar(parsed: unknown): bigint {
  // Handles direct uint outputs: cvToJSON shape is {type: "uint", value: "10"}.
  // Also tolerates (ok uint) wrappers by unwrapping once.
  const obj = parsed as { success?: boolean; value?: unknown; type?: string };
  if (obj?.success === true) {
    return parseUintScalar(obj.value);
  }
  const v = (obj as { value?: unknown })?.value;
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  return 0n;
}

async function getApprovedLimit(
  agentId: number,
  client: string,
  senderAddress: string,
): Promise<bigint> {
  const [addr, name] = splitContract(REPUTATION_CONTRACT);
  const result = await fetchCallReadOnlyFunction({
    contractAddress: addr,
    contractName: name,
    functionName: "get-approved-limit",
    functionArgs: [uintCV(agentId), standardPrincipalCV(client)],
    network: STACKS_MAINNET,
    senderAddress,
  });
  return parseUintScalar(cvToJSON(result));
}

async function getLastIndex(
  agentId: number,
  client: string,
  senderAddress: string,
): Promise<bigint> {
  const [addr, name] = splitContract(REPUTATION_CONTRACT);
  const result = await fetchCallReadOnlyFunction({
    contractAddress: addr,
    contractName: name,
    functionName: "get-last-index",
    functionArgs: [uintCV(agentId), standardPrincipalCV(client)],
    network: STACKS_MAINNET,
    senderAddress,
  });
  return parseUintScalar(cvToJSON(result));
}

async function getStxBalance(stxAddress: string): Promise<bigint> {
  const res = await fetchWithTimeout(`${HIRO_API}/v2/accounts/${stxAddress}?proof=0`);
  if (!res.ok) return 0n;
  const body = (await res.json()) as { balance: string };
  return BigInt(body.balance ?? "0");
}

async function broadcastContractCall(opts: {
  senderKey: string;
  contractAddress: string;
  contractName: string;
  functionName: string;
  functionArgs: ClarityValue[];
  fee?: bigint;
}): Promise<{ txid: string; explorer: string }> {
  const tx = await makeContractCall({
    contractAddress: opts.contractAddress,
    contractName: opts.contractName,
    functionName: opts.functionName,
    functionArgs: opts.functionArgs,
    senderKey: opts.senderKey,
    network: STACKS_MAINNET,
    postConditionMode: PostConditionMode.Deny,
    fee: opts.fee ?? DEFAULT_FEE_USTX,
  });
  const broadcast = await broadcastTransaction({
    transaction: tx,
    network: STACKS_MAINNET,
  });
  if ("error" in broadcast) {
    throw new Error(
      `broadcast failed: ${broadcast.error} ${(broadcast as { reason?: string }).reason ?? ""}`,
    );
  }
  return { txid: broadcast.txid, explorer: getExplorerTxUrl(broadcast.txid, NETWORK) };
}

function requireConfirm(opts: { confirm?: string }): void {
  if (opts.confirm !== CONFIRM_TOKEN) {
    emit({
      status: "blocked",
      action: "confirm-check",
      data: { required: CONFIRM_TOKEN },
      error: {
        code: "missing-confirm",
        message: `This command writes on-chain. Pass --confirm=${CONFIRM_TOKEN} to proceed.`,
        next: `Re-run with --confirm=${CONFIRM_TOKEN}.`,
      },
    });
  }
}

async function unlockWallet(): Promise<{
  wallet: WalletInfo;
  privateKey: string;
  lock: () => Promise<void>;
}> {
  const password = process.env.AIBTC_WALLET_PASSWORD;
  if (!password) {
    throw new Error("AIBTC_WALLET_PASSWORD env var is required.");
  }
  const manager = getWalletManager();
  const activeId = await manager.getActiveWalletId();
  if (!activeId) throw new Error("No active AIBTC wallet found.");
  const account = await manager.unlock(activeId, password);
  const wallet: WalletInfo = {
    id: activeId,
    stxAddress: account.address,
    btcAddress: account.btcAddress ?? "",
  };
  return {
    wallet,
    privateKey: account.privateKey,
    lock: async () => {
      try {
        await manager.lock();
      } catch {
        // already locked is fine
      }
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Commands
// ────────────────────────────────────────────────────────────────────────────

async function cmdDoctor(): Promise<void> {
  const checks: Record<string, unknown> = {
    reputationContract: REPUTATION_CONTRACT,
    identityContract: IDENTITY_CONTRACT,
    stateFile: STATE_FILE,
    stateFileExists: existsSync(STATE_FILE),
    confirmToken: CONFIRM_TOKEN,
    walletPasswordEnvSet: Boolean(process.env.AIBTC_WALLET_PASSWORD),
    sponsorApiKeyEnvSet: Boolean(process.env.SPONSOR_API_KEY),
  };
  let ok = true;

  try {
    const manager = getWalletManager();
    const activeId = await manager.getActiveWalletId();
    checks.walletFound = Boolean(activeId);
    checks.walletId = activeId;
    if (activeId) {
      const all = await manager.listWallets();
      const found = all.find((w) => w.id === activeId);
      checks.walletName = found?.name ?? null;
      checks.stxAddress = found?.address ?? null;
      checks.btcAddress = found?.btcAddress ?? null;
    } else {
      ok = false;
    }
  } catch (e: unknown) {
    checks.walletFound = false;
    checks.walletError = (e as Error).message;
    ok = false;
  }

  try {
    const res = await fetchWithTimeout(`${HIRO_API}/v2/info`);
    checks.hiroReachable = res.ok;
    if (!res.ok) ok = false;
  } catch {
    checks.hiroReachable = false;
    ok = false;
  }

  emit({
    status: ok ? "success" : "error",
    action: "doctor",
    data: checks,
    error: ok
      ? null
      : {
          code: "preflight-failed",
          message: "Doctor detected one or more failing checks.",
          next: "Inspect data fields and resolve before running writes.",
        },
  });
}

function cmdInstallPacks(): void {
  emit({
    status: "success",
    action: "install-packs",
    data: {
      runtime: "bun",
      packages: [
        "@aibtc/mcp-server",
        "@stacks/transactions",
        "@stacks/network",
        "commander",
      ],
      install:
        "bun install @aibtc/mcp-server @stacks/transactions @stacks/network commander",
    },
    error: null,
  });
}

async function cmdStatus(opts: { agentId?: string }): Promise<void> {
  const manager = getWalletManager();
  const activeId = await manager.getActiveWalletId();
  if (!activeId) {
    emit({
      status: "error",
      action: "status",
      data: {},
      error: {
        code: "no-wallet",
        message: "No active AIBTC wallet.",
        next: "Run wallet_create or wallet_import via AIBTC MCP.",
      },
    });
  }

  const wallets = await manager.listWallets();
  const active = wallets.find((w) => w.id === activeId);
  const senderAddress = active?.address ?? "";
  const agentIdArg = opts.agentId ? Number(opts.agentId) : null;
  let summary: ReputationSummary | null = null;
  if (agentIdArg !== null && Number.isInteger(agentIdArg) && agentIdArg >= 0) {
    summary = await getReputationSummary(agentIdArg, senderAddress);
  }

  const state = loadState();
  emit({
    status: "success",
    action: "status",
    data: {
      wallet: {
        id: activeId,
        name: active?.name ?? null,
        stxAddress: active?.address ?? null,
        btcAddress: active?.btcAddress ?? null,
      },
      queriedAgentId: agentIdArg,
      reputationSummary: summary,
      approvedClients: state.approvedClients,
      respondedFeedbackKeys: state.respondedFeedback,
      feedbackCooldowns: state.feedbackCooldowns,
      lastRun: state.lastRun ?? null,
    },
    error: null,
  });
}

async function cmdApproveClient(opts: {
  agentId?: string;
  client?: string;
  indexLimit?: string;
  confirm?: string;
}): Promise<void> {
  requireConfirm(opts);
  const agentId = Number(opts.agentId);
  const client = String(opts.client ?? "");
  const indexLimit = Number(opts.indexLimit ?? DEFAULT_INDEX_LIMIT);
  if (!Number.isInteger(agentId) || agentId < 0) throw new Error("Invalid --agent-id.");
  if (!/^S[PT][0-9A-Z]{38,39}$/.test(client)) throw new Error("Invalid --client STX address.");
  if (!Number.isInteger(indexLimit) || indexLimit <= 0)
    throw new Error("Invalid --index-limit.");

  const { wallet, privateKey, lock } = await unlockWallet();
  try {
    await requireOwnership("approve-client", agentId, wallet.stxAddress);
    const [addr, name] = splitContract(REPUTATION_CONTRACT);
    const { txid, explorer } = await broadcastContractCall({
      senderKey: privateKey,
      contractAddress: addr,
      contractName: name,
      functionName: "approve-client",
      functionArgs: [uintCV(agentId), standardPrincipalCV(client), uintCV(indexLimit)],
    });
    const state = loadState();
    if (!state.approvedClients.some((a) => a.agentId === agentId && a.client === client)) {
      state.approvedClients.push({ agentId, client });
    }
    saveState(state);
    emit({
      status: "success",
      action: "approve-client",
      data: { txid, explorer, agentId, client, indexLimit },
      error: null,
    });
  } finally {
    await lock();
  }
}

async function cmdSubmitFeedback(opts: {
  agentId?: string;
  value?: string;
  valueDecimals?: string;
  tag1?: string;
  tag2?: string;
  endpoint?: string;
  feedbackUri?: string;
  feedbackHash?: string;
  cooldownDays?: string;
  confirm?: string;
}): Promise<void> {
  requireConfirm(opts);
  const agentId = Number(opts.agentId);
  const value = parseBigIntArg(opts.value, "--value");
  const valueDecimals = Number(opts.valueDecimals ?? "0");
  const cooldownDays = Number(opts.cooldownDays ?? DEFAULT_COOLDOWN_DAYS);
  if (!Number.isInteger(agentId) || agentId < 0) throw new Error("Invalid --agent-id.");
  if (!Number.isInteger(valueDecimals) || valueDecimals < 0 || valueDecimals > 18)
    throw new Error("Invalid --value-decimals (0..18).");
  if (!opts.feedbackUri) throw new Error("--feedback-uri is required.");

  const state = loadState();
  if (cooldownActive(state, agentId, cooldownDays)) {
    emit({
      status: "blocked",
      action: "submit-feedback",
      data: {
        agentId,
        cooldownDays,
        lastFeedback: state.feedbackCooldowns[String(agentId)],
      },
      error: {
        code: "cooldown-active",
        message: `Already rated agent ${agentId} within the last ${cooldownDays} days.`,
        next: "Wait for cooldown to expire or adjust --cooldown-days.",
      },
    });
  }

  const { wallet, privateKey, lock } = await unlockWallet();
  try {
    await requireNotSelfFeedback(agentId, wallet.stxAddress);

    const approvedLimit = await getApprovedLimit(agentId, wallet.stxAddress, wallet.stxAddress);
    const lastIdx = await getLastIndex(agentId, wallet.stxAddress, wallet.stxAddress);
    const useApprovedFn = approvedLimit > lastIdx;
    const functionName = useApprovedFn ? "give-feedback-approved" : "give-feedback";

    const [addr, name] = splitContract(REPUTATION_CONTRACT);
    const args: ClarityValue[] = [
      uintCV(agentId),
      intCV(value),
      uintCV(valueDecimals),
      utf8CV(opts.tag1 ?? "", MAX_TAG_LEN),
      utf8CV(opts.tag2 ?? "", MAX_TAG_LEN),
      utf8CV(opts.endpoint ?? "", MAX_URI_LEN),
      utf8CV(opts.feedbackUri, MAX_URI_LEN),
      hashCV(opts.feedbackHash),
    ];
    const { txid, explorer } = await broadcastContractCall({
      senderKey: privateKey,
      contractAddress: addr,
      contractName: name,
      functionName,
      functionArgs: args,
    });
    state.feedbackCooldowns[String(agentId)] = new Date().toISOString();
    saveState(state);
    emit({
      status: "success",
      action: "submit-feedback",
      data: {
        txid,
        explorer,
        functionName,
        agentId,
        value,
        valueDecimals,
        tag1: opts.tag1 ?? null,
        tag2: opts.tag2 ?? null,
        feedbackUri: opts.feedbackUri,
        approvedLimitSeen: approvedLimit.toString(),
        lastIndexSeen: lastIdx.toString(),
      },
      error: null,
    });
  } finally {
    await lock();
  }
}

async function cmdRespond(opts: {
  agentId?: string;
  client?: string;
  index?: string;
  responseUri?: string;
  responseHash?: string;
  confirm?: string;
}): Promise<void> {
  requireConfirm(opts);
  const agentId = Number(opts.agentId);
  const client = String(opts.client ?? "");
  const index = Number(opts.index);
  if (!Number.isInteger(agentId) || agentId < 0) throw new Error("Invalid --agent-id.");
  if (!/^S[PT][0-9A-Z]{38,39}$/.test(client)) throw new Error("Invalid --client STX address.");
  if (!Number.isInteger(index) || index < 0) throw new Error("Invalid --index.");
  if (!opts.responseUri || !opts.responseHash)
    throw new Error("Both --response-uri and --response-hash are required.");

  const state = loadState();
  const key = `${agentId}:${client}:${index}`;
  if (state.respondedFeedback.includes(key)) {
    emit({
      status: "blocked",
      action: "respond",
      data: { key },
      error: {
        code: "already-responded",
        message: `Already responded to ${key}.`,
        next: "Remove entry from state file to force retry.",
      },
    });
  }

  const { wallet, privateKey, lock } = await unlockWallet();
  try {
    await requireOwnership("respond", agentId, wallet.stxAddress);
    const [addr, name] = splitContract(REPUTATION_CONTRACT);
    const { txid, explorer } = await broadcastContractCall({
      senderKey: privateKey,
      contractAddress: addr,
      contractName: name,
      functionName: "append-response",
      functionArgs: [
        uintCV(agentId),
        standardPrincipalCV(client),
        uintCV(index),
        utf8CV(opts.responseUri, MAX_URI_LEN),
        hashCV(opts.responseHash),
      ],
    });
    state.respondedFeedback.push(key);
    saveState(state);
    emit({
      status: "success",
      action: "respond",
      data: { txid, explorer, agentId, client, index },
      error: null,
    });
  } finally {
    await lock();
  }
}

async function cmdRun(opts: {
  mode?: string;
  maxActionsPerRun?: string;
  cooldownDays?: string;
  minGasReserveUstx?: string;
  confirm?: string;
}): Promise<void> {
  requireConfirm(opts);
  const mode = opts.mode ?? "auto";
  const maxActions = Number(opts.maxActionsPerRun ?? DEFAULT_MAX_ACTIONS_PER_RUN);
  const cooldownDays = Number(opts.cooldownDays ?? DEFAULT_COOLDOWN_DAYS);
  const minGas = BigInt(opts.minGasReserveUstx ?? "100000");
  if (mode !== "auto" && mode !== "batch")
    throw new Error("--mode must be 'auto' or 'batch'.");

  const { wallet, lock } = await unlockWallet();
  try {
    const stxBal = await getStxBalance(wallet.stxAddress);
    if (stxBal < minGas) {
      emit({
        status: "blocked",
        action: "run",
        data: { stxBalance: stxBal.toString(), minGasReserveUstx: minGas.toString() },
        error: {
          code: "insufficient-gas",
          message: `STX balance ${stxBal} below --min-gas-reserve-ustx ${minGas}.`,
          next: "Fund the wallet with STX before retrying.",
        },
      });
    }

    const state = loadState();
    const planned: Array<{ agentId: number; client: string; indexLimit: string }> = [];
    for (const entry of state.approvedClients) {
      if (planned.length >= maxActions) break;
      try {
        const approvedLimit = await getApprovedLimit(
          entry.agentId,
          entry.client,
          wallet.stxAddress,
        );
        if (approvedLimit > 0n) {
          planned.push({
            agentId: entry.agentId,
            client: entry.client,
            indexLimit: approvedLimit.toString(),
          });
        }
      } catch {
        // skip unresolvable clients
      }
    }

    saveState(state);
    emit({
      status: "success",
      action: "run",
      data: {
        mode,
        maxActions,
        cooldownDays,
        stxBalance: stxBal.toString(),
        planned,
        note: "run mode currently surveys approved-client state only. Use submit-feedback / respond / approve-client directly for writes.",
      },
      error: null,
    });
  } finally {
    await lock();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// CLI
// ────────────────────────────────────────────────────────────────────────────

const program = new Command();
program
  .name("agent-trust-ledger")
  .description("ERC-8004 reputation writes for AIBTC agents.");

program.command("doctor").action(async () => {
  try {
    await cmdDoctor();
  } catch (e: unknown) {
    handleTopLevel(e, "doctor", {});
  }
});

program.command("install-packs").action(() => {
  try {
    cmdInstallPacks();
  } catch (e: unknown) {
    handleTopLevel(e, "install-packs", {});
  }
});

program
  .command("status")
  .option("--agent-id <id>", "agent ID to query reputation for")
  .action(async (opts) => {
    try {
      await cmdStatus(opts);
    } catch (e: unknown) {
      handleTopLevel(e, "status", opts as Record<string, unknown>);
    }
  });

program
  .command("approve-client")
  .requiredOption("--agent-id <id>", "your agent ID")
  .requiredOption("--client <stxAddress>", "Stacks address of the client to approve")
  .option("--index-limit <n>", "max feedback index approved", String(DEFAULT_INDEX_LIMIT))
  .requiredOption("--confirm <token>", `must equal ${CONFIRM_TOKEN}`)
  .action(async (opts) => {
    try {
      await cmdApproveClient(opts);
    } catch (e: unknown) {
      handleTopLevel(e, "approve-client", opts as Record<string, unknown>);
    }
  });

program
  .command("submit-feedback")
  .requiredOption("--agent-id <id>", "agent ID receiving feedback")
  .requiredOption("--value <n>", "rating value (integer; scaled by --value-decimals)")
  .option("--value-decimals <n>", "decimals for value (0..18)", "0")
  .option("--tag1 <s>", "venue tag (utf-8, max 64)")
  .option("--tag2 <s>", "service tag (utf-8, max 64)")
  .option("--endpoint <s>", "optional endpoint URL (utf-8, max 512)")
  .requiredOption("--feedback-uri <url>", "off-chain context URI (utf-8, max 512)")
  .option(
    "--feedback-hash <hex>",
    "32-byte hex hash of context (defaults to zero hash)",
  )
  .option(
    "--cooldown-days <n>",
    "days between ratings of same counterparty",
    String(DEFAULT_COOLDOWN_DAYS),
  )
  .requiredOption("--confirm <token>", `must equal ${CONFIRM_TOKEN}`)
  .action(async (opts) => {
    try {
      await cmdSubmitFeedback(opts);
    } catch (e: unknown) {
      handleTopLevel(e, "submit-feedback", opts as Record<string, unknown>);
    }
  });

program
  .command("respond")
  .requiredOption("--agent-id <id>", "your agent ID receiving the original feedback")
  .requiredOption("--client <stxAddress>", "client who filed the feedback")
  .requiredOption("--index <n>", "feedback index")
  .requiredOption("--response-uri <url>", "response content URI (utf-8, max 512)")
  .requiredOption("--response-hash <hex>", "32-byte hex hash of response")
  .requiredOption("--confirm <token>", `must equal ${CONFIRM_TOKEN}`)
  .action(async (opts) => {
    try {
      await cmdRespond(opts);
    } catch (e: unknown) {
      handleTopLevel(e, "respond", opts as Record<string, unknown>);
    }
  });

program
  .command("run")
  .option("--mode <s>", "auto | batch", "auto")
  .option("--max-actions-per-run <n>", "cap per invocation", String(DEFAULT_MAX_ACTIONS_PER_RUN))
  .option(
    "--cooldown-days <n>",
    "per-counterparty cooldown",
    String(DEFAULT_COOLDOWN_DAYS),
  )
  .option("--min-gas-reserve-ustx <n>", "minimum STX balance to proceed", "100000")
  .requiredOption("--confirm <token>", `must equal ${CONFIRM_TOKEN}`)
  .action(async (opts) => {
    try {
      await cmdRun(opts);
    } catch (e: unknown) {
      handleTopLevel(e, "run", opts as Record<string, unknown>);
    }
  });

// Route all Commander parse errors (missing required option, unknown option,
// unknown command) through our JSON/exit contract. exitOverride and silent
// output need to be set on the root AND every subcommand for Commander 12.
const silentOutput = { writeOut: () => {}, writeErr: () => {} };
program.exitOverride().configureOutput(silentOutput);
for (const sub of program.commands) {
  sub.exitOverride().configureOutput(silentOutput);
}

program.parseAsync(process.argv).catch((e: unknown) => {
  try {
    const err = e as { code?: string; exitCode?: number; message?: string };
    // Commander help/version are intentional clean exits.
    if (err?.code === "commander.helpDisplayed" || err?.code === "commander.version") {
      process.exit(0);
    }
    // Commander parse errors (missing required options, unknown command) are
    // routed through the JSON/exit contract so machine callers never see
    // plain-text stderr for any invocation of this CLI.
    if (typeof err?.code === "string" && err.code.startsWith("commander.")) {
      emit({
        status: "blocked",
        action: "cli",
        data: { commanderCode: err.code },
        error: {
          code: "cli-parse-error",
          message: err.message ?? "Commander parse error.",
          next: "Check usage; re-run with required flags.",
        },
      });
    }
    handleTopLevel(e, "cli", {});
  } catch (e2: unknown) {
    if (e2 instanceof SkillExit) process.exit(e2.code);
    process.exit(1);
  }
});

