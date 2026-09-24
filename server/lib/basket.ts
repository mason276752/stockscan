// The custom-ETF ("basket") index and its statistics, from the constituents'
// daily bars - pure arithmetic, shared by the server (POST /api/basket) and
// the static site (which computes the same in the browser).

import type {
  Bar, BasketBar, BasketConstituent, BasketMember, BasketNote, BasketRequest, BasketSeries, BasketStats,
  EmitEvent, IsoDate, Listing,
} from './types.ts';

export const RANGES: Record<string, number> = { '1y': 1, '3y': 3, '5y': 5, '10y': 10, max: 10 };

// A window the user typed: 'YYYY-MM-DD' or nothing. Anything else is ignored
// rather than guessed at, and a window typed back to front is turned round.
export const isoDate = (v: unknown): IsoDate | null => {
  const d = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null;
  // the round trip rejects a day that does not exist (2020-02-30 would roll over to March)
  return d && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d ? d : null;
};
export function dateWindow(body: { from?: unknown; to?: unknown } | null | undefined): { from: IsoDate | null; to: IsoDate | null } {
  let from = isoDate(body?.from);
  let to = isoDate(body?.to);
  if (from && to && from > to) [from, to] = [to, from];
  return { from, to };
}

export function yearsBefore(date: IsoDate, years: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

function daysBefore(date: IsoDate, n: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

const rangeStart = (range: string, end: IsoDate) => yearsBefore(end, RANGES[range] || 5);

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
//
// `from` / `to` are the window asked for (either alone is enough): `from`
// replaces the start `range` would have picked, `to` ends the index there
// instead of at the last bar - so the index is base 100 on the first session
// of the window and everything after it (the statistics, each constituent's
// return, what counts as delisted) is measured inside it.
/** The window and rebalancing rule the index is built under. */
export interface BasketSeriesOptions {
  range?: string;
  from?: IsoDate | null;
  to?: IsoDate | null;
  rebalance?: 'none' | 'daily';
  base?: number;
}

export function basketSeries(members: readonly BasketMember[], { range = '5y', from = null, to = null, rebalance = 'none', base = 100 }: BasketSeriesOptions = {}): BasketSeries {
  const notes: BasketNote[] = []; // { code, ...params }: worded by the UI in its language
  const rows = members.filter((m) => m.days?.length);
  if (!rows.length) return { bars: [], start: null, end: null, notes: [{ code: 'noPrices' }] };
  const wsum = rows.reduce((s, m) => s + (m.weight > 0 ? m.weight : 0), 0) || rows.length;
  const w = rows.map((m) => (m.weight > 0 ? m.weight : wsum / rows.length) / wsum);
  const first = rows.map((m) => m.days[0]!.date);
  const lastOf = rows.map((m) => m.days.at(-1)!.date);

  const lastBar = lastOf.reduce((d, x) => (x > d ? x : d), '');
  const last = to && to < lastBar ? to : lastBar; // where the window ends: the day asked for, or the last bar there is
  let start = from || rangeStart(range, last);
  const earliest = first.reduce((d, x) => (x < d ? x : d), first[0]!);
  if (earliest > start) {
    start = earliest;
    notes.push({ code: 'startsLater', start });
  }

  // trading calendar: every date any constituent traded inside the window
  const dates = [...new Set(rows.flatMap((m) => m.days.map((d) => d.date)))].filter((d) => d >= start && d <= last).sort();
  if (dates.length < 2) return { bars: [], start, end: last, notes: [...notes, { code: 'tooFewDays' }] };
  // per constituent: date -> bar between its first and last day, carrying the
  // previous close over days it did not trade
  const at = rows.map((m) => {
    const byDate = new Map(m.days.map((d) => [d.date, d]));
    const out = new Map<IsoDate, Bar>();
    let prev: Bar | null = m.days.filter((d) => d.date < dates[0]!).at(-1) || null;
    if (prev) prev = { ...prev, open: prev.close, high: prev.close, low: prev.close, volume: 0 };
    for (const d of dates) {
      const b = byDate.get(d);
      if (b) prev = b;
      else if (prev) prev = { ...prev, open: prev.close, high: prev.close, low: prev.close, volume: 0 };
      if (prev && d <= m.days.at(-1)!.date) out.set(d, prev);
    }
    // a name with only a few days in the range (a stock delisted just after
    // the start, Yahoo's single last bar of a taken-private company) would
    // join and leave within days: leave it out instead. In a window shorter
    // than that, a name that traded every session of it is not "a few days".
    if (out.size < Math.min(5, dates.length)) {
      notes.push({ code: 'fewDays', symbol: m.symbol, n: out.size, first: m.days[0]!.date, last: m.days.at(-1)!.date });
      out.clear();
    }
    return out;
  });
  const activeOn = (d: IsoDate) => rows.map((_, i) => at[i]!.has(d));
  const joined: (IsoDate | null)[] = rows.map(() => null); // date each name entered the index
  const left: (IsoDate | null)[] = rows.map(() => null); // date each name left

  // target allocation of value V over the active names, priced at `price(i)`
  const allocate = (active: readonly boolean[], V: number, price: (i: number) => number) => {
    const tot = active.reduce((s, a, i) => s + (a ? w[i]! : 0), 0);
    return rows.map((_, i) => (active[i] && tot ? ((w[i]! / tot) * V) / price(i) : 0));
  };

  const bars: BasketBar[] = [];
  let active = activeOn(dates[0]!);
  let units = allocate(active, base, (i) => at[i]!.get(dates[0]!)!.close);
  active.forEach((a, i) => a && (joined[i] = dates[0]!));
  for (let k = 0; k < dates.length; k++) {
    const d = dates[k]!;
    const sum = (f: 'open' | 'high' | 'low' | 'close') => units.reduce((s, u, i) => s + (u ? u * at[i]!.get(d)![f] : 0), 0);
    const bar: BasketBar = { time: d, open: sum('open'), high: sum('high'), low: sum('low'), close: sum('close') };
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
      units = allocate(nextActive, bar.close, (i) => at[i]!.get(d)?.close ?? at[i]!.get(next)!.open);
    } else if (changed) {
      // buy and hold: the rest of the basket is not rebalanced - a leaver's
      // proceeds are spread over the others in proportion to what they are
      // worth, and a newcomer is funded by trimming every position by its
      // target share
      const leavers = rows.map((_, i) => active[i] && !nextActive[i]);
      const proceeds = units.reduce((s, u, i) => s + (leavers[i] ? u * at[i]!.get(d)!.close : 0), 0);
      const staying = units.reduce((s, u, i) => s + (active[i] && nextActive[i] ? u * at[i]!.get(d)!.close : 0), 0);
      if (proceeds && staying) units = units.map((u, i) => (active[i] && nextActive[i] ? u * (1 + proceeds / staying) : u));
      units = units.map((u, i) => (leavers[i] ? 0 : u));
      const tot = nextActive.reduce((s, a, i) => s + (a ? w[i]! : 0), 0);
      const share = rows.reduce((s, _, i) => s + (nextActive[i] && !active[i] ? w[i]! / tot : 0), 0);
      if (share) {
        const V = units.reduce((s, u, i) => s + (u ? u * at[i]!.get(d)!.close : 0), 0);
        units = units.map((u, i) => (nextActive[i] && !active[i] ? ((w[i]! / tot) * V) / at[i]!.get(next)!.open : u * (1 - share)));
      }
    }
    active = nextActive;
  }

  for (let i = 0; i < rows.length; i++) {
    if (joined[i] && joined[i] !== dates[0]) notes.push({ code: 'joined', symbol: rows[i]!.symbol, date: joined[i]! });
    if (left[i]) notes.push({ code: 'left', symbol: rows[i]!.symbol, date: left[i]! });
    if (!joined[i] && at[i]!.size) notes.push({ code: 'noData', symbol: rows[i]!.symbol });
  }

  const constituents: BasketConstituent[] = rows.map((m, i) => {
    const from = joined[i];
    const to = left[i] || dates.at(-1)!;
    const a = from ? (at[i]!.get(from)?.close ?? null) : null;
    const b = from ? (at[i]!.get(to)?.close ?? null) : null;
    const ret = a && b ? b / a - 1 : null;
    const whole = from === dates[0] && !left[i];
    // thinly traded names (a third of the last 60 sessions without a trade, or
    // under a dollar) print wild bars that swamp a basket - flag them
    const recent = m.days.slice(-60);
    const illiquid = (b ?? m.days.at(-1)!.close) < 1 || recent.filter((d) => !d.volume).length > recent.length / 3;
    // no bar in the last two weeks of the window while others have them:
    // delisted, taken private, renamed (a name still trading today is not
    // delisted just because the window ends in the past)
    const delisted = m.days.at(-1)!.date < daysBefore(last, 14);
    return { symbol: m.symbol, weight: w[i]!, source: m.source, first: m.days[0]!.date, last: m.days.at(-1)!.date, joined: from, left: left[i], delisted, startClose: a, endClose: b, return: ret, contribution: rebalance === 'daily' || !whole || ret == null ? null : w[i]! * ret, illiquid };
  });
  return { bars, start: dates[0]!, end: dates.at(-1)!, notes, constituents, stats: stats(bars) };
}

// total return, CAGR, annualised volatility, max drawdown, best / worst day
export function stats(bars: readonly BasketBar[]): BasketStats | null {
  if (bars.length < 2) return null;
  const first = bars[0]!.close;
  const lastBar = bars.at(-1)!;
  const years = (new Date(lastBar.time).getTime() - new Date(bars[0]!.time).getTime()) / (365.25 * 86400000);
  const rets: number[] = [];
  let peak = first;
  let maxDd = 0;
  let ddFrom = bars[0]!.time;
  let ddTo = bars[0]!.time;
  let peakDate = bars[0]!.time;
  let best: { r: number; date: IsoDate } | null = null;
  let worst: { r: number; date: IsoDate } | null = null;
  for (let i = 1; i < bars.length; i++) {
    const r = bars[i]!.close / bars[i - 1]!.close - 1;
    rets.push(Math.log(1 + r));
    if (!best || r > best.r) best = { r, date: bars[i]!.time };
    if (!worst || r < worst.r) worst = { r, date: bars[i]!.time };
    if (bars[i]!.close > peak) {
      peak = bars[i]!.close;
      peakDate = bars[i]!.time;
    }
    const dd = bars[i]!.close / peak - 1;
    if (dd < maxDd) {
      maxDd = dd;
      ddFrom = peakDate;
      ddTo = bars[i]!.time;
    }
  }
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, rets.length - 1)) * Math.sqrt(252);
  const total = lastBar.close / first - 1;
  return { total, cagr: years > 0 ? (lastBar.close / first) ** (1 / years) - 1 : null, years, vol, maxDrawdown: maxDd, drawdownFrom: ddFrom, drawdownTo: ddTo, best, worst, days: bars.length };
}

