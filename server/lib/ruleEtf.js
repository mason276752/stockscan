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
// The filters decide who qualifies on any day, but the portfolio is only
// rebuilt on a fixed schedule - the first session of each month by default.
// Following every filing the day after it lands is not something anyone
// could trade: filings arrive all year, and a name drifting either side of
// the price floor would turn the whole book over daily. Between rebalances
// nothing is touched, with one exception: a holding whose prices stop
// (delisted, taken private, renamed) is sold at its last close and the
// proceeds spread over the rest in proportion to what they are worth, which
// is what the hand-picked basket does.
//
// Weighting is equal by default. The other is by market value on the
// rebalance day - the share count from the filing that was current then,
// times that day's price, so it is what was knowable on the day and not
// hindsight - with a ceiling on any one name (`maxWeight`), the excess
// spread over the rest until everyone is inside it. A ceiling of 1 is plain
// market-value weighting. A company whose filings never carry a diluted
// share count (about a fifth of them: banks, funds and trusts whose income
// statement does not tag one) is weighted as the median of the rest rather
// than dropped, and they are named in the result.
//
// One thing the filters cannot express is whether a stock can be bought at
// all. A screen on the statements alone admits OTC shells quoted at
// $0.000001, where the smallest tick the market has is a 100% move: hold a
// few of those at equal weight and their quote noise is the whole index
// (one of them opening a tick up is +9,900% on that line). So a name is
// only bought while its price is at or above MIN_PRICE - the same dollar
// basket.js already calls illiquid - and the ones this kept out are named
// in the result. Set it to 0 to buy whatever the filters picked.

import { RANGES, dateWindow, stats, yearsBefore } from './basket.js';
import { pickAsOf, screenFilter, screenTable } from './screen.js';

export const RULE_MAX_MEMBERS = 3000; // names ever held: beyond this the bars alone are a download of tens of MB
const GONE_DAYS = 14; // no bar for this long while the others trade: delisted, not merely behind
export const MIN_PRICE = 1; // a share under a dollar is not bought (quote noise swamps an equal-weight index)
const WILD = 4; // a one-day move of this many times, while held: a split nobody adjusted, or a quote nobody could trade on
// when the portfolio is rebuilt: the first session of each period ('filing'
// is the old behaviour - the day after every filing that changes the list)
export const REBALANCE = ['monthly', 'quarterly', 'yearly', 'filing'];
export const WEIGHTING = ['equal', 'cap', 'ndx'];
export const MAX_WEIGHT = 0.1; // no one name above a tenth of a market-value weighted index
const SHARE_KEY = 'sharesDiluted'; // the screener value the market value is built on (millions of shares)

const daysBefore = (date, n) => new Date(Date.parse(date) - n * 86400000).toISOString().slice(0, 10);

// ---- 1. the membership timeline ----
// core: the company columns (index/screen.json, or the server's screener
// rows); index: screenAsOfIndex over every scored filing; q: the screener
// query as the URL carries it.
//   members [{ cik, ticker, name, sic, spans: [{ from, to }], shares }]  ever held
//   events  [{ date, add: [ticker], drop: [ticker], n }]                every change, in order
// `shares` is [{ date, value }] whenever the diluted share count changed, for
// the market-value weighting - read off the same filings the filters test, so
// it costs nothing extra and knows only what was public on the day.
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
    // The days this company's answer could change: its own filing dates -
    // an amendment among them, because a restatement changes the numbers
    // the filters read (pickAsOf). A filing with no date cannot start
    // anything; it counts as always having been out, which is what pickAsOf
    // does with it.
    const dates = [...new Set(list.filter((f) => f.filingDate).map((f) => f.filingDate))].sort();
    if (!dates.length) continue;
    view.i = i;
    let held = false;
    const spans = [];
    const shares = [];
    for (const d of dates) {
      const p = pickAsOf(list, d);
      view.cur = p.cur;
      view.prev = p.prev;
      view.yoy = p.yoy;
      tested++;
      const sh = value(p.cur, SHARE_KEY);
      if (sh > 0 && shares.at(-1)?.value !== sh) shares.push({ date: d, value: sh });
      const ok = !!p.cur && test(view, 0);
      if (ok === held) continue;
      held = ok;
      if (ok) spans.push({ from: d, to: null });
      else spans[spans.length - 1].to = d;
      changes.push({ date: d, ticker, add: ok });
    }
    if (spans.length) members.push({ cik: t.cik(i), ticker, name: t.name(i), sic: t.sic(i), spans, shares });
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

