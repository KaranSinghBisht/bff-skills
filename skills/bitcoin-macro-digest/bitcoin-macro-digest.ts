#!/usr/bin/env bun
/**
 * bitcoin-macro-digest
 *
 * Pulls fresh SEC EDGAR filings for Bitcoin-treasury and Bitcoin-mining
 * tickers. Surfaces recent Form 4 / 144 / 8-K / 13D filings as tier-1
 * source material for AIBTC News bitcoin-macro signal drafting.
 *
 * Author: Encrypted Zara (@KaranSinghBisht)
 * Skill Comp submission: 2026-04-24
 */

const TICKER_CIKS: Record<string, string> = {
  MSTR: "0001050446", // Strategy (formerly MicroStrategy)
  MARA: "0001507605", // Marathon Digital Holdings
  CORZ: "0001839341", // Core Scientific
  CLSK: "0000827876", // CleanSpark
  BMNR: "0001829311", // BitMine Immersion Technologies
  RIOT: "0001167419", // Riot Platforms
  IREN: "0001971472", // Iris Energy
  HUT8: "0001964333", // Hut 8 Corp
};

const SEC_BASE = "https://data.sec.gov/submissions";
const SEC_ARCHIVES = "https://www.sec.gov/Archives/edgar/data";
const SEC_UA_EMAIL = process.env.SEC_UA_EMAIL ?? "bitcoin-macro-digest@aibtc.local";
const USER_AGENT = `bitcoin-macro-digest/0.1 (${SEC_UA_EMAIL})`;
const FETCH_DELAY_MS = 1100; // SEC fair-use: 1 req/sec. 1.1s adds headroom.

interface Filing {
  ticker: string;
  cik: string;
  form: string;
  filingDate: string;
  accessionNumber: string;
  url: string;
}

interface DigestOptions {
  days?: number;
  forms?: string[];
}

interface DigestResult {
  window: { days: number; since: string };
  tickers_scanned: number;
  filings: Filing[];
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  return res.json();
}

function accessionToUrl(cik: string, accession: string): string {
  const cikNoLead = String(Number(cik));
  const cleanAcc = accession.replace(/-/g, "");
  return `${SEC_ARCHIVES}/${cikNoLead}/${cleanAcc}/`;
}

function daysAgoISO(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchFilingsForCIK(
  cik: string,
  ticker: string,
): Promise<Filing[]> {
  const url = `${SEC_BASE}/CIK${cik}.json`;
  const data = await fetchJson(url);
  const recent = data?.filings?.recent;
  if (!recent || !Array.isArray(recent.form)) return [];

  const out: Filing[] = [];
  const n = Math.min(
    recent.form.length ?? 0,
    recent.filingDate?.length ?? 0,
    recent.accessionNumber?.length ?? 0,
  );
  for (let i = 0; i < n; i++) {
    const form: string = recent.form[i];
    const filingDate: string = recent.filingDate[i];
    const accessionNumber: string = recent.accessionNumber[i];
    out.push({
      ticker,
      cik,
      form,
      filingDate,
      accessionNumber,
      url: accessionToUrl(cik, accessionNumber),
    });
  }
  return out;
}

export async function runDoctor(): Promise<void> {
  const probe = Object.entries(TICKER_CIKS)[0];
  const [ticker, cik] = probe;
  try {
    const data = await fetchJson(`${SEC_BASE}/CIK${cik}.json`);
    const formsLen = data?.filings?.recent?.form?.length ?? 0;
    console.log(
      JSON.stringify(
        {
          ok: true,
          probe_ticker: ticker,
          cik,
          user_agent: USER_AGENT,
          recent_forms_count: formsLen,
          note: "SEC EDGAR reachable and returned a valid submissions response.",
        },
        null,
        2,
      ),
    );
  } catch (err: any) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          probe_ticker: ticker,
          cik,
          user_agent: USER_AGENT,
          error: err.message ?? String(err),
          hint: "If HTTP 403, check that SEC_UA_EMAIL is set to a real contact email.",
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }
}

export async function runDigest(opts: DigestOptions = {}): Promise<DigestResult> {
  const days = opts.days ?? 3;
  const since = daysAgoISO(days);
  const forms = opts.forms && opts.forms.length > 0 ? new Set(opts.forms) : null;

  const all: Filing[] = [];
  const entries = Object.entries(TICKER_CIKS);
  for (let i = 0; i < entries.length; i++) {
    const [ticker, cik] = entries[i];
    try {
      const items = await fetchFilingsForCIK(cik, ticker);
      for (const f of items) {
        if (f.filingDate < since) continue;
        if (forms && !forms.has(f.form)) continue;
        all.push(f);
      }
    } catch (err: any) {
      console.error(`[warn] ${ticker} (CIK${cik}) fetch failed: ${err.message ?? err}`);
    }
    if (i < entries.length - 1) await sleep(FETCH_DELAY_MS);
  }

  all.sort((a, b) => (a.filingDate < b.filingDate ? 1 : a.filingDate > b.filingDate ? -1 : 0));

  return {
    window: { days, since },
    tickers_scanned: entries.length,
    filings: all,
  };
}

export async function runFilings(cik: string): Promise<Filing[]> {
  const ticker =
    Object.entries(TICKER_CIKS).find(([_, c]) => c === cik.padStart(10, "0"))?.[0] ??
    "UNKNOWN";
  const padded = cik.padStart(10, "0");
  const items = await fetchFilingsForCIK(padded, ticker);
  return items.slice(0, 10);
}

export function runTickers(): { tickers: Array<{ ticker: string; cik: string }> } {
  return {
    tickers: Object.entries(TICKER_CIKS).map(([ticker, cik]) => ({ ticker, cik })),
  };
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const a of argv) {
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq === -1) {
      out[a.slice(2)] = true;
    } else {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flags = parseArgs(argv.slice(1));

  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(
      [
        "bitcoin-macro-digest — SEC EDGAR filings for Bitcoin-treasury tickers",
        "",
        "Commands:",
        "  doctor                                    Pre-flight SEC reachability check",
        "  digest [--days=N] [--forms=F,F,...]       Fresh filings across tracked tickers",
        "  filings --cik=<CIK>                       Last 10 filings for a single CIK",
        "  tickers                                   List tracked tickers and CIKs",
        "",
        "Env:",
        "  SEC_UA_EMAIL    Contact email for SEC User-Agent header (required by SEC policy)",
      ].join("\n"),
    );
    process.exit(0);
  }

  if (cmd === "doctor") {
    await runDoctor();
    return;
  }

  if (cmd === "tickers") {
    console.log(JSON.stringify(runTickers(), null, 2));
    return;
  }

  if (cmd === "digest") {
    const days = flags.days ? Number(flags.days) : 3;
    const forms = flags.forms
      ? String(flags.forms).split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    if (Number.isNaN(days) || days <= 0) {
      console.error("--days must be a positive integer");
      process.exit(2);
    }
    const result = await runDigest({ days, forms });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === "filings") {
    const cik = flags.cik ? String(flags.cik) : "";
    if (!cik) {
      console.error("filings requires --cik=<CIK>");
      process.exit(2);
    }
    const items = await runFilings(cik);
    console.log(JSON.stringify({ cik: cik.padStart(10, "0"), filings: items }, null, 2));
    return;
  }

  console.error(`unknown command: ${cmd}`);
  process.exit(2);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err?.stack ?? err);
    process.exit(1);
  });
}