// Rebase a symbol's closes to `base` on the basket's start date, for the overlay line.
export function rebased(hist: { days: readonly Bar[] }, start: IsoDate, end: IsoDate, base = 100): { time: IsoDate; value: number }[] {
  const days = hist.days.filter((d) => d.date >= start && d.date <= end);
  if (!days.length) return [];
  const k = base / days[0]!.close;
  return days.map((d) => ({ time: d.date, value: d.close * k }));
}

// POST /api/basket's body -> { wanted: [{ ticker, cik, weight }], range, from, to, rebalance, benchmark }
// An explicit from / to wins over `range` - the preset is then just a label.
export function basketRequest(body: Record<string, unknown>): BasketRequest {
  const seen = new Set<string>();
  const wanted = ((Array.isArray(body.constituents) ? body.constituents : []) as { ticker?: unknown; cik?: unknown; weight?: unknown }[])
    .map((c) => ({ ticker: String(c?.ticker || '').trim().toUpperCase(), cik: Number(c?.cik) || null, weight: Number(c?.weight) > 0 ? Number(c.weight) : 1 }))
    .filter((c) => c.ticker && !seen.has(c.ticker) && seen.add(c.ticker));
  if (!wanted.length) throw Object.assign(new Error('constituents is empty'), { status: 400 });
  const { from, to } = dateWindow(body);
  // 'custom' with neither end typed in yet: everything the bars cover
  const preset = RANGES[String(body.range)] ? String(body.range) : body.range === 'custom' ? 'max' : '5y';
  return {
    wanted,
    range: from || to ? 'custom' : preset,
    from,
    to,
    rebalance: body.rebalance === 'daily' ? ('daily' as const) : ('none' as const),
    benchmark: body.benchmark ? String(body.benchmark).trim().toUpperCase() : null,
  };
}