// ---- 1b. the same schedule, seen through a window ----
// The filters decide the same things whatever window is looked at, so a
// window only changes what is *shown and bought*: everything decided on or
// before `from` becomes one opening position on that day, nothing after `to`
// has happened yet, and a company the window never holds stops being a
// member at all - which is what keeps its bars from being fetched and lets a
// screen too wide for RULE_MAX_MEMBERS over its whole history still fit
// inside a few years of it.
export function windowSchedule(schedule, { from = null, to = null } = {}) {
  if (!from && !to) return schedule;
  const open = new Set(); // held by the rules when the window opens
  const events = [];
  for (const e of schedule.events) {
    if (to && e.date > to) break;
    if (from && e.date <= from) {
      for (const x of e.drop) open.delete(x);
      for (const x of e.add) open.add(x);
      continue;
    }
    events.push(e);
  }
  // `n` is the running count of the whole replay, which is the same count
  // inside the window - the rules held what they held
  if (open.size) events.unshift({ date: from, add: [...open], drop: [], n: open.size, opening: true });
  const kept = new Set(events.flatMap((e) => e.add));
  const members = [];
  for (const m of schedule.members) {
    if (!kept.has(m.ticker)) continue;
    // the stretches it was held for, clipped to the window: a `to` of null
    // means it was still in when the window closed
    const spans = m.spans
      .filter((sp) => (!to || sp.from <= to) && (!sp.to || !from || sp.to > from))
      .map((sp) => ({ from: from && sp.from < from ? from : sp.from, to: sp.to && (!to || sp.to <= to) ? sp.to : null }));
    if (spans.length) members.push({ ...m, spans });
  }
  return { ...schedule, members, events, first: events[0]?.date || null, last: events.at(-1)?.date || null };
}

// ---- 1c. weights ----
// Nasdaq-100 states its "modified market capitalization" weighting as a set
// of constraints applied in stages and then repeated until they all hold
// (indexes.nasdaq.com/docs/Methodology_NDX.pdf). Each stage is a level that
// triggers it and a lower one the breach is brought down to; the gap between
// the two is what stops a special rebalance firing every other day:
//
//   single  no company above `over` (24%); if one is, nobody ends above `to` (20%)
//   cohort  the companies above `above` (4.5%) may not add to `over` (48%)
//           together; if they do, that group is brought down to `to` (40%)
//   top     the `n` (5) largest may not add to `over` (40%); if they do, they
//           are brought to `to` (38.5%) and everyone else capped at `cap` (4.4%)
//
// `watch` is what the special rebalance looks at between rebalances, when it
// is not the trigger itself (a plain ceiling has no gap of its own).
export const NDX_CONSTRAINTS = {
  single: { over: 0.24, to: 0.2 },
  cohort: { above: 0.045, over: 0.48, to: 0.4 },
  top: { n: 5, over: 0.4, to: 0.385, cap: 0.044 },
};
// a plain ceiling, watched a fifth above it - the same gap Nasdaq leaves
// between its 24% trigger and the 20% it resets to
export const singleCap = (maxWeight) => ({ single: { over: maxWeight, to: maxWeight, watch: Math.min(1, maxWeight * 1.2) } });

