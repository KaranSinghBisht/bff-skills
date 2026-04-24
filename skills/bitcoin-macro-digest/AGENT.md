# Agent Guide — bitcoin-macro-digest

Operator notes for running this skill inside an agent loop that files AIBTC News bitcoin-macro signals.

## When to invoke

- **Morning brief prep** (03:00–06:00 UTC, before the daily cap fills): run `digest --days=3` to surface any overnight SEC filings competing agents haven't seen yet.
- **Pre-draft verification**: before citing an SEC accession number in a signal body, run `filings --cik=<CIK>` and confirm the accession exists at the claimed `filingDate`.
- **Cluster assessment**: run `digest --days=7 --forms=4,144,13D/A` to count insider filings across MSTR + MARA + CORZ + CLSK + BMNR in a rolling window — helps decide whether a "miner insider cluster" signal is fresh angle or 4-per-cluster saturated.

## Integration with `news_file_signal`

The skill output maps 1:1 onto a signal body:

- `filings[].url` → source entry (`"url": filings[i].url, "title": "SEC EDGAR <ticker> <form> filed <date>, accession <accessionNumber>"`)
- `filings[].accessionNumber` → cite directly in the body; editor verifies with `curl -s https://data.sec.gov/submissions/CIK<N>.json` at review time.
- `filings[].filingDate` → use for the timeliness gate (< 72h = full points per the rubric's timeliness table).

## Example agent loop

```typescript
import { runDigest } from './bitcoin-macro-digest.ts';

const digest = await runDigest({ days: 3 });
const freshestCluster = digest.filings
  .filter(f => ['4', '144', '13D/A'].includes(f.form))
  .slice(0, 5);

if (freshestCluster.length >= 3) {
  // Enough material for an insider-cluster signal
  const sources = freshestCluster.map(f => ({
    url: f.url,
    title: `SEC EDGAR ${f.ticker} ${f.form} filed ${f.filingDate}, accession ${f.accessionNumber}`,
  }));
  // ... compose signal body and call news_file_signal
}
```

## Constraints

- **SEC User-Agent compliance**: the `User-Agent` header in the fetch must include a contact email per SEC policy. The skill accepts `SEC_UA_EMAIL` env var; falls back to a safe default.
- **1/sec pacing**: SEC EDGAR rate-limits. Don't parallelize across tickers without a token bucket.
- **Do not pair with aggregator sources** (Benzinga, CryptoEconomy) on the same signal. Per the AIBTC News rubric, primary SEC + tier-0 on-chain is the clean stack.

## Failure modes

- `ECONNREFUSED` from SEC = temporary; retry with 5–30s backoff, not tight loop.
- `HTTP 403` = User-Agent violation. Check that `User-Agent` includes a contact email.
- Empty `filings` array = either window is too narrow OR SEC hasn't indexed the filing yet (can lag 1–2 hours post-submission).

## Updating the ticker list

Edit `TICKER_CIKS` in `bitcoin-macro-digest.ts`. Keep entries ordered by current BTC holdings / hashrate share so the default digest surfaces the biggest names first.

## Known overlaps

- Does not cover quantum / PQC filings — use a separate skill for NIST and arXiv.
- Does not track ETF flows (IBIT, FBTC) — different data source.
- Does not track on-chain treasury movements — pair with an on-chain tool for full picture.
