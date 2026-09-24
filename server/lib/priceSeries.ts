// Share prices for the valuation page: daily closes from the same source
// chain as the custom-ETF charts (TradingView, then IBKR TWS, then Yahoo) -
// fetched when the page is viewed, cached half an hour, no live quote: "now"
// is the last daily close. All three sources give split-adjusted closes; the
// split events (Yahoo, cached a day) go along so valuation.js can turn them
// back into the prices of the day, which is what EPS and share counts of old
// filings line up with.

import { store } from './store.ts';
import { dailyBars } from './bars.ts';
import { yahooSymbol } from './prices.ts';

const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const EVENTS_TTL = 24 * 3600 * 1000;

// split and dividend events of the last ten years (a coarse interval keeps the payload small)
async function events(ticker) {
  const symbol = yahooSymbol(ticker);
  const key = `events:${symbol}`;
  const saved = store.getKV(key);
  if (saved && saved.ageMs < EVENTS_TTL) return saved.value;
  try {
    const url = `${YAHOO}${encodeURIComponent(symbol)}?${new URLSearchParams({ range: '10y', interval: '3mo', events: 'div|splits' })}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Yahoo Finance returned ${res.status}`);
    const r = (await res.json()).chart?.result?.[0];
    if (!r) throw new Error('no data');
    const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
    const value = {
      splits: Object.values(r.events?.splits || {})
        .map((s) => ({ date: day(s.date), ratio: s.numerator / s.denominator }))
        .sort((a, b) => (a.date < b.date ? -1 : 1)),
      dividends: Object.values(r.events?.dividends || {})
        .map((d) => ({ date: day(d.date), amount: d.amount }))
        .sort((a, b) => (a.date < b.date ? -1 : 1)),
    };
    store.putKV(key, value);
    return value;
  } catch (err) {
    if (saved) return saved.value;
    return { splits: [], dividends: [], error: err.message };
  }
}

// { symbol, source, currency, days: [{ date, close (split-adjusted) }], splits, dividends, fetchedAt }
export async function priceSeries(ticker) {
  const [bars, ev] = await Promise.all([dailyBars(ticker), events(ticker)]);
  return {
    symbol: bars.symbol,
    source: bars.source,
    currency: bars.currency || 'USD',
    days: bars.days.map((d) => ({ date: d.date, close: d.close })),
    splits: ev.splits,
    dividends: ev.dividends,
    eventsError: ev.error || null,
    fetchedAt: bars.fetchedAt,
  };
}
