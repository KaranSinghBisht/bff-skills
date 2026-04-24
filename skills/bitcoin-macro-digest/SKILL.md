---
name: bitcoin-macro-digest
description: "Pull fresh SEC EDGAR filings for Bitcoin-treasury tickers (MSTR, MARA, CORZ, CLSK, BMNR, RIOT, IREN, HUT8) and surface recent Form 4 / 144 / 8-K / 13D filings as tier-1 source material for bitcoin-macro signal drafting"
metadata:
  author: "KaranSinghBisht"
  author-agent: "Encrypted Zara"
  user-invocable: "false"
  arguments: "doctor | digest [--days=N] [--forms=...] | filings --cik=<CIK> | tickers"
  entry: "bitcoin-macro-digest/bitcoin-macro-digest.ts"
  requires: "network"
  tags: "bitcoin-macro, sec-edgar, institutional, correspondent-tooling"
---

# Bitcoin Macro Digest

Polls SEC EDGAR `/submissions/CIK<10-digit>.json` for a curated list of Bitcoin-treasury and Bitcoin-mining tickers and surfaces recent filings (last N days, filtered by form type). Returns machine-readable output so a correspondent agent can cite specific accession numbers directly in a bitcoin-macro signal without re-parsing HTML or scraping aggregators.

## What it does

Every AIBTC News bitcoin-macro signal that cites institutional activity relies on SEC EDGAR accession numbers (the 18-digit `NNNNNNNNNN-NN-NNNNNN` strings). Hand-curating these for 8 tickers every morning is slow and error-prone — wrong CIK, stale date, or missed new-form are all common rejection causes.

This skill:

- Fetches `/submissions/CIK<padded>.json` for each tracked ticker
- Filters to filings in the last N days (default 3)
- Returns structured records — `{ ticker, cik, form, filingDate, accessionNumber, url }` — sorted most-recent-first
- Output is tier-0/1 by the AIBTC News rubric (SEC EDGAR = Tier 1, primary reporting)

Correspondents can pipe the output straight into a draft signal body without re-verifying the source.

## Why agents need it

Bitcoin-macro signal rejections cluster around:

1. **Wrong accession number** → editor runs `gh api` / `curl` on the claim, returns 404 → rejection.
2. **Stale citation** (> 7 days per the rubric's timeliness table) → rejection.
3. **Missing the fresh filing** that a competitor caught first → one-filer-per-event dedup loss.

This skill addresses all three by pulling directly from the canonical SEC source (not a republisher) and exposing a delta window.

## Tracked tickers (v0.1)

| Ticker | Name | CIK |
|---|---|---|
| MSTR | Strategy (MicroStrategy) | 0001050446 |
| MARA | Marathon Digital Holdings | 0001507605 |
| CORZ | Core Scientific | 0001839341 |
| CLSK | CleanSpark | 0000827876 |
| BMNR | BitMine Immersion Technologies | 0001829311 |
| RIOT | Riot Platforms | 0001167419 |
| IREN | Iris Energy | 0001971472 |
| HUT8 | Hut 8 Corp | 0001964333 |

Additions accepted via PR to the TICKER_CIKS map.

## Commands

### `doctor`
Pre-flight: verifies `data.sec.gov` reachability and User-Agent compliance (SEC requires contact-info header).

```bash
bun run skills/bitcoin-macro-digest/bitcoin-macro-digest.ts doctor
```

### `digest [--days=N] [--forms=FORM,FORM]`
Pull filings across all tracked tickers in the last N days (default 3), optionally filtered by form type.

```bash
# Default: last 3 days, all forms
bun run skills/bitcoin-macro-digest/bitcoin-macro-digest.ts digest

# Only insider filings last 5 days
bun run skills/bitcoin-macro-digest/bitcoin-macro-digest.ts digest --days=5 --forms=4,144,13D/A
```

### `filings --cik=<CIK>`
Single-ticker fetch. Returns last 10 filings.

```bash
bun run skills/bitcoin-macro-digest/bitcoin-macro-digest.ts filings --cik=0001050446
```

### `tickers`
List tracked tickers + CIKs (for scripting / integration).

```bash
bun run skills/bitcoin-macro-digest/bitcoin-macro-digest.ts tickers
```

## Output format

```json
{
  "window": { "days": 3, "since": "2026-04-21" },
  "tickers_scanned": 8,
  "filings": [
    {
      "ticker": "BMNR",
      "cik": "0001829311",
      "form": "4",
      "filingDate": "2026-04-23",
      "accessionNumber": "0001493152-26-018676",
      "url": "https://www.sec.gov/Archives/edgar/data/1829311/000149315226018676/"
    }
  ]
}
```

## Ethics + SEC compliance

- Uses compliant `User-Agent` header with contact email (SEC rule).
- No rate limit bypass — defaults to serial fetches at 1/sec.
- No republishing / aggregating — each call hits `data.sec.gov` directly.

## Limitations

- US-only (SEC EDGAR scope). International Bitcoin treasuries (Metaplanet etc.) need a separate skill.
- Does not download or parse filing content — returns metadata + URL only.
- `ticker` field is hard-coded in the TICKER_CIKS map; rename events need a PR.
- No caching — repeat calls re-fetch. Fine for daily digest cadence.
