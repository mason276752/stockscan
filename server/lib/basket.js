// The custom-ETF ("basket") index and its statistics, from the constituents'
// daily bars - pure arithmetic, shared by the server (POST /api/basket) and
// the static site (which computes the same in the browser).

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

// POST /api/basket's body -> { wanted: [{ ticker, cik, weight }], range, rebalance, benchmark }
export function basketRequest(body) {
  const seen = new Set();
  const wanted = (Array.isArray(body.constituents) ? body.constituents : [])
    .map((c) => ({ ticker: String(c?.ticker || '').trim().toUpperCase(), cik: Number(c?.cik) || null, weight: Number(c?.weight) > 0 ? Number(c.weight) : 1 }))
    .filter((c) => c.ticker && !seen.has(c.ticker) && seen.add(c.ticker));
  if (!wanted.length) throw Object.assign(new Error('constituents is empty'), { status: 400 });
  return {
    wanted,
    range: RANGES[body.range] ? body.range : '5y',
    rebalance: body.rebalance === 'daily' ? 'daily' : 'none',
    benchmark: body.benchmark ? String(body.benchmark).trim().toUpperCase() : null,
  };
}

// The index of the members fetched so far. listingOf(ticker, cik) -> { listed,
// renamed } from the ticker table (null: unknown); `extra` is merged into the
// result (the server adds its data-source status).
function basketResult({ wanted, range, rebalance }, out, { partial = false, done = 0, total = 0 } = {}, { listingOf = () => null, extra = {} } = {}) {
  const members = out.filter((m) => m && !m.bench);
  const bench = out.find((m) => m && m.bench) || null;
  const series = basketSeries(members, { range, rebalance });
  // EDGAR's ticker table is the other delisting signal: a name whose prices
  // still come in but that left the table (taken private, deregistered,
  // renamed) is flagged too, with the new ticker when the company lives on
  for (const c of series.constituents) {
    const l = listingOf(c.symbol, wanted.find((w) => w.ticker === c.symbol)?.cik);
    if (!l) continue;
    c.listed = l.listed;
    if (l.renamed) c.renamed = l.renamed;
    if (!l.listed) c.delisted = true;
  }
  const failed = members.filter((m) => m.error).map((m) => ({ ticker: m.ticker, error: m.error, ...(listingOf(m.ticker, m.cik) || {}) }));
  for (const f of failed) series.notes.push(`${f.ticker} 沒有價格資料，已排除（${f.error}）`);
  const sources = [...new Set(members.filter((m) => !m.error).map((m) => m.source))];
  return {
    range,
    rebalance,
    partial,
    done,
    total,
    source: sources.join(' + ') || null,
    ...extra,
    ...series,
    failed,
    benchmark: bench && !bench.error && series.start ? { symbol: bench.symbol, source: bench.source, startClose: bench.days.find((d) => d.date >= series.start)?.close ?? null, points: rebased(bench, series.start, series.end) } : null,
  };
}

// Fetch every constituent's bars with fetchBars(ticker) (a few at a time:
// IB paces historical requests, Yahoo rate-limits) and build the index.
// `emit` sees each constituent as its bars land; interim: also an index of
// the members landed so far every `interim` ms (0 = off - the weights
// renormalise among whoever has arrived, so the interim chart jumps around;
// the page only asks for progress).
export async function runBasket(req, fetchBars, { emit = null, interim = 0, signal = null, listingOf, extra } = {}) {
  const env = { listingOf, extra };
  const { wanted, benchmark } = req;
  const jobs = [...wanted.map((c) => ({ ...c, bench: false })), ...(benchmark ? [{ ticker: benchmark, weight: 0, bench: true }] : [])];
  const out = new Array(jobs.length);
  const total = jobs.length;
  let next = 0;
  let done = 0;
  let lastInterim = Date.now();
  let dirty = false;
  emit?.({ type: 'start', total, range: req.range, rebalance: req.rebalance });
  const worker = async () => {
    while (next < jobs.length && !signal?.aborted) {
      const i = next++;
      const j = jobs[i];
      try {
        const h = await fetchBars(j.ticker);
        out[i] = { ...j, symbol: j.ticker, source: h.source, currency: h.currency, days: h.days };
      } catch (err) {
        out[i] = { ...j, symbol: j.ticker, error: err.message, days: [] };
      }
      done++;
      if (!emit) continue;
      const m = out[i];
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
