import test from 'node:test';
import assert from 'node:assert/strict';
import { screenAsOfColumns, screenAsOfIndex } from '../server/lib/screen.ts';
import { NDX_CONSTRAINTS, breachesConstraints, capWeights, constrainWeights, marketWeights, rebalanceSessions, replaySchedule, ruleRequest, ruleSeries, singleCap, windowSchedule } from '../server/lib/ruleEtf.ts';

// --- the pieces a replay reads: the company half (index/screen.json) and
// every scored filing (index/screen-asof-<year>.json) ---
const company = (cik, ticker, name, sic = '7372') => ({
  cik,
  ticker,
  tickers: [ticker],
  name,
  sic,
  sicZh: null,
  afs: 'LAF',
  float: null,
  score: { score: null },
  values: {},
  prev: null,
  yoy: null,
  history: 0,
  market: { marketCap: 1000 },
});
const filing = (cik, filingDate, periodEnd, score, extra = {}) => ({
  cik,
  accession: `${cik}-${filingDate}`,
  form: extra.form || '10-Q',
  filingDate,
  periodEnd,
  fiscalYear: Number(periodEnd.slice(0, 4)),
  fiscalPeriod: extra.period || 'Q1',
  score,
  coverage: 1,
  categories: [],
  values: extra.values || {},
});
const indexOf = (filings) => screenAsOfIndex([screenAsOfColumns(filings)]);

test('a company joins the day a filing makes it pass and leaves the day one makes it fail', () => {
  const core = [company(1, 'AAA', 'Alpha'), company(2, 'BBB', 'Beta')];
  const index = indexOf([
    filing(1, '2020-02-01', '2019-12-31', 50),
    filing(1, '2020-05-01', '2020-03-31', 80),
    filing(1, '2020-08-01', '2020-06-30', 40),
    filing(2, '2020-03-01', '2019-12-31', 90),
  ]);
  const { members, events, tested } = replaySchedule(core, index, { score_min: 60 });
  assert.equal(tested, 4, 'one test per filing, not one per company per day');
  assert.deepEqual(
    events.map((e) => [e.date, e.add.join('+'), e.drop.join('+'), e.n]),
    [
      ['2020-03-01', 'BBB', '', 1],
      ['2020-05-01', 'AAA', '', 2],
      ['2020-08-01', '', 'AAA', 1],
    ],
  );
  const aaa = members.find((m) => m.ticker === 'AAA');
  assert.deepEqual(aaa.spans, [{ from: '2020-05-01', to: '2020-08-01' }]);
  assert.deepEqual(members.find((m) => m.ticker === 'BBB').spans, [{ from: '2020-03-01', to: null }]);
});

test('an amendment is not a filing date of its own, and a company that never passes is never a member', () => {
  const core = [company(1, 'AAA', 'Alpha'), company(2, 'BBB', 'Beta')];
  const index = indexOf([
    filing(1, '2020-05-01', '2020-03-31', 80),
    filing(1, '2020-06-01', '2020-03-31', 80, { form: '10-Q/A' }),
    filing(2, '2020-05-01', '2020-03-31', 10),
  ]);
  const { members, events } = replaySchedule(core, index, { score_min: 60 });
  assert.deepEqual(events.map((e) => e.date), ['2020-05-01']);
  assert.deepEqual(members.map((m) => m.ticker), ['AAA']);
});

test('the market-snapshot conditions are dropped, and said so', () => {
  const core = [company(1, 'AAA', 'Alpha')];
  const index = indexOf([filing(1, '2020-05-01', '2020-03-31', 80)]);
  const { events, skipped } = replaySchedule(core, index, { score_min: 60, marketCap_min: 1e12, pe_max: 5 });
  assert.deepEqual(skipped, ['marketCap', 'pe'], 'a past date cannot be screened on today\'s snapshot');
  assert.equal(events.length, 1, 'the filing conditions still decide');
});

