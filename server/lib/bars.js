// Daily OHLC bars and the custom-ETF ("basket") index built from them.
//
// Bars come from TradingView's chart websocket first, then the IBKR TWS API
// when TWS / IB Gateway is running, then Yahoo Finance's chart endpoint; all
// three are split-adjusted so a basket's history is continuous. (The
// valuation page keeps its own Yahoo price history in prices.js - it needs
// the unadjusted quotes of the day.)

import { store } from './store.js';
import { ibConnect, ibConnected, ibDailyBars, ibStatus } from './ib.js';
import { tvDailyBars, tvStatus } from './tvws.js';
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

// Which sources to try, in order, right now. Probing an absent TWS costs a
// 1.5 s wait, so the answer is kept for a minute - not once per symbol.
let ibProbe = { at: 0, ok: false };
async function sources() {
  const out = [];
  if (tvStatus().enabled) out.push('tv');
  if (ibStatus().enabled) {
    if (!ibConnected() && Date.now() - ibProbe.at > 60_000) ibProbe = { at: Date.now(), ok: await ibConnect(1500) };
    if (ibConnected() || ibProbe.ok) out.push('ib');
  }
  out.push('yahoo');
  return out;
}
const enabledSources = () => [...(tvStatus().enabled ? ['tv'] : []), ...(ibStatus().enabled ? ['ib'] : []), 'yahoo'];

// Daily bars only change while the US session runs (today's bar is forming);
// after the close nothing moves until the next open. A saved series is fresh
// for BARS_TTL, or - when it was fetched after the last close - until the
// next session opens. (Weekends handled; holidays just refetch once.)
function barsFresh(saved) {
  if (saved.ageMs < BARS_TTL) return true;
  const fetchedAt = Date.parse(saved.value?.fetchedAt || 0);
  if (!fetchedAt) return false;
  const now = Date.now();
  // fetched after the last settled close, and no session has opened since then
  return fetchedAt >= lastClose(now) + 15 * 60_000 && now < nextOpen(fetchedAt);
}
// US session bounds in UTC: 9:30-16:00 New York (offset from the zone name so DST is right)
const NY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
function nyParts(t) {
  const p = Object.fromEntries(NY.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute));
  return { offset: local - Math.floor(t / 60_000) * 60_000, weekday: p.weekday, dayStart: local - (local % 86_400_000) };
}
// the most recent 16:00 New York on a weekday at or before t (as a UTC timestamp)
export function lastClose(t) {
  for (let back = 0; back < 7; back++) {
    const { offset, weekday, dayStart } = nyParts(t - back * 86_400_000);
    if (weekday === 'Sat' || weekday === 'Sun') continue;
    const close = dayStart + 16 * 3_600_000 - offset;
    if (close <= t) return close;
  }
  return t;
}
// the next 9:30 New York on a weekday after t
export function nextOpen(t) {
  for (let ahead = 0; ahead < 7; ahead++) {
    const { offset, weekday, dayStart } = nyParts(t + ahead * 86_400_000);
    if (weekday === 'Sat' || weekday === 'Sun') continue;
    const open = dayStart + 9.5 * 3_600_000 - offset;
    if (open > t) return open;
  }
  return t;
}
const SOURCE_NAME = { tv: 'TradingView', ib: 'IBKR', yahoo: 'Yahoo Finance' };
const CACHE_KEY = { tv: 'bars:tv2', ib: 'bars:ib', yahoo: 'bars:yahoo' }; // tv2: entries before the US-listing check are stale

async function fetchFrom(source, symbol) {
  if (source === 'tv') {
    const r = await tvDailyBars(symbol);
    return { symbol, source: 'TradingView', currency: r.currency || 'USD', resolved: r.resolved, days: r.days };
  }
  if (source === 'ib') return { symbol, source: 'IBKR', currency: 'USD', days: await ibDailyBars(symbol, { years: YEARS }) };
  const { days, currency } = await yahooDailyBars(symbol);
  return { symbol, source: 'Yahoo Finance', currency, days };
}