const total = (xs) => xs.reduce((a, b) => a + b, 0);
// `v` scaled to add up to `t`, with no entry above `ceiling`
function spread(v, t, ceiling) {
  const s = total(v);
  const base = s > 0 ? v.map((x) => x / s) : v.map(() => 1 / v.length);
  return capWeights(base, ceiling / t).map((x) => x * t);
}
// Bring the group marked in `inGroup` down to `t` of the index, the rest
// taking what is left - each of them capped so none ends above the smallest
// inside the group, which is what keeps the rank order.
//
// Nasdaq writes these numbers for a hundred names. Over fewer they can be
// arithmetically impossible: twelve names cannot all be under 4.5%, and a
// group of k out of n cannot hold less than k/n while nobody outside it may
// be bigger than the smallest inside. So the target is the lowest level the
// rest of the index can actually absorb, and the stage settles there.
function groupTo(w, inGroup, target, ceiling = Infinity) {
  const gi = [];
  const oi = [];
  w.forEach((_, i) => (inGroup[i] ? gi : oi).push(i));
  if (!gi.length || !oi.length) return w;
  const t = Math.max(target, gi.length / w.length, Number.isFinite(ceiling) ? 1 - oi.length * ceiling : 0);
  if (!(t < total(gi.map((i) => w[i])) - 1e-12)) return w;
  const out = [...w];
  const inside = spread(
    gi.map((i) => w[i]),
    t,
    Infinity,
  );
  gi.forEach((i, j) => (out[i] = inside[j]));
  const outside = spread(
    oi.map((i) => w[i]),
    1 - t,
    Math.min(ceiling, Math.min(...inside)),
  );
  oi.forEach((i, j) => (out[i] = outside[j]));
  return out;
}
const topIndexes = (w, n) =>
  w
    .map((x, i) => i)
    .sort((a, b) => w[b] - w[a])
    .slice(0, n);

// Which stages can be met at all. Nasdaq's numbers are written for a hundred
// names; over sixteen holdings everybody is above 4.5% and the five largest
// are half the index whatever anyone does. A line nothing can get under is
// not applied and not watched - watching it would rebuild the book daily.
export function liveStages(w, c) {
  const n = w.length;
  const k = c.cohort ? w.filter((x) => x > c.cohort.above + 1e-12).length : 0;
  return {
    single: !!c.single && c.single.to >= 1 / n - 1e-12,
    cohort: !!c.cohort && k > 0 && k / n < c.cohort.over,
    top: !!c.top && c.top.n < n && Math.max(c.top.n / n, 1 - (n - c.top.n) * c.top.cap) < c.top.over,
  };
}

// the weights every stage of `c` is happy with (nothing to satisfy: unchanged)
export function constrainWeights(w, c) {
  if (!c || !w.length) return w;
  let out = w;
  for (let pass = 0; pass < 12; pass++) {
    const before = out;
    const live = liveStages(out, c);
    // the single ceiling always applies - capWeights settles at equal weight
    // when the ceiling is below one; it is only the *watching* of it that a
    // ceiling nothing can get under has to be spared
    if (c.single && Math.max(...out) > c.single.over + 1e-12) out = capWeights(out, c.single.to);
    if (live.cohort) {
      const inGroup = out.map((x) => x > c.cohort.above + 1e-12);
      if (total(out.filter((_, i) => inGroup[i])) >= c.cohort.over - 1e-12) out = groupTo(out, inGroup, c.cohort.to);
    }
    if (live.top) {
      const top = topIndexes(out, c.top.n);
      if (total(top.map((i) => out[i])) >= c.top.over - 1e-12) {
        const inGroup = out.map(() => false);
        for (const i of top) inGroup[i] = true;
        out = groupTo(out, inGroup, c.top.to, c.top.cap);
      }
    }
    if (out.every((x, i) => Math.abs(x - before[i]) < 1e-12)) break;
  }
  return out;
}

// Is the index concentrated enough to rebuild before the next scheduled
// rebalance? Nasdaq calls this a Special Rebalance and reads it off the
// close, so the earliest it can be traded on is the next open.
export function breachesConstraints(w, c) {
  if (!c || w.length < 2) return false;
  const live = liveStages(w, c);
  const level = (x) => x.watch ?? x.over;
  if (live.single && Math.max(...w) > level(c.single) + 1e-12) return true;
  if (live.cohort && total(w.filter((x) => x > c.cohort.above + 1e-12)) >= level(c.cohort) - 1e-12) return true;
  if (live.top && total(topIndexes(w, c.top.n).map((i) => w[i])) >= level(c.top) - 1e-12) return true;
  return false;
}