test('the change filters read the filing that was current then, not the newest one', () => {
  const core = [company(1, 'AAA', 'Alpha')];
  // score 50 -> 60 (+20%) -> 30 (-50%): "score up at least 10% on the previous filing"
  const index = indexOf([
    filing(1, '2020-02-01', '2019-12-31', 50),
    filing(1, '2020-05-01', '2020-03-31', 60),
    filing(1, '2020-08-01', '2020-06-30', 30),
  ]);
  const { events } = replaySchedule(core, index, { score_chg_min: 10 });
  assert.deepEqual(
    events.map((e) => [e.date, e.add.join('+'), e.drop.join('+')]),
    [
      ['2020-05-01', 'AAA', ''],
      ['2020-08-01', '', 'AAA'],
    ],
  );
});

test('the year files are read as one: a filing in another shard is the same filing', () => {
  const core = [company(1, 'AAA', 'Alpha')];
  const all = [filing(1, '2019-05-01', '2019-03-31', 50), filing(1, '2020-05-01', '2020-03-31', 80), filing(1, '2021-05-01', '2021-03-31', 20)];
  // the static build ships one file per year of filing date; the server has
  // them all in one. Both must replay to the same thing.
  const sharded = screenAsOfIndex([2019, 2020, 2021].map((y) => screenAsOfColumns(all.filter((f) => f.filingDate.startsWith(String(y))))));
  const one = indexOf(all);
  const q = { score_min: 60 };
  assert.deepEqual(replaySchedule(core, sharded, q).events, replaySchedule(core, one, q).events);
  assert.deepEqual(replaySchedule(core, sharded, q).members, replaySchedule(core, one, q).members);
  assert.deepEqual(replaySchedule(core, sharded, q).events.map((e) => e.date), ['2020-05-01', '2021-05-01']);
});

// --- the index ---
const bars = (days) => days.map(([date, o, h, l, c]) => ({ date, open: o, high: h, low: l, close: c, volume: 100 }));
const A = { symbol: 'A', source: 'test', days: bars([['2020-01-02', 10, 11, 9, 10], ['2020-01-03', 10, 20, 10, 20], ['2020-01-06', 20, 20, 20, 20], ['2020-01-07', 20, 20, 20, 20]]) };
const B = { symbol: 'B', source: 'test', days: bars([['2020-01-02', 5, 5, 5, 5], ['2020-01-03', 5, 5, 5, 5], ['2020-01-06', 5, 10, 5, 10], ['2020-01-07', 10, 10, 10, 10]]) };
const ev = (date, add = [], drop = [], n = 0) => ({ date, add, drop, n });

test('equal weight is restored at the open of the session after every change', () => {
  // A from the start; B joins on the 3rd (so from the 6th); A leaves on the 6th (so from the 7th)
  const r = ruleSeries([A, B], [ev('2020-01-01', ['A']), ev('2020-01-03', ['B']), ev('2020-01-06', [], ['A'])], { rebalance: 'filing' });
  assert.deepEqual(
    r.bars.map((b) => [b.time, b.open, b.high, b.low, b.close]),
    [
      ['2020-01-02', 100, 110, 90, 100], // 10 units of A at 10
      ['2020-01-03', 100, 200, 100, 200], // A doubles
      ['2020-01-06', 200, 300, 200, 300], // rebalanced into A+B at the open: 200 -> 100 each; B doubles
      ['2020-01-07', 300, 300, 300, 300], // A sold at its open, all of it into B
    ],
  );
  assert.equal(r.start, '2020-01-02');
  assert.equal(r.end, '2020-01-07');
  assert.equal(Math.round(r.stats.total * 100), 200);
  assert.deepEqual(r.counts, [{ date: '2020-01-02', n: 1 }, { date: '2020-01-06', n: 2 }, { date: '2020-01-07', n: 1 }]);
  const a = r.constituents.find((c) => c.symbol === 'A');
  assert.equal(a.days, 3);
  assert.equal(a.return, 1, 'bought at 10 the day it joined, sold at 20 the day it left');
  assert.equal(a.in, false);
  const b = r.constituents.find((c) => c.symbol === 'B');
  assert.equal(b.return, 1, 'bought at 5 at the open of the day it joined, worth 10');
  assert.equal(b.in, true);
});