// { symbol, source: 'TradingView' | 'IBKR' | 'Yahoo Finance', currency, days: [{ date, open, high, low, close, volume }], fetchedAt }
// A symbol unknown to one source (404) is tried on the next as well: tickers
// differ a little between them.
export async function dailyBars(ticker) {
  const symbol = String(ticker).toUpperCase();
  // a fresh copy from any enabled source answers without touching the network (or TWS)
  for (const src of enabledSources()) {
    const saved = store.getKV(`${CACHE_KEY[src]}:${symbol}`);
    if (saved && barsFresh(saved)) return saved.value;
  }
  const order = await sources();
  let lastErr = null;
  for (const src of order) {
    try {
      const value = await fetchFrom(src, symbol);
      if (!value.days.length) throw Object.assign(new Error(`${SOURCE_NAME[src]}: no daily bars for ${symbol}`), { status: 404 });
      value.fetchedAt = new Date().toISOString();
      store.putKV(`${CACHE_KEY[src]}:${symbol}`, value);
      return value;
    } catch (err) {
      lastErr = err;
      const next = order[order.indexOf(src) + 1];
      if (next) console.warn(`bars ${symbol}: ${err.message} - trying ${SOURCE_NAME[next]}`);
    }
  }
  // every source failed: a stale copy beats nothing
  for (const src of order) {
    const saved = store.getKV(`${CACHE_KEY[src]}:${symbol}`);
    if (saved) return saved.value;
  }
  throw lastErr;
}

export const RANGES = { '1y': 1, '3y': 3, '5y': 5, '10y': 10, max: 10 };