// The index of the members fetched so far. listingOf(ticker, cik) -> { listed,
// renamed } from the ticker table (null: unknown); `extra` is merged into the
// result (the server adds its data-source status).
/** How the index is reported back while it is still being assembled. */
export interface BasketProgress {
  partial?: boolean;
  done?: number;
  total?: number;
}

/** What the caller contributes: the ticker table, and its own status fields. */
export interface BasketEnv {
  listingOf?: (ticker: string, cik?: number | null) => Listing | null;
  extra?: Record<string, unknown>;
}

function basketResult(
  { wanted, range, from, to, rebalance }: BasketRequest,
  out: readonly (BasketMember | undefined)[],
  { partial = false, done = 0, total = 0 }: BasketProgress = {},
  { listingOf = () => null, extra = {} }: BasketEnv = {},
) {
  const members = out.filter((m): m is BasketMember => !!m && !m.bench);
  const bench = out.find((m): m is BasketMember => !!m && !!m.bench) || null;
  const series = basketSeries(members, { range, from, to, rebalance });
  // EDGAR's ticker table is the other delisting signal: a name whose prices
  // still come in but that left the table (taken private, deregistered,
  // renamed) is flagged too, with the new ticker when the company lives on
  for (const c of series.constituents!) {
    const l = listingOf(c.symbol, wanted.find((w) => w.ticker === c.symbol)?.cik);
    if (!l) continue;
    c.listed = l.listed;
    if (l.renamed) c.renamed = l.renamed;
    if (!l.listed) c.delisted = true;
  }
  const failed = members.filter((m) => m.error).map((m) => ({ ticker: m.ticker!, error: m.error, ...(listingOf(m.ticker!, m.cik) || {}) }));
  for (const f of failed) series.notes.push({ code: 'failed', symbol: f.ticker, error: f.error });
  const sources = [...new Set(members.filter((m) => !m.error).map((m) => m.source))];
  return {
    range,
    window: { from: from || null, to: to || null },
    rebalance,
    partial,
    done,
    total,
    source: sources.join(' + ') || null,
    ...extra,
    ...series,
    failed,
    benchmark: bench && !bench.error && series.start ? { symbol: bench.symbol, source: bench.source, startClose: bench.days.find((d) => d.date >= series.start!)?.close ?? null, points: rebased(bench, series.start, series.end!) } : null,
  };
}