test('holding nothing is flat, not a hole', () => {
  const r = ruleSeries([A, B], [ev('2020-01-01', ['A']), ev('2020-01-02', [], ['A']), ev('2020-01-06', ['B'])], { rebalance: 'filing' });
  assert.deepEqual(
    r.bars.map((b) => [b.time, b.close]),
    [
      ['2020-01-02', 100], // A, the only holding
      ['2020-01-03', 100], // sold at A's open (10): flat
      ['2020-01-06', 100],
      ['2020-01-07', 100], // B bought at its open of the 7th (10) - it did not move
    ],
  );
  assert.equal(r.notes.find((n) => n.code === 'ruleCash').days, 2);
});

test('a constituent whose prices stop is sold at its last close, and the index carries on', () => {
  // A goes on trading into February; B's bars stop on the 3rd of January,
  // which is more than the fortnight's grace before the last session
  const long = { symbol: 'A', source: 'test', days: [...A.days, ...bars([['2020-02-10', 20, 20, 20, 20], ['2020-02-11', 20, 20, 20, 20]])] };
  const short = { symbol: 'B', source: 'test', days: B.days.slice(0, 2) };
  const r = ruleSeries([long, short], [ev('2020-01-01', ['A', 'B'])]);
  // the 2nd and 3rd: half in A, half in B. The 6th: B has no price left, so
  // it goes at its last close (5) and the proceeds buy A.
  assert.deepEqual(
    r.bars.map((b) => [b.time, b.close]),
    [['2020-01-02', 100], ['2020-01-03', 150], ['2020-01-06', 150], ['2020-01-07', 150], ['2020-02-10', 150], ['2020-02-11', 150]],
  );
  assert.equal(r.constituents.find((c) => c.symbol === 'B').delisted, true);
  assert.equal(r.bars.length, 6, 'one name leaving does not shorten the chart');
});

test('a series that is only a day or two behind the others is carried, not treated as delisted', () => {
  const behind = { symbol: 'B', source: 'test', days: B.days.slice(0, 3) }; // nothing for the 7th yet
  const r = ruleSeries([A, behind], [ev('2020-01-01', ['A', 'B'])]);
  const b = r.constituents.find((c) => c.symbol === 'B');
  assert.equal(b.delisted, false, 'the last session is often one symbol\'s alone');
  assert.equal(b.last, '2020-01-07', 'it stays in the index at its last close');
  assert.equal(r.counts.length, 1, 'and nothing is rebalanced over it');
});

test('a share too cheap to trade is held by the rules but never bought', () => {
  // a sub-penny shell: one tick is a 100% move, and at equal weight its
  // quote noise would be the whole index
  const shell = { symbol: 'C', source: 'test', days: bars([['2020-01-02', 0.000001, 0.000001, 0.000001, 0.000001], ['2020-01-03', 0.000001, 0.0001, 0.000001, 0.0001], ['2020-01-06', 0.0001, 0.0001, 0.0001, 0.0001], ['2020-01-07', 0.0001, 0.0001, 0.0001, 0.0001]]) };
  const r = ruleSeries([A, shell], [ev('2020-01-01', ['A', 'C'])]);
  assert.deepEqual(r.bars.map((b) => b.close), [100, 200, 200, 200], 'A alone, as if the shell were not there');
  assert.equal(r.counts[0].n, 1);
  const c = r.constituents.find((x) => x.symbol === 'C');
  assert.equal(c.days, 0);
  assert.equal(c.cheap, 1, 'and the rebalances it sat out are counted - January is one of them');
  assert.equal(ruleSeries([A, shell], [ev('2020-01-01', ['A', 'C'])], { rebalance: 'filing' }).constituents.find((x) => x.symbol === 'C').cheap, 4, 'trading on every filing looks every session');
  assert.equal(r.notes.find((n) => n.code === 'ruleCheap')?.n, 1);
  // with the floor off it is bought, and one tick is +4,950% on the index
  const raw = ruleSeries([A, shell], [ev('2020-01-01', ['A', 'C'])], { minPrice: 0 });
  assert.ok(raw.stats.total > 40, 'which is exactly why the floor is there');
});

