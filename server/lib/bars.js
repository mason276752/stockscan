// Daily OHLC bars and the custom-ETF ("basket") index built from them.
//
// Bars come from the IBKR TWS API when TWS / IB Gateway is running, otherwise
// from Yahoo Finance's chart endpoint; either way they are split-adjusted so
// a basket's history is continuous. (The valuation page keeps its own Yahoo
// price history in prices.js - it needs the unadjusted quotes of the day.)

import { store } from './store.js';
import { ibConnect, ibConnected, ibDailyBars, ibStatus } from './ib.js';
import { yahooSymbol } from './prices.js';

const BARS_TTL = 30 * 60 * 1000; // a basket of 30 names is 30 TWS requests; IB allows 60 per 10 minutes
const YEARS = 10;
const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';

async function yahooDailyBars(ticker) {
  const symbol = yahooSymbol(ticker);
  const url = `${YAHOO}${encodeURIComponent(symbol)}?${new URLSearchParams({ range: `${YEARS}y`, interval: '1d' })}`;
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (res.status !== 429 || attempt >= 2) break;
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  if (!res.ok) throw Object.assign(new Error(`Yahoo Finance returned ${res.status} for ${symbol}`), { status: res.status === 404 ? 404 : 502 });
  const body = await res.json();
  const r = body.chart?.result?.[0];
  if (!r) throw Object.assign(new Error(body.chart?.error?.description || `No price data for ${symbol}`), { status: 404 });
  const q = r.indicators?.quote?.[0] || {};
  const days = [];
  (r.timestamp || []).forEach((t, i) => {
    const c = q.close?.[i];
    if (typeof c !== 'number' || c <= 0) return;
    days.push({ date: new Date(t * 1000).toISOString().slice(0, 10), open: q.open?.[i] ?? c, high: q.high?.[i] ?? c, low: q.low?.[i] ?? c, close: c, volume: q.volume?.[i] ?? null });
  });
  return { days, currency: r.meta?.currency || null };
}

// { symbol, source: 'IBKR' | 'Yahoo Finance', currency, days: [{ date, open, high, low, close, volume }], fetchedAt }
export async function dailyBars(ticker) {
  const symbol = String(ticker).toUpperCase();
  const useIb = ibStatus().enabled && (ibConnected() || (await ibConnect(1500)));
  const key = `bars:${useIb ? 'ib' : 'yahoo'}:${symbol}`;
  const saved = store.getKV(key);
  if (saved && saved.ageMs < BARS_TTL) return saved.value;
  let value;
  try {
    if (useIb) {
      try {
        const days = await ibDailyBars(symbol, { years: YEARS });
        value = { symbol, source: 'IBKR', currency: 'USD', days };
      } catch (err) {
        // pacing violation, unknown contract, timeout: Yahoo for this symbol rather than a hole in the basket
        console.warn(`bars ${symbol}: ${err.message} - using Yahoo Finance`);
        const { days, currency } = await yahooDailyBars(symbol);
        value = { symbol, source: 'Yahoo Finance', currency, days };
      }
    } else {
      const { days, currency } = await yahooDailyBars(symbol);
      value = { symbol, source: 'Yahoo Finance', currency, days };
    }
  } catch (err) {
    if (saved) return saved.value; // stale beats nothing
    throw err;
  }
  if (!value.days.length) throw Object.assign(new Error(`No daily bars for ${symbol}`), { status: 404 });
  value.fetchedAt = new Date().toISOString();
  store.putKV(key, value);
  return value;
}

export const RANGES = { '1y': 1, '3y': 3, '5y': 5, '10y': 10, max: 10 };

