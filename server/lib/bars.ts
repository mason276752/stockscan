// Daily OHLC bars and the custom-ETF ("basket") index built from them.
//
// Bars come from TradingView's chart websocket first, then the IBKR TWS API
// when TWS / IB Gateway is running, then Yahoo Finance's chart endpoint; all
// three are split-adjusted so a basket's history is continuous. (The
// valuation page keeps its own Yahoo price history in prices.ts - it needs
// the unadjusted quotes of the day.)

import { barStore, mergeDays, settledAt } from './barStore.ts';
import { ibConnect, ibConnected, ibDailyBars, ibStatus } from './ib.ts';
import { tvDailyBars, tvStatus } from './tvws.ts';
import { yahooSymbol } from './prices.ts';
import type { Bar, BarSeries, IsoDate } from './types.ts';

/** Which price sources are tried, in order. */
type Source = 'tv' | 'ib' | 'yahoo';

const BARS_TTL = 30 * 60 * 1000; // a basket of 30 names is 30 TWS requests; IB allows 60 per 10 minutes
const YEARS = 10;
const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';

/** Yahoo's chart response, as far as this reads it. */
interface YahooBarsChart {
  meta?: { currency?: string };
  timestamp?: number[];
  indicators?: { quote?: { open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }[] };
}

async function yahooDailyBars(ticker: string, since: IsoDate | null = null): Promise<{ days: Bar[]; currency: string | null }> {
  const symbol = yahooSymbol(ticker);
  const span: Record<string, string> = since ? { period1: String(Math.floor(Date.parse(since) / 1000)), period2: String(Math.floor(Date.now() / 1000) + 86_400) } : { range: `${YEARS}y` };
  const url = `${YAHOO}${encodeURIComponent(symbol)}?${new URLSearchParams({ ...span, interval: '1d' })}`;
  let res!: Response;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (res.status !== 429 || attempt >= 2) break;
    await new Promise<void>((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  if (!res.ok) throw Object.assign(new Error(`Yahoo Finance returned ${res.status} for ${symbol}`), { status: res.status === 404 ? 404 : 502 });
  const body = (await res.json()) as { chart?: { result?: YahooBarsChart[]; error?: { description?: string } } };
  const r = body.chart?.result?.[0];
  if (!r) throw Object.assign(new Error(body.chart?.error?.description || `No price data for ${symbol}`), { status: 404 });
  const q = r.indicators?.quote?.[0] || {};
  const days: Bar[] = [];
  (r.timestamp || []).forEach((t, i) => {
    const c = q.close?.[i];
    if (typeof c !== 'number' || c <= 0) return;
    days.push({ date: new Date(t * 1000).toISOString().slice(0, 10), open: q.open?.[i] ?? c, high: q.high?.[i] ?? c, low: q.low?.[i] ?? c, close: c, volume: q.volume?.[i] ?? null });
  });
  return { days, currency: r.meta?.currency || null };
}

// Which sources to try, in order, right now. Probing an absent TWS costs a
// 1.5 s wait, so the answer is kept for a minute - not once per symbol.
let ibProbe: { at: number; ok: boolean } = { at: 0, ok: false };
async function sources(): Promise<Source[]> {
  const out: Source[] = [];
  if (tvStatus().enabled) out.push('tv');
  if (ibStatus().enabled) {
    if (!ibConnected() && Date.now() - ibProbe.at > 60_000) ibProbe = { at: Date.now(), ok: await ibConnect(1500) };
    if (ibConnected() || ibProbe.ok) out.push('ib');
  }
  out.push('yahoo');
  return out;
}
const enabledSources = (): Source[] => [...(tvStatus().enabled ? (['tv'] as const) : []), ...(ibStatus().enabled ? (['ib'] as const) : []), 'yahoo'];

// Daily bars only change while the US session runs (today's bar is forming);
// after the close nothing moves until the next open. A saved series is fresh
// for BARS_TTL, or - when it was fetched after the last close - until the
// next session opens. (Weekends handled; holidays just refetch once.)
function barsFresh(saved: { fetchedAt?: string | null } | null | undefined): boolean {
  const fetchedAt = Date.parse(saved?.fetchedAt || '');
  if (!fetchedAt) return false;
  const now = Date.now();
  if (now - fetchedAt < BARS_TTL) return true;
  // fetched after the last settled close, and no session has opened since then
  return fetchedAt >= lastClose(now) + 15 * 60_000 && now < nextOpen(fetchedAt);
}
// US session bounds in UTC: 9:30-16:00 New York (offset from the zone name so DST is right)
const NY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
function nyParts(t: number) {
  const p = Object.fromEntries(NY.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute));
  return { offset: local - Math.floor(t / 60_000) * 60_000, weekday: p.weekday!, dayStart: local - (local % 86_400_000) };
}
// the most recent 16:00 New York on a weekday at or before t (as a UTC timestamp)
export function lastClose(t: number): number {
  for (let back = 0; back < 7; back++) {
    const { offset, weekday, dayStart } = nyParts(t - back * 86_400_000);
    if (weekday === 'Sat' || weekday === 'Sun') continue;
    const close = dayStart + 16 * 3_600_000 - offset;
    if (close <= t) return close;
  }
  return t;
}
// the next 9:30 New York on a weekday after t
export function nextOpen(t: number): number {
  for (let ahead = 0; ahead < 7; ahead++) {
    const { offset, weekday, dayStart } = nyParts(t + ahead * 86_400_000);
    if (weekday === 'Sat' || weekday === 'Sun') continue;
    const open = dayStart + 9.5 * 3_600_000 - offset;
    if (open > t) return open;
  }
  return t;
}
const SOURCE_NAME: Record<Source, string> = { tv: 'TradingView', ib: 'IBKR', yahoo: 'Yahoo Finance' };
const CACHE_KEY: Record<Source, string> = { tv: 'tv2', ib: 'ib', yahoo: 'yahoo' }; // directory per source under data/bars (tv2: before the US-listing check the series could be another country's)
const OVERLAP = 7; // calendar days re-fetched behind the last saved bar, to check the history still lines up

// A bar is only usable when all four prices are real and above zero: a
// source that prints a halted day as 0, or an empty quote as null, would
// otherwise divide an index by it. Dropping the day leaves a hole the
// series carries the previous close over, which is what a halt is.
const usable = (b: Bar) => b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0 && Number.isFinite(b.open + b.high + b.low + b.close);

// the whole series, or (since = 'yyyy-mm-dd') only the bars from that day on
async function fetchFrom(source: Source, symbol: string, since: IsoDate | null = null): Promise<BarSeries> {
  const calendarDays = since ? Math.ceil((Date.now() - Date.parse(since)) / 86_400_000) + 2 : null;
  if (source === 'tv') {
    const r = await tvDailyBars(symbol, since ? { bars: calendarDays } : {});
    return { symbol, source: 'TradingView', currency: r.currency || 'USD', resolved: r.resolved, days: r.days.filter((d) => usable(d) && (!since || d.date >= since)) };
  }
  if (source === 'ib') return { symbol, source: 'IBKR', currency: 'USD', days: (await ibDailyBars(symbol, since ? { days: calendarDays } : { years: YEARS })).filter(usable) };
  const { days, currency } = await yahooDailyBars(symbol, since);
  return { symbol, source: 'Yahoo Finance', currency, days: days.filter(usable) };
}

// bring a saved series up to date: fetch the tail (with overlap) and splice
// it on; a history that no longer lines up (split since) is fetched whole -
// the store then keeps the old files and records the split (barStore.put)
async function refresh(src: Source, symbol: string, saved: BarSeries | null): Promise<BarSeries> {
  const last = saved?.days?.at(-1)?.date;
  if (last) {
    const since = new Date(Date.parse(last) - OVERLAP * 86_400_000).toISOString().slice(0, 10);
    const tail = await fetchFrom(src, symbol, since);
    // the last saved bar was still forming if it was fetched during its session (a stop mid-day)
    const unsettled = Date.parse(saved!.fetchedAt || '') < settledAt(last) ? last : null;
    const days = mergeDays(saved!.days, tail.days, unsettled);
    if (days) return { ...saved!, ...tail, days: days as Bar[], fetchedAt: new Date().toISOString(), incremental: tail.days.length };
  }
  const value = await fetchFrom(src, symbol);
  if (!value.days.length) throw Object.assign(new Error(`${SOURCE_NAME[src]}: no daily bars for ${symbol}`), { status: 404 });
  value.fetchedAt = new Date().toISOString();
  return value;
}

// { symbol, source: 'TradingView' | 'IBKR' | 'Yahoo Finance', currency, days: [{ date, open, high, low, close, volume }], fetchedAt }
// A symbol unknown to one source (404) is tried on the next as well: tickers
// differ a little between them.
export async function dailyBars(ticker: string): Promise<BarSeries> {
  const symbol = String(ticker).toUpperCase();
  // a fresh copy from any enabled source answers without touching the network (or TWS)
  for (const src of enabledSources()) {
    const saved = barStore.get(CACHE_KEY[src], symbol);
    if (saved && barsFresh(saved)) return saved;
  }
  const order = await sources();
  let lastErr: unknown = null;
  for (const src of order) {
    try {
      const value = await refresh(src, symbol, barStore.get(CACHE_KEY[src], symbol));
      return barStore.put(CACHE_KEY[src], symbol, value) as BarSeries;
    } catch (err) {
      lastErr = err;
      const next = order[order.indexOf(src) + 1];
      if (next) console.warn(`bars ${symbol}: ${(err as Error).message} - trying ${SOURCE_NAME[next]}`);
    }
  }
  // every source failed: a stale copy beats nothing
  for (const src of order) {
    const saved = barStore.get(CACHE_KEY[src], symbol);
    if (saved) return saved;
  }
  throw lastErr;
}

// For the background bar crawl: bring one symbol's TradingView series up to
// date (whole history the first time, the tail after that), no fallback to
// the other sources. Returns the number of bars fetched (0 = was fresh).
export async function syncTvBars(ticker: string): Promise<number> {
  const symbol = String(ticker).toUpperCase();
  if (barsFresh({ fetchedAt: barStore.fetchedAt('tv2', symbol) })) return 0;
  const value = await refresh('tv', symbol, barStore.get('tv2', symbol, { keep: false }));
  barStore.put('tv2', symbol, value, { keep: false });
  return value.incremental ?? value.days.length;
}

export { RANGES, basketSeries, stats, rebased } from './basket.ts';
