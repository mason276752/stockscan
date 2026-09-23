// A rule ETF: the screener's conditions replayed through history.
//
// The custom ETF of basket.js is a list of stocks the user keeps by hand.
// This is the other kind: nobody picks the constituents - the filters do,
// every day, from the oldest filing on record to today. A company enters
// the index on the day a filing of its own makes it pass, and leaves on the
// day a filing makes it fail; whoever is in is held at equal weight. So the
// holdings, and every date they changed, are a function of the filters
// alone, which is why the page does not let them be edited.
//
// Two things make the replay cheap enough to run in a browser:
//
//   - a company's answer can only change on one of *its own* filing dates.
//     The filters read the filing that was current on the day (pickAsOf) and
//     the company data beside it (industry, filer status), and nothing else
//     moves in between - so the whole history costs one test per saved
//     filing (~30,000), not one per company per day (~10,000,000).
//   - what it tests is the same screenFilter the screener itself uses, over
//     the same as-of index (screen.js): the server reads it from the store,
//     the browser from the index/screen-asof-<year>.json files of the build.
//
// What it cannot do is the market-snapshot conditions (price, market cap,
// P/E …): that snapshot is today's, so replaying it would be looking into
// the future. Those conditions are dropped and listed in `skipped`. The
// other limit worth knowing is survivorship: the companies tested are the
// ones in the universe now, so a company that deregistered years ago is not
// among them and the index never held it.
//
// A filing counts from the day it reached EDGAR, and the index trades at
// the *next* session's open - EDGAR accepts filings until 22:00 ET, so
// buying at the close of the filing day would be reading tomorrow's paper.
//
// One thing the filters cannot express is whether a stock can be bought at
// all. A screen on the statements alone admits OTC shells quoted at
// $0.000001, where the smallest tick the market has is a 100% move: hold a
// few of those at equal weight and their quote noise is the whole index
// (one of them opening a tick up is +9,900% on that line). So a name is
// only bought while its price is at or above MIN_PRICE - the same dollar
// basket.js already calls illiquid - and the ones this kept out are named
// in the result. Set it to 0 to buy whatever the filters picked.

import { stats } from './basket.js';
import { pickAsOf, screenFilter, screenTable } from './screen.js';

export const RULE_MAX_MEMBERS = 900; // names ever held: beyond this the bars alone are a download of tens of MB
const GONE_DAYS = 14; // no bar for this long while the others trade: delisted, not merely behind
export const MIN_PRICE = 1; // a share under a dollar is not bought (quote noise swamps an equal-weight index)
const WILD = 4; // a one-day move of this many times, while held: a split nobody adjusted, or a quote nobody could trade on

const isAmend = (form) => /\/A$/i.test(form || '');
const daysBefore = (date, n) => new Date(Date.parse(date) - n * 86400000).toISOString().slice(0, 10);

