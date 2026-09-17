// Share prices. SEC has none, so these come from Yahoo Finance's public chart
// endpoint (no key needed): the current quote and ten years of daily closes.
// Yahoo's closes are split-adjusted; filings report EPS and share counts as
// they were at the time, so the split events are used to turn closes back
// into the prices actually quoted on each date.

import { store } from './store.js';

const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const UA = 'Mozilla/5.0'; // a full browser UA string gets 429 from Yahoo, this one does not
const QUOTE_TTL = 10 * 60 * 1000;
const HISTORY_TTL = 24 * 3600 * 1000;

const quotes = new Map(); // symbol -> { expires, value }

async function chart(symbol, params) {
  const url = `${YAHOO}${encodeURIComponent(symbol)}?${new URLSearchParams(params)}`;
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (res.status !== 429 || attempt >= 2) break;
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  if (!res.ok) throw Object.assign(new Error(`Yahoo Finance returned ${res.status} for ${symbol}`), { status: res.status === 404 ? 404 : 502 });
  const body = await res.json();
  const r = body.chart?.result?.[0];
  if (!r) throw Object.assign(new Error(body.chart?.error?.description || `No price data for ${symbol}`), { status: 404 });
  return r;
}

// Yahoo symbol: EDGAR tickers already use "-" for share classes (BRK-B).
export const yahooSymbol = (ticker) => String(ticker).toUpperCase().replace(/\./g, '-');

export async function quote(ticker) {
  const symbol = yahooSymbol(ticker);
  const hit = quotes.get(symbol);
  if (hit && hit.expires > Date.now()) return hit.value;
  const r = await chart(symbol, { range: '5d', interval: '1d' });
  const m = r.meta;
  const value = {
    symbol,
    price: m.regularMarketPrice ?? null,
    time: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null,
    currency: m.currency || null,
    exchange: m.fullExchangeName || m.exchangeName || null,
    previousClose: m.chartPreviousClose ?? null,
    source: 'Yahoo Finance',
  };
  quotes.set(symbol, { expires: Date.now() + QUOTE_TTL, value });
  return value;
}

// Daily closes for ten years: [{ date, close (as quoted then), adjClose (split-adjusted) }]
export async function history(ticker) {
  const symbol = yahooSymbol(ticker);
  const key = `prices:${symbol}`;
  const saved = store.getKV(key);
  if (saved && saved.ageMs < HISTORY_TTL) return saved.value;
  let r;
  try {
    r = await chart(symbol, { range: '10y', interval: '1d', events: 'div|splits' });
  } catch (err) {
    if (saved) return saved.value;
    throw err;
  }
  const closes = r.indicators?.quote?.[0]?.close || [];
  const splits = Object.values(r.events?.splits || {})
    .map((s) => ({ date: new Date(s.date * 1000).toISOString().slice(0, 10), ratio: s.numerator / s.denominator }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const dividends = Object.values(r.events?.dividends || {})
    .map((d) => ({ date: new Date(d.date * 1000).toISOString().slice(0, 10), amount: d.amount }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const days = [];
  (r.timestamp || []).forEach((t, i) => {
    if (typeof closes[i] !== 'number') return;
    const date = new Date(t * 1000).toISOString().slice(0, 10);
    // undo every split that happened after this day
    let factor = 1;
    for (const s of splits) if (s.date > date) factor *= s.ratio;
    days.push({ date, adjClose: closes[i], close: closes[i] * factor });
  });
  const value = { symbol, currency: r.meta?.currency || null, days, splits, dividends, fetchedAt: new Date().toISOString(), source: 'Yahoo Finance' };
  store.putKV(key, value);
  return value;
}