// No name above `cap`: the excess is spread over the rest in proportion to
// what they already have, again until everyone is inside it. A cap below an
// equal weight cannot be met by anyone, so it is not asked for.
export function capWeights(w, cap) {
  const limit = Math.max(cap, 1 / w.length);
  if (!(limit < 1)) return w;
  const out = [...w];
  for (let pass = 0; pass < 24; pass++) {
    let excess = 0;
    let room = 0;
    for (let i = 0; i < out.length; i++) {
      if (out[i] > limit + 1e-12) excess += out[i] - limit;
      else room += out[i];
    }
    if (!(excess > 1e-12) || !(room > 0)) break;
    for (let i = 0; i < out.length; i++) out[i] = out[i] > limit + 1e-12 ? limit : out[i] * (1 + excess / room);
  }
  return out;
}

// Target weights for the names being bought, from their market values on the
// day put through `constraints`. A value of 0 is a company whose filings
// never carried a share count - it takes the median of the rest, so a fifth
// of the market (banks, funds) is neither dropped nor guessed at.
export function marketWeights(values, constraints) {
  const known = values.filter((x) => x > 0).sort((a, b) => a - b);
  if (!known.length) return values.map(() => 1 / values.length);
  const mid = known[Math.floor(known.length / 2)];
  const v = values.map((x) => (x > 0 ? x : mid));
  const t = total(v);
  return constrainWeights(
    v.map((x) => x / t),
    constraints,
  );
}

// The sessions the portfolio is rebuilt on: the first one, and the first of
// every month / quarter / year after it. null = 'filing', the old behaviour,
// where any change in what the filters hold is traded the next session.
export function rebalanceSessions(dates, every) {
  if (every === 'filing') return null;
  const bucket = (d) => (every === 'yearly' ? d.slice(0, 4) : every === 'quarterly' ? `${d.slice(0, 4)}Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3)}` : d.slice(0, 7));
  const on = new Uint8Array(dates.length);
  let prev = null;
  for (let k = 0; k < dates.length; k++) {
    const b = bucket(dates[k]);
    if (b !== prev) on[k] = 1;
    prev = b;
  }
  return on;
}