// ---- 1. the membership timeline ----
// core: the company columns (index/screen.json, or the server's screener
// rows); index: screenAsOfIndex over every scored filing; q: the screener
// query as the URL carries it.
//   members [{ cik, ticker, name, sic, spans: [{ from, to }] }]  ever held
//   events  [{ date, add: [ticker], drop: [ticker], n }]          every change, in order
export function replaySchedule(core, index, q) {
  const t = screenTable(core);
  const { test, skipped } = screenFilter(q, { market: false });
  const { shards, byCik } = index;
  const field = (r, key) => (r ? (shards[r.s][key]?.[r.j] ?? null) : null);
  const value = (r, key) => (r ? (shards[r.s].values[key]?.[r.j] ?? null) : null);
  // one row of the table, with the company half fixed and the filing half
  // swapped for every date tested (a new object per test would be 30,000
  // allocations for nothing)
  const view = {
    length: 1,
    i: 0,
    cur: null,
    prev: null,
    yoy: null,
    cik: () => t.cik(view.i),
    ticker: () => t.ticker(view.i),
    tickers: () => t.tickers(view.i),
    name: () => t.name(view.i),
    sic: () => t.sic(view.i),
    afs: () => t.afs(view.i),
    float: () => t.float(view.i),
    market: (_i, key) => t.market(view.i, key),
    score: () => field(view.cur, 'score'),
    value: (_i, key) => value(view.cur, key),
    baseScore: (_i, mode) => field(mode === 'chg' ? view.prev : view.yoy, 'score'),
    baseValue: (_i, key, mode) => value(mode === 'chg' ? view.prev : view.yoy, key),
  };

  const members = [];
  const changes = []; // { date, ticker, add }
  let tested = 0;
  for (let i = 0; i < t.length; i++) {
    const list = byCik.get(t.cik(i));
    if (!list?.length) continue;
    const ticker = t.ticker(i);
    if (!ticker) continue; // nothing to hold
    // the days this company's answer could change: its own filing dates (a
    // filing with no date cannot start anything - it is counted as always
    // having been out, which is what pickAsOf does with it)
    const dates = [...new Set(list.filter((f) => f.filingDate && !isAmend(f.form)).map((f) => f.filingDate))].sort();
    if (!dates.length) continue;
    view.i = i;
    let held = false;
    const spans = [];
    for (const d of dates) {
      const p = pickAsOf(list, d);
      view.cur = p.cur;
      view.prev = p.prev;
      view.yoy = p.yoy;
      tested++;
      const ok = !!p.cur && test(view, 0);
      if (ok === held) continue;
      held = ok;
      if (ok) spans.push({ from: d, to: null });
      else spans[spans.length - 1].to = d;
      changes.push({ date: d, ticker, add: ok });
    }
    if (spans.length) members.push({ cik: t.cik(i), ticker, name: t.name(i), sic: t.sic(i), spans });
  }

  changes.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.add === b.add ? 0 : a.add ? 1 : -1)); // drops before adds on the same day
  const events = [];
  let n = 0;
  for (const c of changes) {
    const last = events.at(-1);
    const e = last?.date === c.date ? last : (events.push({ date: c.date, add: [], drop: [], n: 0 }), events.at(-1));
    (c.add ? e.add : e.drop).push(c.ticker);
    n += c.add ? 1 : -1;
    e.n = n;
  }
  return { members, events, skipped, tested, first: events[0]?.date || null, last: events.at(-1)?.date || null };
}