test('a schedule with no prices at all says so instead of throwing', () => {
  const r = ruleSeries([{ symbol: 'A', days: [] }], [ev('2020-01-01', ['A'])]);
  assert.deepEqual(r.bars, []);
  assert.equal(r.stats, null);
  assert.ok(r.notes.some((n) => n.code === 'ruleNoBars'));
});

// --- a window over the same replay ---
test('a window starts the index at 100 on its own first session, holding what the rules held then', () => {
  // A from the start, B from the 3rd: a window opening on the 3rd holds both
  // from the 6th's open, and the index is 100 on its first session
  const events = [ev('2020-01-01', ['A']), ev('2020-01-03', ['B'])];
  const full = { members: [{ ticker: 'A', spans: [{ from: '2020-01-01', to: null }] }, { ticker: 'B', spans: [{ from: '2020-01-03', to: null }] }], events, skipped: [], tested: 2, first: '2020-01-01', last: '2020-01-03' };
  const w = windowSchedule(full, { from: '2020-01-03' });
  assert.deepEqual(w.events, [{ date: '2020-01-03', add: ['A', 'B'], drop: [], n: 2, opening: true }], 'everything decided by then is one opening position');
  const r = ruleSeries([A, B], w.events, { from: '2020-01-03' });
  assert.deepEqual(
    r.bars.map((b) => [b.time, b.close]),
    [
      ['2020-01-06', 150], // 50 into A at 20, 50 into B at 5; B doubles
      ['2020-01-07', 150],
    ],
  );
  assert.equal(r.start, '2020-01-06');
  assert.equal(r.bars[0].open, 100, 'the window opens at 100, whatever the index did before it');
});

test('a window ends where it is told: nothing after it is replayed', () => {
  const r = ruleSeries([A, B], [ev('2020-01-01', ['A']), ev('2020-01-03', ['B'])], { to: '2020-01-06', rebalance: 'filing' });
  assert.deepEqual(r.bars.map((b) => b.time), ['2020-01-02', '2020-01-03', '2020-01-06']);
  assert.equal(r.end, '2020-01-06');
  assert.equal(r.constituents.find((c) => c.symbol === 'B').days, 1, "and a constituent's return is what it did inside the window");
});

test('a window drops the companies it never holds, so their bars are never fetched', () => {
  const events = [ev('2020-01-01', ['A'], [], 1), ev('2020-01-02', [], ['A'], 0), ev('2020-01-06', ['B'], [], 1)];
  const full = {
    members: [
      { ticker: 'A', spans: [{ from: '2020-01-01', to: '2020-01-02' }] },
      { ticker: 'B', spans: [{ from: '2020-01-06', to: null }] },
    ],
    events,
    skipped: [],
    tested: 3,
    first: '2020-01-01',
    last: '2020-01-06',
  };
  const w = windowSchedule(full, { from: '2020-01-03' });
  assert.deepEqual(w.members.map((m) => m.ticker), ['B'], 'A was already out when the window opened');
  assert.deepEqual(w.events, [ev('2020-01-06', ['B'], [], 1)]);
  // and one that closes before a name is picked does not know about it either
  const early = windowSchedule(full, { to: '2020-01-05' });
  assert.deepEqual(early.members.map((m) => m.ticker), ['A']);
});