// ---- 2. the index ----
// members: [{ symbol, days, shares }] (the bars fetched for the schedule's
// members, and their share counts); events: replaySchedule's, by ticker.
// Whoever the filters hold and can be bought, bought at the open of each
// rebalance session at `weighting`'s target weights.
//
// The bars are addressed by (member, day-of-the-calendar) through an
// Int32Array of indexes into each member's own days - a Map per member of
// 900 names over 1,800 sessions is 1.6 M entries and hundreds of MB, this
// is 6 MB. -1 = no price that day (not listed yet, or no longer).
export function ruleSeries(members, events, { base = 100, minPrice = MIN_PRICE, from = null, to = null, rebalance = 'monthly', weighting = 'equal', maxWeight = MAX_WEIGHT, constraints = null, special = true } = {}) {
  const notes = [];
  const rows = members.filter((m) => m.days?.length);
  for (const m of members) if (!m.days?.length) notes.push({ code: 'ruleNoBars', symbol: m.symbol });
  if (!rows.length || !events.length) return { bars: [], start: null, end: null, notes: [...notes, { code: rows.length ? 'ruleNoEvents' : 'noPrices' }], constituents: [], counts: [], stats: null };

  // the trading calendar: every date any member traded after the first change
  // (inside the window, when one was asked for)
  const start = from && from > events[0].date ? from : events[0].date;
  const dates = [...new Set(rows.flatMap((m) => m.days.map((d) => d.date)))].filter((d) => d > start && (!to || d <= to)).sort();
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
  const on = rebalanceSessions(dates, rebalance);
  // what the weights must satisfy: nothing under equal weight, a plain
  // ceiling under 'cap', Nasdaq-100's three stages under 'ndx'
  const limits = weighting === 'equal' ? null : constraints || (weighting === 'ndx' ? NDX_CONSTRAINTS : singleCap(maxWeight));
  let forced = false; // a special rebalance, read off last night's close
  let specials = 0;
  // share count of member i as of session k, from the newest filing on or
  // before the day (0 = its filings never carried one). k only ever moves
  // forward, so each member keeps a pointer rather than a search.
  const sharePtr = new Int32Array(rows.length);
  const sharesAt = (i, k) => {
    const list = rows[i].shares || [];
    while (sharePtr[i] < list.length && list[sharePtr[i]].date <= dates[k]) sharePtr[i]++;
    return sharePtr[i] > 0 ? list[sharePtr[i] - 1].value : 0;
  };
  const noShares = new Set();
  const skipped = new Set(); // constraint stages this index is too small to meet
  // what the portfolio is worth at this session's open (a holding with no
  // price left is worth its last close)
  const valueAt = (k) => {
    let owned = false;
    let V = 0;
    for (let i = 0; i < rows.length; i++) {
      if (!units[i]) continue;
      owned = true;
      V += units[i] * (at[i][k] >= 0 ? px(i, k, 'open') : rows[i].days.at(-1).close);
    }
    return owned ? V : value;
  };
  const sell = (i, price) => {
    if (!per[i].in) return;
    per[i].ret *= price / per[i].prevClose; // the sale closes its stretch
    per[i].in = false;
  };

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
    // What the filters would hold, of what can actually be bought - worked
    // out only on a day the portfolio could be traded on. On a fixed
    // schedule that is once a month rather than once a session; 'filing'
    // has to look every day, because a difference is what it trades on.
    const trading = !on || !!on[k] || forced;
    let now = null;
    if (trading) {
      now = [];
      for (let i = 0; i < rows.length; i++) {
        if (!held[i] || at[i][k] < 0) continue;
        // priced too low to be worth a trade: held by the rules, not bought
        if (minPrice && px(i, k, 'open') < minPrice) {
          per[i].cheap++;
          continue;
        }
        now.push(i);
      }
    }
    // A holding whose prices have stopped goes whatever day of the month it
    // is - it cannot be held once nothing trades.
    const stopped = trading ? [] : active.filter((i) => at[i][k] < 0);
    const rebalancing = trading && (!!on || now.length !== active.length || now.some((x, j) => x !== active[j]));
    if (rebalancing) {
      // sell everything at this open, then buy the new list at its weights
      const V = valueAt(k);
      for (const i of active) if (!now.includes(i)) sell(i, at[i][k] >= 0 ? px(i, k, 'open') : rows[i].days.at(-1).close);
      units = new Float64Array(rows.length);
      if (now.length) {
        let w;
        if (limits) {
          const caps = now.map((i) => sharesAt(i, k) * px(i, k, 'open'));
          now.forEach((i, j) => caps[j] > 0 || noShares.add(rows[i].symbol));
          w = marketWeights(caps, limits);
          const live = liveStages(w, limits);
          for (const stage of ['cohort', 'top']) if (limits[stage] && !live[stage]) skipped.add(stage);
        } else w = now.map(() => 1 / now.length);
        now.forEach((i, j) => {
          units[i] = (V * w[j]) / px(i, k, 'open');
        });
      } else value = V;
      active = now;
      if (forced) specials++;
      forced = false;
      counts.push({ date: d, n: now.length, ...(on && !on[k] ? { special: true } : {}) });
    } else if (stopped.length) {
      // sold at the last close, the money spread over the rest in proportion
      // to what they are worth - it is not redeployed until the next rebalance
      const proceeds = stopped.reduce((sum, i) => sum + units[i] * rows[i].days.at(-1).close, 0);
      const staying = active.filter((i) => at[i][k] >= 0);
      const rest = staying.reduce((sum, i) => sum + units[i] * px(i, k, 'open'), 0);
      for (const i of stopped) {
        sell(i, rows[i].days.at(-1).close);
        units[i] = 0;
      }
      if (proceeds > 0 && rest > 0) for (const i of staying) units[i] *= 1 + proceeds / rest;
      if (!staying.length) value = proceeds || value;
      active = staying;
      counts.push({ date: d, n: staying.length });
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
    // Nasdaq reads its Special Rebalance off the close, so the earliest this
    // can be acted on is tomorrow's open - which is also the only price this
    // index is allowed to trade at.
    if (special && limits && on && active.length > 1 && bar.close > 0) {
      const held = active.map((i) => (units[i] * px(i, k, 'close')) / bar.close);
      if (breachesConstraints(held, limits)) forced = true;
    }
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
  if (noShares.size) notes.push({ code: 'ruleNoShares', n: noShares.size, list: [...noShares].slice(0, 12).join(', ') + (noShares.size > 12 ? ' …' : '') });

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
    cheap: per[i].cheap, // rebalances the rules held it at but its price was under the floor
    wild: per[i].wild, // an implausible one-day step while held (an unadjusted split?)
    delisted: gone[i],
  }));
  for (const c of constituents) if (!c.days && !c.cheap) notes.push({ code: 'ruleNeverTraded', symbol: c.symbol });
  if (specials) notes.push({ code: 'ruleSpecial', n: specials });
  if (skipped.size) notes.push({ code: 'ruleLimitsSkipped', n: skipped.size, list: [...skipped].join(', ') });
  return { bars, start: bars[0].time, end, notes, constituents, counts, holding: counts.at(-1)?.n ?? 0, minPrice, rebalance, weighting, maxWeight, special, specials, constraints: limits, rebalances: on ? counts.length : null, stats: stats(bars) };
}