// ---- 2. the index ----
// members: [{ symbol, days }] (the bars fetched for the schedule's members);
// events: replaySchedule's, by ticker. Equal weight over whoever is held and
// has a price, restored at the open of the first session after every change.
//
// The bars are addressed by (member, day-of-the-calendar) through an
// Int32Array of indexes into each member's own days - a Map per member of
// 900 names over 1,800 sessions is 1.6 M entries and hundreds of MB, this
// is 6 MB. -1 = no price that day (not listed yet, or no longer).
export function ruleSeries(members, events, { base = 100, minPrice = MIN_PRICE } = {}) {
  const notes = [];
  const rows = members.filter((m) => m.days?.length);
  for (const m of members) if (!m.days?.length) notes.push({ code: 'ruleNoBars', symbol: m.symbol });
  if (!rows.length || !events.length) return { bars: [], start: null, end: null, notes: [...notes, { code: rows.length ? 'ruleNoEvents' : 'noPrices' }], constituents: [], counts: [], stats: null };

  // the trading calendar: every date any member traded after the first change
  const start = events[0].date;
  const dates = [...new Set(rows.flatMap((m) => m.days.map((d) => d.date)))].filter((d) => d > start).sort();
  if (dates.length < 2) return { bars: [], start, end: null, notes: [...notes, { code: 'tooFewDays' }], constituents: [], counts: [], stats: null };
  const n = dates.length;

  // per member: which of its bars stands for each session (the previous
  // close is carried over a day it did not trade). A name whose bars simply
  // stop - delisted, taken private, renamed - has no price after that and is
  // sold; one whose last bar is within GONE_DAYS of the end is only behind
  // (the last session is often one symbol's alone, the rest arriving later),
  // so its close is carried to the end rather than counting as a delisting.
  const lastSession = dates.at(-1);
  const gone = rows.map((m) => m.days.at(-1).date < daysBefore(lastSession, GONE_DAYS));
  const at = rows.map((m, i) => {
    const a = new Int32Array(n).fill(-1);
    const last = gone[i] ? m.days.at(-1).date : lastSession;
    let j = 0;
    let cur = -1;
    for (let k = 0; k < n; k++) {
      while (j < m.days.length && m.days[j].date <= dates[k]) cur = j++;
      if (cur >= 0 && dates[k] <= last) a[k] = cur;
    }
    return a;
  });
  // OHLC of member i on session k: its own bar, or its last close carried over
  const px = (i, k, f) => {
    const b = rows[i].days[at[i][k]];
    return b.date === dates[k] ? b[f] : b.close;
  };

  const idxOf = new Map(rows.map((m, i) => [m.symbol, i]));
  const held = new Uint8Array(rows.length); // by the filters
  let units = new Float64Array(rows.length);
  let value = base; // what the index is worth on a day it can hold nothing
  let active = [];
  let cash = 0;
  let ptr = 0;
  const bars = [];
  const counts = []; // { date, n } whenever the number of holdings changes
  const per = rows.map(() => ({ days: 0, ret: 1, spells: 0, first: null, last: null, prevClose: 0, in: false, cheap: 0, wild: null }));

  for (let k = 0; k < n; k++) {
    const d = dates[k];
    // every change known before this session opens: a filing reaches EDGAR
    // as late as 22:00 ET, so the day it lands cannot be traded on
    while (ptr < events.length && events[ptr].date < d) {
      for (const x of events[ptr].drop) {
        const i = idxOf.get(x);
        if (i != null) held[i] = 0;
      }
      for (const x of events[ptr].add) {
        const i = idxOf.get(x);
        if (i != null) held[i] = 1;
      }
      ptr++;
    }
    const now = [];
    for (let i = 0; i < rows.length; i++) {
      if (!held[i] || at[i][k] < 0) continue;
      // priced too low to be worth a trade: held by the rules, not bought
      if (minPrice && px(i, k, 'open') < minPrice) {
        per[i].cheap++;
        continue;
      }
      now.push(i);
    }
    const changed = now.length !== active.length || now.some((x, j) => x !== active[j]);
    if (changed) {
      // sell everything at this open (a name with no price left goes at its
      // last close), then buy the new list in equal parts
      let owned = false;
      let V = 0;
      for (let i = 0; i < rows.length; i++) {
        if (!units[i]) continue;
        owned = true;
        const price = at[i][k] >= 0 ? px(i, k, 'open') : rows[i].days.at(-1).close;
        V += units[i] * price;
        if (per[i].in && !now.includes(i)) {
          per[i].ret *= price / per[i].prevClose; // the sale closes its stretch
          per[i].in = false;
        }
      }
      if (!owned) V = value;
      units = new Float64Array(rows.length);
      if (now.length) for (const i of now) units[i] = V / now.length / px(i, k, 'open');
      else value = V;
      active = now;
      counts.push({ date: d, n: now.length });
    }
    let bar;
    if (active.length) {
      const sum = (f) => {
        let s = 0;
        for (const i of active) s += units[i] * px(i, k, f);
        return s;
      };
      bar = { time: d, open: sum('open'), high: sum('high'), low: sum('low'), close: sum('close') };
      bar.high = Math.max(bar.high, bar.open, bar.close);
      bar.low = Math.min(bar.low, bar.open, bar.close);
      value = bar.close;
    } else {
      cash++;
      bar = { time: d, open: value, high: value, low: value, close: value };
    }
    // the index starts the day it first holds something, not the day the
    // first filing qualified (that name may not have been trading yet)
    if (bars.length || active.length) bars.push(bar);
    for (const i of active) {
      const p = per[i];
      const close = px(i, k, 'close');
      const from = p.in ? p.prevClose : px(i, k, 'open'); // bought at the open of the day it joined
      p.ret *= close / from;
      // a step this big is almost always a split the source never adjusted
      // for: one line of an equal-weight index cannot really do this, and if
      // it is in the data the chart is that artefact, so say which name
      if (from > 0 && (close / from > WILD || close / from < 1 / WILD)) p.wild = { date: d, factor: close / from };
      p.prevClose = close;
      if (!p.in) {
        p.spells++;
        p.in = true;
        p.first ??= d;
      }
      p.days++;
      p.last = d;
    }
  }
  if (!bars.length) return { bars: [], start, end: null, notes: [...notes, { code: 'ruleNoPrices' }], constituents: [], counts: [], stats: null };
  if (cash) notes.push({ code: 'ruleCash', days: cash });
  const wild = rows.map((m, i) => (per[i].wild ? { symbol: m.symbol, ...per[i].wild } : null)).filter(Boolean);
  if (wild.length) notes.push({ code: 'ruleWild', n: wild.length, list: wild.slice(0, 6).map((w) => `${w.symbol} ${w.date} ×${w.factor.toFixed(1)}`).join(', ') + (wild.length > 6 ? ' …' : '') });
  const cheap = rows.filter((_m, i) => per[i].cheap);
  if (cheap.length) notes.push({ code: 'ruleCheap', n: cheap.length, price: minPrice, list: cheap.slice(0, 12).map((m) => m.symbol).join(', ') + (cheap.length > 12 ? ' …' : '') });

  const end = bars.at(-1).time;
  const constituents = rows.map((m, i) => ({
    symbol: m.symbol,
    source: m.source,
    days: per[i].days,
    spells: per[i].spells,
    first: per[i].first,
    last: per[i].last,
    return: per[i].days ? per[i].ret - 1 : null,
    in: !!held[i],
    cheap: per[i].cheap, // sessions the rules held it but its price was under the floor
    wild: per[i].wild, // an implausible one-day step while held (an unadjusted split?)
    delisted: gone[i],
  }));
  for (const c of constituents) if (!c.days && !c.cheap) notes.push({ code: 'ruleNeverTraded', symbol: c.symbol });
  return { bars, start: bars[0].time, end, notes, constituents, counts, holding: counts.at(-1)?.n ?? 0, minPrice, stats: stats(bars) };
}