test('the stretches a member was held for are clipped to the window', () => {
  const full = {
    members: [{ ticker: 'A', spans: [{ from: '2019-01-01', to: '2020-06-01' }, { from: '2021-01-01', to: null }] }],
    events: [ev('2019-01-01', ['A']), ev('2020-06-01', [], ['A']), ev('2021-01-01', ['A'])],
    skipped: [],
    tested: 3,
  };
  const w = windowSchedule(full, { from: '2020-01-01', to: '2020-12-31' });
  assert.deepEqual(w.members[0].spans, [{ from: '2020-01-01', to: '2020-06-01' }], 'the stretch that started before the window starts with it, the one after it never happened');
  const open = windowSchedule(full, { from: '2021-06-01' });
  assert.deepEqual(open.members[0].spans, [{ from: '2021-06-01', to: null }], 'still held when the window closes');
});

test('a range preset is counted back from the end of the window, and no window is the whole history', () => {
  const q = { params: { score_min: 60 } };
  assert.deepEqual(ruleRequest({ ...q, range: '3y' }, '2026-09-23').from, '2023-09-23');
  assert.deepEqual(ruleRequest({ ...q, range: '1y', to: '2020-12-31' }, '2026-09-23').from, '2019-12-31');
  const all = ruleRequest(q, '2026-09-23');
  assert.equal(all.from, null);
  assert.equal(all.range, 'all');
  const typed = ruleRequest({ ...q, from: '2020-12-31', to: '2019-01-01' }, '2026-09-23');
  assert.deepEqual([typed.from, typed.to], ['2019-01-01', '2020-12-31'], 'a window typed back to front is turned round');
  const schedule = { members: [], events: [] };
  assert.equal(windowSchedule(schedule, all), schedule, 'no window: the schedule is handed back as it is');
});

// --- the rebalance schedule ---
const flat = (symbol, price, days, shares = null) => ({
  symbol,
  source: 'test',
  days: days.map(([date, p]) => ({ date, open: p ?? price, high: p ?? price, low: p ?? price, close: p ?? price, volume: 100 })),
  ...(shares ? { shares } : {}),
});
const JAN_FEB = [['2020-01-02'], ['2020-01-03'], ['2020-01-31'], ['2020-02-03'], ['2020-02-04']];

test('the portfolio is only rebuilt on the first session of each month', () => {
  const a = flat('A', 10, JAN_FEB);
  const b = flat('B', 5, JAN_FEB);
  // B qualifies in the middle of January - it waits for February
  const r = ruleSeries([a, b], [ev('2020-01-01', ['A']), ev('2020-01-15', ['B'])]);
  assert.deepEqual(r.counts, [{ date: '2020-01-02', n: 1 }, { date: '2020-02-03', n: 2 }]);
  assert.equal(r.constituents.find((c) => c.symbol === 'B').first, '2020-02-03');
  // and quarterly waits until April, yearly until next January
  assert.deepEqual(ruleSeries([a, b], [ev('2020-01-01', ['A']), ev('2020-01-15', ['B'])], { rebalance: 'quarterly' }).counts, [{ date: '2020-01-02', n: 1 }]);
  assert.deepEqual(ruleSeries([a, b], [ev('2020-01-01', ['A']), ev('2020-01-15', ['B'])], { rebalance: 'filing' }).counts, [{ date: '2020-01-02', n: 1 }, { date: '2020-01-31', n: 2 }]);
});

test('a holding whose prices stop is sold between rebalances, the money spread over the rest', () => {
  const a = flat('A', 10, JAN_FEB);
  const b = flat('B', 5, [['2020-01-02'], ['2020-01-03']]); // stops dead in January
  const r = ruleSeries([a, b], [ev('2020-01-01', ['A', 'B'])]);
  assert.deepEqual(r.bars.map((x) => [x.time, Math.round(x.close)]), [
    ['2020-01-02', 100],
    ['2020-01-03', 100],
    ['2020-01-31', 100], // B sold at its last close, all of it into A - the level does not jump
    ['2020-02-03', 100],
    ['2020-02-04', 100],
  ]);
  assert.equal(r.counts.find((c) => c.date === '2020-01-31').n, 1, 'sold the day its prices were gone, not at the next rebalance');
  assert.equal(r.constituents.find((c) => c.symbol === 'B').delisted, true);
});