// POST /api/basket/rule's body -> the query to replay, and the window to
// replay it into: from / to as typed, or a 1y / 3y / 5y / 10y preset counted
// back from the window's end (`range` unset or 'all' = the whole history,
// which is what a rule ETF does by default).
export function ruleRequest(body, today = new Date().toISOString().slice(0, 10)) {
  const params = body?.params && typeof body.params === 'object' ? body.params : null;
  if (!params) throw Object.assign(new Error('params (the screener query) is required'), { status: 400 });
  const minPrice = body.minPrice === undefined || body.minPrice === null || body.minPrice === '' ? MIN_PRICE : Number(body.minPrice);
  const maxWeight = Number(body.maxWeight);
  let { from, to } = dateWindow(body);
  if (!from && RANGES[body?.range]) from = yearsBefore(to || today, RANGES[body.range]);
  return {
    params,
    from,
    to,
    range: from || to ? body?.range || 'custom' : 'all',
    benchmark: body.benchmark ? String(body.benchmark).trim().toUpperCase() : null,
    minPrice: Number.isFinite(minPrice) && minPrice >= 0 ? minPrice : MIN_PRICE,
    rebalance: REBALANCE.includes(body?.rebalance) ? body.rebalance : 'monthly',
    weighting: WEIGHTING.includes(body?.weighting) ? body.weighting : 'equal',
    maxWeight: Number.isFinite(maxWeight) && maxWeight > 0 && maxWeight <= 1 ? maxWeight : MAX_WEIGHT,
    special: body?.special !== false,
  };
}

// Fetch the bars of every name the schedule ever holds (a few at a time) and
// build the index. `emit` reports progress the way runBasket does, so the
// page can show the same bar. The schedule is expected to have been put
// through windowSchedule already (the caller checks RULE_MAX_MEMBERS against
// the window's own member count), so only the series is windowed here.
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
  // the share counts belong to the company, the bars to the ticker: two
  // companies filing under one ticker share a series, so their counts merge
  const shares = new Map();
  for (const m of schedule.members) shares.set(m.ticker, [...(shares.get(m.ticker) || []), ...(m.shares || [])].sort((a, b) => (a.date < b.date ? -1 : 1)));
  const series = ruleSeries(
    out.filter((m) => m && wanted.has(m.symbol)).map((m) => ({ ...m, shares: shares.get(m.symbol) || [] })),
    schedule.events,
    { minPrice: req.minPrice, from: req.from, to: req.to, rebalance: req.rebalance, weighting: req.weighting, maxWeight: req.maxWeight, special: req.special },
  );
  const failed = out.filter((m) => m?.error && wanted.has(m.symbol)).map((m) => ({ ticker: m.symbol, error: m.error }));
  return {
    rule: true,
    ...extra,
    ...series,
    window: { from: req.from || null, to: req.to || null },
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