function daysBefore(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function rangeStart(range, end) {
  const years = RANGES[range] || 5;
  const d = new Date(`${end}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

// Basket index, base 100 on the start date, from the constituents' bars.
//   rebalance 'none'  : buy and hold - weights are the allocation on the start date
//   rebalance 'daily' : weights are restored at every close
// A name whose data starts later (an IPO) joins the index on its first day,
// funded by trimming every position by the newcomer's target share; one whose
// data ends earlier (delisted, taken private) leaves after its last day and
// its proceeds go to the others pro rata. The rest of a buy-and-hold basket
// is never rebalanced, and one newcomer or leaver never shortens the chart. The high / low of a day are the
// weighted highs / lows of the constituents, which slightly overstates the
// basket's true intraday range.
export function basketSeries(members, { range = '5y', rebalance = 'none', base = 100 } = {}) {
  const notes = [];
  const rows = members.filter((m) => m.days?.length);
  if (!rows.length) return { bars: [], start: null, end: null, notes: ['沒有任何成分股的價格資料'] };
  const wsum = rows.reduce((s, m) => s + (m.weight > 0 ? m.weight : 0), 0) || rows.length;
  const w = rows.map((m) => (m.weight > 0 ? m.weight : wsum / rows.length) / wsum);
  const first = rows.map((m) => m.days[0].date);
  const lastOf = rows.map((m) => m.days.at(-1).date);

  const last = lastOf.reduce((d, x) => (x > d ? x : d), '');
  let start = rangeStart(range, last);
  const earliest = first.reduce((d, x) => (x < d ? x : d), first[0]);
  if (earliest > start) {
    start = earliest;
    notes.push(`成分股的價格資料最早從 ${start} 開始，指數從那天起算`);
  }

  // trading calendar: every date any constituent traded, from the first date at/after start
  const dates = [...new Set(rows.flatMap((m) => m.days.map((d) => d.date)))].filter((d) => d >= start).sort();
  if (dates.length < 2) return { bars: [], start, end: last, notes: [...notes, '區間內的交易日不足'] };
  // per constituent: date -> bar between its first and last day, carrying the
  // previous close over days it did not trade
  const at = rows.map((m) => {
    const byDate = new Map(m.days.map((d) => [d.date, d]));
    const out = new Map();
    let prev = m.days.filter((d) => d.date < dates[0]).at(-1) || null;
    if (prev) prev = { ...prev, open: prev.close, high: prev.close, low: prev.close, volume: 0 };
    for (const d of dates) {
      const b = byDate.get(d);
      if (b) prev = b;
      else if (prev) prev = { ...prev, open: prev.close, high: prev.close, low: prev.close, volume: 0 };
      if (prev && d <= m.days.at(-1).date) out.set(d, prev);
    }
    // a name with only a few days in the range (a stock delisted just after
    // the start, Yahoo's single last bar of a taken-private company) would
    // join and leave within days: leave it out instead
    if (out.size < 5) {
      notes.push(`${m.symbol} 在區間內只有 ${out.size} 天價格資料（${m.days[0].date} ～ ${m.days.at(-1).date}），未納入`);
      out.clear();
    }
    return out;
  });
  const activeOn = (d) => rows.map((_, i) => at[i].has(d));
  const joined = rows.map(() => null); // date each name entered the index
  const left = rows.map(() => null); // date each name left

  // target allocation of value V over the active names, priced at `price(i)`
  const allocate = (active, V, price) => {
    const tot = active.reduce((s, a, i) => s + (a ? w[i] : 0), 0);
    return rows.map((_, i) => (active[i] && tot ? (w[i] / tot) * V / price(i) : 0));
  };

  const bars = [];
  let active = activeOn(dates[0]);
  let units = allocate(active, base, (i) => at[i].get(dates[0]).close);
  active.forEach((a, i) => a && (joined[i] = dates[0]));
  for (let k = 0; k < dates.length; k++) {
    const d = dates[k];
    const sum = (f) => units.reduce((s, u, i) => s + (u ? u * at[i].get(d)[f] : 0), 0);
    const bar = { time: d, open: sum('open'), high: sum('high'), low: sum('low'), close: sum('close') };
    bar.high = Math.max(bar.high, bar.open, bar.close);
    bar.low = Math.min(bar.low, bar.open, bar.close);
    bars.push(bar);
    const next = dates[k + 1];
    if (!next) break;
    const nextActive = activeOn(next);
    const changed = nextActive.some((a, i) => a !== active[i]);
    if (changed) {
      nextActive.forEach((a, i) => {
        if (a && !active[i]) joined[i] = next;
        if (!a && active[i]) left[i] = d;
      });
    }
    if (rebalance === 'daily') {
      // a newcomer has no close today: it is bought at its opening price tomorrow
      units = allocate(nextActive, bar.close, (i) => at[i].get(d)?.close ?? at[i].get(next).open);
    } else if (changed) {
      // buy and hold: the rest of the basket is not rebalanced - a leaver's
      // proceeds are spread over the others in proportion to what they are
      // worth, and a newcomer is funded by trimming every position by its
      // target share
      const leavers = rows.map((_, i) => active[i] && !nextActive[i]);
      const proceeds = units.reduce((s, u, i) => s + (leavers[i] ? u * at[i].get(d).close : 0), 0);
      const staying = units.reduce((s, u, i) => s + (active[i] && nextActive[i] ? u * at[i].get(d).close : 0), 0);
      if (proceeds && staying) units = units.map((u, i) => (active[i] && nextActive[i] ? u * (1 + proceeds / staying) : u));
      units = units.map((u, i) => (leavers[i] ? 0 : u));
      const tot = nextActive.reduce((s, a, i) => s + (a ? w[i] : 0), 0);
      const share = rows.reduce((s, _, i) => s + (nextActive[i] && !active[i] ? w[i] / tot : 0), 0);
      if (share) {
        const V = units.reduce((s, u, i) => s + (u ? u * at[i].get(d).close : 0), 0);
        units = units.map((u, i) => (nextActive[i] && !active[i] ? ((w[i] / tot) * V) / at[i].get(next).open : u * (1 - share)));
      }
    }
    active = nextActive;
  }

  for (let i = 0; i < rows.length; i++) {
    if (joined[i] && joined[i] !== dates[0]) notes.push(`${rows[i].symbol} 的價格資料從 ${joined[i]} 開始，那天起納入指數`);
    if (left[i]) notes.push(`${rows[i].symbol} 的價格資料到 ${left[i]} 為止（下市或更名），之後從指數除名`);
    if (!joined[i] && at[i].size) notes.push(`${rows[i].symbol} 在區間內沒有價格資料，未納入`);
  }

  const constituents = rows.map((m, i) => {
    const from = joined[i];
    const to = left[i] || dates.at(-1);
    const a = from ? at[i].get(from)?.close ?? null : null;
    const b = from ? at[i].get(to)?.close ?? null : null;
    const ret = a && b ? b / a - 1 : null;
    const whole = from === dates[0] && !left[i];
    // thinly traded names (a third of the last 60 sessions without a trade, or
    // under a dollar) print wild bars that swamp a basket - flag them
    const recent = m.days.slice(-60);
    const illiquid = (b ?? m.days.at(-1).close) < 1 || recent.filter((d) => !d.volume).length > recent.length / 3;
    // no bar in the last two weeks while others have them: delisted, taken private, renamed
    const delisted = m.days.at(-1).date < daysBefore(last, 14);
    return { symbol: m.symbol, weight: w[i], source: m.source, first: m.days[0].date, last: m.days.at(-1).date, joined: from, left: left[i], delisted, startClose: a, endClose: b, return: ret, contribution: rebalance === 'daily' || !whole || ret == null ? null : w[i] * ret, illiquid };
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