test('market-value weighting is the share count of the filing that was current, times the price that day', () => {
  const shares = (v) => [{ date: '2019-01-01', value: v }];
  // A is worth 100m x $10, B 10m x $5 - and B doubles the next session
  const a = flat('A', 10, [['2020-01-02'], ['2020-01-03']], shares(100));
  const b = flat('B', 5, [['2020-01-02'], ['2020-01-03', 10]], shares(10));
  const events = [ev('2020-01-01', ['A', 'B'])];
  const at = (opts) => ruleSeries([a, b], events, opts).bars.at(-1).close;
  assert.equal(Math.round(at({ weighting: 'equal' }) * 100) / 100, 150, 'equal weight: half of the index doubles');
  assert.equal(Math.round(at({ weighting: 'cap', maxWeight: 1 }) * 1000) / 1000, 104.762, 'by market value, B is 1/21 of it');
  assert.equal(Math.round(at({ weighting: 'cap', maxWeight: 0.6 }) * 100) / 100, 140, 'a ceiling of 60% leaves B with 40%');
});

test('a company whose filings never carried a share count is weighted as the median, not dropped', () => {
  const a = flat('A', 10, [['2020-01-02'], ['2020-01-03']], [{ date: '2019-01-01', value: 100 }]);
  const b = flat('B', 5, [['2020-01-02'], ['2020-01-03', 10]]); // no share count at all
  const r = ruleSeries([a, b], [ev('2020-01-01', ['A', 'B'])], { weighting: 'cap', maxWeight: 1 });
  assert.equal(Math.round(r.bars.at(-1).close), 150, 'B takes A’s market value, so the two are even');
  assert.equal(r.notes.find((x) => x.code === 'ruleNoShares').n, 1);
});

const w4 = (xs) => xs.map((x) => Math.round(x * 1e4) / 1e4);
test('the weight ceiling is spread over the rest, and an impossible one is ignored', () => {
  assert.deepEqual(w4(capWeights([0.7, 0.2, 0.1], 0.4)), [0.4, 0.4, 0.2]);
  assert.deepEqual(w4(capWeights([0.5, 0.5], 1)), [0.5, 0.5]);
  assert.deepEqual(w4(capWeights([0.7, 0.2, 0.1], 0.1)), [0.3333, 0.3333, 0.3333], 'a tenth each over three names cannot add to one');
  assert.deepEqual(w4(marketWeights([100, 50, 0], null)), [0.4, 0.2, 0.4]);
  assert.deepEqual(w4(marketWeights([0, 0], null)), [0.5, 0.5], 'nobody has a share count: equal weight');
});

// --- Nasdaq-100's constraints ---
const pct = (xs) => xs.map((x) => Math.round(x * 1e4) / 100);
const hundred = (top) => [...top, ...Array(100 - top.length).fill((1 - top.reduce((a, b) => a + b, 0)) / (100 - top.length))];

test('the three stages hold together over an index the size they were written for', () => {
  const before = hundred([0.3, 0.14, 0.1, 0.08, 0.06]);
  assert.equal(breachesConstraints(before, NDX_CONSTRAINTS), true, '30% in one name is past the 24% trigger');
  const after = constrainWeights(before, NDX_CONSTRAINTS);
  assert.equal(Math.round(after.reduce((a, b) => a + b, 0) * 1e6) / 1e6, 1, 'the weights still add to one');
  assert.ok(Math.max(...after) <= 0.2 + 1e-9, 'stage 1: nobody above 20%');
  assert.equal(pct([after.filter((x) => x > 0.045).reduce((a, b) => a + b, 0)])[0] < 48, true, 'stage 2: the >4.5% group is under 48%');
  assert.deepEqual(pct([[...after].sort((a, b) => b - a).slice(0, 5).reduce((a, b) => a + b, 0)]), [38.5], 'security stage 2: the five largest are brought to 38.5%');
  for (let i = 1; i < 5; i++) assert.ok(after[i - 1] >= after[i], 'and the rank order is kept');
  assert.equal(breachesConstraints(after, NDX_CONSTRAINTS), false, 'nothing is left breached');
});