// POST /api/basket/rule's body -> the query to replay
export function ruleRequest(body) {
  const params = body?.params && typeof body.params === 'object' ? body.params : null;
  if (!params) throw Object.assign(new Error('params (the screener query) is required'), { status: 400 });
  const minPrice = body.minPrice === undefined || body.minPrice === null || body.minPrice === '' ? MIN_PRICE : Number(body.minPrice);
  return { params, benchmark: body.benchmark ? String(body.benchmark).trim().toUpperCase() : null, minPrice: Number.isFinite(minPrice) && minPrice >= 0 ? minPrice : MIN_PRICE };
}

// Fetch the bars of every name the schedule ever holds (a few at a time) and
// build the index. `emit` reports progress the way runBasket does, so the
// page can show the same bar.
export async function runRuleEtf(schedule, req, fetchBars, { emit = null, signal = null, extra = {} } = {}) {
  // one fetch per symbol: two companies can file under the same ticker (a
  // CIK that was reassigned), and they share the one price series
  const wanted = new Set(schedule.members.map((m) => m.ticker));
  const jobs = [...wanted, ...(req.benchmark && !wanted.has(req.benchmark) ? [req.benchmark] : [])];
  const out = new Array(jobs.length);
  let next = 0;
  let done = 0;
  emit?.({ type: 'start', total: jobs.length, rule: true, members: schedule.members.length, events: schedule.events.length });
  const worker = async () => {
    while (next < jobs.length && !signal?.aborted) {
      const i = next++;
      const symbol = jobs[i];
      try {
        const h = await fetchBars(symbol);
        out[i] = { symbol, source: h.source, currency: h.currency, days: h.days };
      } catch (err) {
        out[i] = { symbol, error: err.message, days: [] };
      }
      done++;
      const m = out[i];
      emit?.({ type: 'member', symbol, bench: symbol === req.benchmark, source: m.source || null, first: m.days[0]?.date || null, last: m.days.at(-1)?.date || null, days: m.days.length, error: m.error || null, done, total: jobs.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, jobs.length) }, worker));
  if (signal?.aborted) return null;
  const bench = req.benchmark ? out.find((m) => m?.symbol === req.benchmark) : null;
  const series = ruleSeries(
    out.filter((m) => m && wanted.has(m.symbol)),
    schedule.events,
    { minPrice: req.minPrice },
  );
  const failed = out.filter((m) => m?.error && wanted.has(m.symbol)).map((m) => ({ ticker: m.symbol, error: m.error }));
  return {
    rule: true,
    ...extra,
    ...series,
    members: schedule.members,
    events: schedule.events,
    skipped: schedule.skipped,
    tested: schedule.tested,
    failed,
    source: [...new Set(out.filter((m) => m && !m.error).map((m) => m.source))].join(' + ') || null,
    benchmark: bench && !bench.error && series.start ? { symbol: bench.symbol, source: bench.source, startClose: bench.days.find((d) => d.date >= series.start)?.close ?? null, points: rebasedTo(bench, series.start, series.end, series.bars[0]?.close ?? 100) } : null,
  };
}

// the benchmark rebased to the index's own starting level
function rebasedTo(hist, start, end, base) {
  const days = hist.days.filter((d) => d.date >= start && d.date <= end);
  if (!days.length) return [];
  const k = base / days[0].close;
  return days.map((d) => ({ time: d.date, value: d.close * k }));
}
