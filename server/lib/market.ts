// A market snapshot of every US-listed stock - price, market cap, valuation
// multiples, volume, performance - from TradingView's screener endpoint
// (the one tradingview.com's own stock screener uses; unofficial). One
// request per 5,000 symbols, refreshed every half hour in the background;
// the screener joins it to the SEC universe by ticker.

import { store } from './store.ts';
import { MARKET_FIELDS } from './marketFields.ts';

export { MARKET_FIELDS };

const URL = 'https://scanner.tradingview.com/america/scan';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const TTL = 30 * 60 * 1000;
const PAGE = 5000;

// [scanner column, our key]
export const COLUMNS = [
  ['name', 'symbol'],
  ['close', 'price'],
  ['currency', 'currency'],
  ['change', 'change'], // % on the day
  ['volume', 'volume'],
  ['average_volume_30d_calc', 'avgVolume'],
  ['market_cap_basic', 'marketCap'],
  ['total_shares_outstanding_fundamental', 'sharesOutstanding'],
  ['price_earnings_ttm', 'pe'],
  ['price_book_fq', 'pb'],
  ['price_sales_ratio', 'ps'],
  ['price_free_cash_flow_ttm', 'pfcf'],
  ['enterprise_value_ebitda_ttm', 'evEbitda'],
  ['dividends_yield_current', 'divYield'],
  ['price_earnings_growth_ttm', 'peg'],
  ['Perf.YTD', 'perfYtd'],
  ['Perf.Y', 'perfY'],
  ['price_52_week_high', 'high52'],
  ['price_52_week_low', 'low52'],
  ['beta_1_year', 'beta'],
  ['exchange', 'exchange'],
  ['type', 'type'],
  ['subtype', 'subtype'],
  ['sector', 'sector'],
  ['industry', 'industry'],
];

let memo = null; // { at, byTicker, count, updatedAt }
let refreshing = null;

const edgarTicker = (s) => String(s).toUpperCase().replace(/\./g, '-');

async function page(from) {
  const body = {
    filter: [{ left: 'type', operation: 'in_range', right: ['stock', 'dr'] }],
    options: { lang: 'en' },
    symbols: { query: { types: [] }, tickers: [] },
    columns: COLUMNS.map(([c]) => c),
    sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' },
    range: [from, from + PAGE],
  };
  const res = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Origin: 'https://www.tradingview.com' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`scanner.tradingview.com returned ${res.status}`);
  return res.json();
}

async function fetchSnapshot() {
  const byTicker = {};
  let total = Infinity;
  for (let from = 0; from < total && from < 40_000; from += PAGE) {
    const j = await page(from);
    total = j.totalCount ?? 0;
    for (const row of j.data || []) {
      const rec = {};
      COLUMNS.forEach(([, key], i) => (rec[key] = row.d[i] ?? null));
      if (!rec.symbol || !(rec.price > 0)) continue;
      // one record per EDGAR ticker: the common share, not a preferred / warrant with the same root
      if (rec.subtype && !/^(common|foreign-issuer|dr|)$/.test(rec.subtype)) continue;
      const t = edgarTicker(rec.symbol);
      if (byTicker[t] && (byTicker[t].marketCap ?? 0) >= (rec.marketCap ?? 0)) continue;
      rec.tv = row.s; // EXCHANGE:SYMBOL
      byTicker[t] = rec;
    }
    if (!j.data?.length) break;
  }
  return { updatedAt: new Date().toISOString(), count: Object.keys(byTicker).length, byTicker };
}

// The snapshot: memory, else the saved copy, refreshed when older than TTL.
export async function marketSnapshot({ wait = false } = {}) {
  if (!memo) {
    const saved = store.getKV('market:snapshot');
    if (saved) memo = { ...saved.value, at: Date.now() - saved.ageMs };
  }
  const stale = !memo || Date.now() - memo.at > TTL;
  if (stale && !refreshing) {
    refreshing = fetchSnapshot()
      .then((snap) => {
        memo = { ...snap, at: Date.now() };
        store.putKV('market:snapshot', snap);
        console.log(`market snapshot: ${snap.count.toLocaleString()} tickers from TradingView`);
      })
      .catch((err) => console.warn(`market snapshot failed: ${err.message}`))
      .finally(() => (refreshing = null));
  }
  if (memo && !(wait && stale)) return memo;
  if (refreshing) await refreshing;
  return memo;
}

export const marketStatus = () => ({ count: memo?.count ?? 0, updatedAt: memo?.updatedAt ?? null, refreshing: !!refreshing });