test('a target no small index could meet settles at the lowest level the rest can absorb', () => {
  // twelve names cannot all be under 4.5%, and five of twelve cannot hold 38.5%
  const w = constrainWeights(Array.from({ length: 12 }, (_, i) => (i === 0 ? 0.45 : 0.55 / 11)), NDX_CONSTRAINTS);
  assert.equal(Math.round(w.reduce((a, b) => a + b, 0) * 1e6) / 1e6, 1);
  assert.ok(Math.max(...w) <= 0.2 + 1e-9, 'the one constraint that is meetable still is');
  assert.ok(w.every((x) => x > 0), 'and nobody is squeezed to nothing');
});

test('a plain ceiling is watched a fifth above itself, the way Nasdaq watches 24 against 20', () => {
  const c = singleCap(0.1);
  assert.deepEqual(c.single, { over: 0.1, to: 0.1, watch: 0.12 });
  const ten = (head) => [head, ...Array(9).fill((1 - head) / 9)];
  assert.equal(breachesConstraints(ten(0.11), c), false, 'drifting to 11% is not worth a trade');
  assert.equal(breachesConstraints(ten(0.13), c), true, '13% is');
});

test('a name that runs away is rebuilt before the next scheduled rebalance', () => {
  const shares = [{ date: '2019-01-01', value: 100 }];
  const days = ['2020-01-02', '2020-01-03', '2020-01-06', '2020-01-07', '2020-01-08', '2020-02-03'];
  const px = [10, 10, 100, 100, 100, 100];
  const a = { symbol: 'A', source: 'test', shares, days: days.map((date, i) => ({ date, open: px[i], high: px[i], low: px[i], close: px[i], volume: 100 })) };
  const b = { symbol: 'B', source: 'test', shares, days: days.map((date) => ({ date, open: 10, high: 10, low: 10, close: 10, volume: 100 })) };
  const opts = { weighting: 'cap', maxWeight: 0.6, from: null };
  const r = ruleSeries([a, b], [ev('2020-01-01', ['A', 'B'])], opts);
  assert.deepEqual(r.counts.map((c) => [c.date, !!c.special]), [
    ['2020-01-02', false], // the month's own rebalance
    ['2020-01-07', true], // A was 91% of the index at the close of the 6th
    ['2020-02-03', false],
  ]);
  assert.equal(r.specials, 1);
  assert.equal(r.notes.find((n) => n.code === 'ruleSpecial')?.n, 1);
  // and with it turned off the ceiling is only restored in February
  const off = ruleSeries([a, b], [ev('2020-01-01', ['A', 'B'])], { ...opts, special: false });
  assert.deepEqual(off.counts.map((c) => c.date), ['2020-01-02', '2020-02-03']);
  assert.equal(off.specials, 0);
});

test('rebalance sessions are the first of each period', () => {
  const d = ['2024-01-02', '2024-01-03', '2024-02-01', '2024-03-28', '2024-04-01', '2025-01-02'];
  assert.deepEqual([...rebalanceSessions(d, 'monthly')], [1, 0, 1, 1, 1, 1]);
  assert.deepEqual([...rebalanceSessions(d, 'quarterly')], [1, 0, 0, 0, 1, 1]);
  assert.deepEqual([...rebalanceSessions(d, 'yearly')], [1, 0, 0, 0, 0, 1]);
  assert.equal(rebalanceSessions(d, 'filing'), null);
});