function rangeStart(range, end) {
  const years = RANGES[range] || 5;
  const d = new Date(`${end}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

// Basket index, base 100 on the start date, from the constituents' bars.
//   rebalance 'none'  : buy and hold - weights are the allocation on the start date
//   rebalance 'daily' : weights are restored at every close
// The high / low of a day are the weighted highs / lows of the constituents,
// which slightly overstates the basket's true intraday range.
export function basketSeries(members, { range = '5y', rebalance = 'none', base = 100 } = {}) {
  const notes = [];
  const rows = members.filter((m) => m.days?.length);
  if (!rows.length) return { bars: [], start: null, end: null, notes: ['沒有任何成分股的價格資料'] };
  const wsum = rows.reduce((s, m) => s + (m.weight > 0 ? m.weight : 0), 0) || rows.length;
  const w = rows.map((m) => (m.weight > 0 ? m.weight : wsum / rows.length) / wsum);

  const last = rows.reduce((d, m) => (m.days.at(-1).date > d ? m.days.at(-1).date : d), '');
  let start = rangeStart(range, last);
  const firstOf = rows.map((m) => m.days[0].date);
  let latestFirst = 0;
  firstOf.forEach((d, i) => {
    if (d > firstOf[latestFirst]) latestFirst = i;
  });
  if (firstOf[latestFirst] > start) {
    start = firstOf[latestFirst];
    notes.push(`${rows[latestFirst].symbol} 的價格資料從 ${start} 開始，指數從那天起算`);
  }

  // trading calendar: every date any constituent traded, from the first date at/after start
  const dates = [...new Set(rows.flatMap((m) => m.days.map((d) => d.date)))].filter((d) => d >= start).sort();
  if (dates.length < 2) return { bars: [], start, end: last, notes: [...notes, '區間內的交易日不足'] };
  // per constituent: date -> bar, then carry the previous close over days it did not trade
  const at = rows.map((m) => {
    const byDate = new Map(m.days.map((d) => [d.date, d]));
    const out = new Map();
    let prev = null;
    for (const d of dates) {
      const b = byDate.get(d);
      if (b) prev = b;
      else if (prev) prev = { ...prev, open: prev.close, high: prev.close, low: prev.close, volume: 0 };
      if (prev) out.set(d, prev);
    }
    return out;
  });

  const bars = [];
  let units = w.map((wi, i) => (wi * base) / at[i].get(dates[0]).close);
  let prevClose = base;
  for (const d of dates) {
    if (rebalance === 'daily' && bars.length) units = w.map((wi, i) => (wi * prevClose) / at[i].get(bars.at(-1).time).close);
    const sum = (f) => units.reduce((s, u, i) => s + u * at[i].get(d)[f], 0);
    const bar = { time: d, open: sum('open'), high: sum('high'), low: sum('low'), close: sum('close') };
    // the first bar closes at the base by construction
    bar.high = Math.max(bar.high, bar.open, bar.close);
    bar.low = Math.min(bar.low, bar.open, bar.close);
    bars.push(bar);
    prevClose = bar.close;
  }

  const constituents = rows.map((m, i) => {
    const a = at[i].get(dates[0]).close;
    const b = at[i].get(dates.at(-1)).close;
    const ret = b / a - 1;
    // thinly traded names (a third of the last 60 sessions without a trade, or
    // under a dollar) print wild bars that swamp a basket - flag them
    const recent = m.days.slice(-60);
    const illiquid = b < 1 || recent.filter((d) => !d.volume).length > recent.length / 3;
    return { symbol: m.symbol, weight: w[i], source: m.source, first: m.days[0].date, last: m.days.at(-1).date, startClose: a, endClose: b, return: ret, contribution: rebalance === 'daily' ? null : w[i] * ret, illiquid };
  });
  return { bars, start: dates[0], end: dates.at(-1), notes, constituents, stats: stats(bars) };
}

// total return, CAGR, annualised volatility, max drawdown, best / worst day
export function stats(bars) {
  if (bars.length < 2) return null;
  const first = bars[0].close;
  const lastBar = bars.at(-1);
  const years = (new Date(lastBar.time) - new Date(bars[0].time)) / (365.25 * 86400000);
  const rets = [];
  let peak = first;
  let maxDd = 0;
  let ddFrom = bars[0].time;
  let ddTo = bars[0].time;
  let peakDate = bars[0].time;
  let best = null;
  let worst = null;
  for (let i = 1; i < bars.length; i++) {
    const r = bars[i].close / bars[i - 1].close - 1;
    rets.push(Math.log(1 + r));
    if (!best || r > best.r) best = { r, date: bars[i].time };
    if (!worst || r < worst.r) worst = { r, date: bars[i].time };
    if (bars[i].close > peak) {
      peak = bars[i].close;
      peakDate = bars[i].time;
    }
    const dd = bars[i].close / peak - 1;
    if (dd < maxDd) {
      maxDd = dd;
      ddFrom = peakDate;
      ddTo = bars[i].time;
    }
  }
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, rets.length - 1)) * Math.sqrt(252);
  const total = lastBar.close / first - 1;
  return { total, cagr: years > 0 ? (lastBar.close / first) ** (1 / years) - 1 : null, years, vol, maxDrawdown: maxDd, drawdownFrom: ddFrom, drawdownTo: ddTo, best, worst, days: bars.length };
}

// Rebase a symbol's closes to `base` on the basket's start date, for the overlay line.
export function rebased(hist, start, end, base = 100) {
  const days = hist.days.filter((d) => d.date >= start && d.date <= end);
  if (!days.length) return [];
  const k = base / days[0].close;
  return days.map((d) => ({ time: d.date, value: d.close * k }));
}
