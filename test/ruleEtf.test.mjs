import test from 'node:test';
import assert from 'node:assert/strict';
import { screenAsOfColumns, screenAsOfIndex } from '../server/lib/screen.js';
import { replaySchedule, ruleSeries } from '../server/lib/ruleEtf.js';

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
  const r = ruleSeries([A, B], [ev('2020-01-01', ['A']), ev('2020-01-03', ['B']), ev('2020-01-06', [], ['A'])]);
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
  const r = ruleSeries([A, B], [ev('2020-01-01', ['A']), ev('2020-01-02', [], ['A']), ev('2020-01-06', ['B'])]);
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
  assert.equal(c.cheap, 4, 'and the days it sat out are counted');
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