// Fetch every constituent's bars with fetchBars(ticker) (a few at a time:
// IB paces historical requests, Yahoo rate-limits) and build the index.
// `emit` sees each constituent as its bars land; interim: also an index of
// the members landed so far every `interim` ms (0 = off - the weights
// renormalise among whoever has arrived, so the interim chart jumps around;
// the page only asks for progress).
/** What a constituent's price source hands back. */
export interface FetchedBars {
  source?: string | null;
  currency?: string | null;
  days: Bar[];
}

export interface RunBasketOptions extends BasketEnv {
  emit?: ((e: EmitEvent) => void) | null;
  interim?: number;
  signal?: AbortSignal | null;
}

export async function runBasket(req: BasketRequest, fetchBars: (ticker: string) => Promise<FetchedBars>, { emit = null, interim = 0, signal = null, listingOf, extra }: RunBasketOptions = {}) {
  const env: BasketEnv = { listingOf, extra };
  const { wanted, benchmark } = req;
  const jobs = [...wanted.map((c) => ({ ...c, bench: false })), ...(benchmark ? [{ ticker: benchmark, cik: null, weight: 0, bench: true }] : [])];
  const out = new Array<BasketMember | undefined>(jobs.length);
  const total = jobs.length;
  let next = 0;
  let done = 0;
  let lastInterim = Date.now();
  let dirty = false;
  emit?.({ type: 'start', total, range: req.range, from: req.from, to: req.to, rebalance: req.rebalance });
  const worker = async () => {
    while (next < jobs.length && !signal?.aborted) {
      const i = next++;
      const j = jobs[i]!;
      try {
        const h = await fetchBars(j.ticker);
        out[i] = { ...j, symbol: j.ticker, source: h.source, currency: h.currency, days: h.days };
      } catch (err) {
        out[i] = { ...j, symbol: j.ticker, error: (err as Error).message, days: [] };
      }
      done++;
      if (!emit) continue;
      const m = out[i]!;
      emit({ type: 'member', symbol: m.symbol, bench: m.bench, source: m.source || null, first: m.days[0]?.date || null, last: m.days.at(-1)?.date || null, days: m.days.length, error: m.error || null, done, total });
      dirty = true;
      // an interim index of what has landed so far, at most every `interim` ms
      if (interim > 0 && done < total && Date.now() - lastInterim >= interim && out.some((x) => x && !x.bench && !x.error)) {
        lastInterim = Date.now();
        dirty = false;
        emit({ type: 'series', ...basketResult(req, out, { partial: true, done, total }, env) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, jobs.length) }, worker));
  if (signal?.aborted) return null;
  const result = basketResult(req, out, { partial: false, done, total }, env);
  emit?.({ type: 'series', ...result });
  return result;
}
