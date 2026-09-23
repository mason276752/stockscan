import test from 'node:test';
import assert from 'node:assert/strict';
import { asOfDate, asOfShardOf, asOfShardYears, pickAsOf, screenAsOfColumns, screenAsOfIndex, screenAsOfTable, screenColumns, screenQuery, screenRows } from '../server/lib/screen.js';
import { withHistory } from '../server/lib/score.js';

// two companies' saved scores, newest report date first (as the store hands
// them over). B filed its Q1 late, after A had already filed the same quarter.
const score = (cik, accession, form, filingDate, periodEnd, fiscalYear, fiscalPeriod, n) => ({
  accession,
  cik,
  form,
  filingDate,
  periodEnd,
  fiscalYear,
  fiscalPeriod,
  score: n,
  coverage: 90,
  categories: [{ score: n }, { score: n }],
  values: { roe: n, grossMargin: n * 2, revenueAnn: n * 1e6 },
});
const SCORES = {
  1: [
    score(1, 'a4', '10-Q', '2026-05-01', '2026-03-31', '2026', 'Q1', 80),
    score(1, 'a3x', '10-K/A', '2026-02-15', '2025-12-31', '2025', 'FY', 75), // amended: never the current one
    score(1, 'a3', '10-K', '2026-02-01', '2025-12-31', '2025', 'FY', 70),
    score(1, 'a2', '10-Q', '2025-05-01', '2025-03-31', '2025', 'Q1', 60),
    score(1, 'a1', '10-K', '2025-02-01', '2024-12-31', '2024', 'FY', 50),
  ],
  2: [
    score(2, 'b2', '10-Q', '2026-06-10', '2026-03-31', '2026', 'Q1', 90),
    score(2, 'b1', '10-K', '2025-03-01', '2024-12-31', '2024', 'FY', 40),
  ],
};
const COMPANIES = new Map(
  [1, 2].map((cik) => [cik, { cik, ticker: `T${cik}`, tickers: [`T${cik}`], name: `Company ${cik}`, sic: '7372', afs: 'LAF', float: 1e9 }]),
);

test('as-of date: only a past YYYY-MM-DD, else now', () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(asOfDate('2024-06-30'), '2024-06-30');
  assert.equal(asOfDate(today), null);
  assert.equal(asOfDate('2099-01-01'), null);
  assert.equal(asOfDate('2024-6-3'), null);
  assert.equal(asOfDate(''), null);
  assert.equal(asOfDate(undefined), null);
});

test('the current filing is the newest one already filed, amendments aside', () => {
  const at = (asof) => pickAsOf(SCORES[1], asof);
  assert.equal(at(null).cur.accession, 'a4');
  assert.equal(at('2026-05-01').cur.accession, 'a4', 'the filing date itself counts');
  assert.equal(at('2026-04-30').cur.accession, 'a3', 'a4 was not out yet');
  assert.equal(at('2026-02-20').cur.accession, 'a3', 'the amendment is skipped');
  assert.equal(at('2025-01-31').cur, null, 'nothing filed yet');
  // prev / yoy move back with it
  const q1 = at('2026-05-15');
  assert.equal(q1.prev.accession, 'a3');
  assert.equal(q1.yoy.accession, 'a2', 'the same quarter a year earlier');
  const fy = at('2026-04-30');
  assert.equal(fy.prev.accession, 'a2');
  assert.equal(fy.yoy.accession, 'a1');
  assert.equal(fy.history, 3);
});

test('a late filing does not show up before it was filed', () => {
  assert.equal(pickAsOf(SCORES[2], '2026-05-15').cur.accession, 'b1');
  assert.equal(pickAsOf(SCORES[2], '2026-06-10').cur.accession, 'b2');
});

test('only the newest filings are looked back at', () => {
  const many = Array.from({ length: 9 }, (_, i) => score(3, `c${i}`, '10-Q', `2026-0${9 - i}-01`, `2026-0${9 - i}-01`, '2026', 'Q1', 10));
  assert.equal(pickAsOf(many, null).history, 6);
  assert.equal(pickAsOf(many, null, 2).history, 2);
});

// the server reads the scores as row objects, the static site the same
// figures as columns: both must answer a dated query identically
const serverRows = (asof) => screenRows([1, 2].map((cik) => withHistory(SCORES[cik], asof)).filter(Boolean), COMPANIES);
// the static side ships one file per year of filing date and loads the few
// years a date can reach; `years` says which ones are in the browser
const ALL = [...SCORES[1], ...SCORES[2]];
const shardOf = (year) => screenAsOfColumns(ALL.filter((s) => asOfShardOf(s) === year));
const staticTable = (asof, years = asOfShardYears(asof || '2026-12-31')) => {
  const cols = screenColumns(serverRows(null)).screen; // the company / market columns: always the current ones
  return screenAsOfTable(cols, screenAsOfIndex(years.map(shardOf)), asof);
};
const query = { sort: 'score', dir: 'desc', limit: 10 };

test('the screener reads every company as of the date', () => {
  for (const [asof, expected] of [
    [null, [['T1', 80], ['T2', 90]]],
    ['2026-06-30', [['T1', 80], ['T2', 90]]],
    ['2026-05-15', [['T1', 80], ['T2', 40]]], // T2's Q1 was not filed until June
    ['2026-02-20', [['T1', 70], ['T2', 40]]], // the amendment is not the current filing
    ['2025-04-01', [['T2', 40], ['T1', 50]]],
    ['2025-02-15', [['T1', 50]]], // T2 had not filed anything yet
    ['2025-01-01', []],
  ]) {
    const server = screenQuery(serverRows(asof), query);
    const built = screenQuery(staticTable(asof), query);
    const got = server.rows.map((r) => [r.ticker, r.score.score]).sort();
    assert.deepEqual(got, [...expected].sort(), `server rows as of ${asof}`);
    assert.deepEqual(
      built.rows.map((r) => [r.ticker, r.score.score]).sort(),
      [...expected].sort(),
      `static columns as of ${asof}`,
    );
    assert.deepEqual(JSON.parse(JSON.stringify(built.rows)), JSON.parse(JSON.stringify(server.rows)), `identical rows as of ${asof}`);
  }
});

test('a date reads its own year and the two before it', () => {
  assert.deepEqual(asOfShardYears('2026-05-15'), [2026, 2025, 2024]);
  assert.deepEqual(asOfShardYears('2026-05-15', [2026, 2025, 2019]), [2026, 2025], 'only the years the build published');
  assert.deepEqual(asOfShardYears('2015-01-01', [2026, 2025]), [], 'a date the build cannot answer');
  assert.equal(asOfShardOf({ filingDate: '2026-02-01', periodEnd: '2025-12-31' }), 2026, 'by filing date, not by period');
});

test('the year files answer exactly as one whole index would', () => {
  for (const asof of ['2026-05-15', '2026-02-20', '2025-04-01', '2025-02-15']) {
    assert.equal(screenQuery(staticTable(asof, [1900]), query).total, 0, 'no year loaded: nothing to screen');
    const sharded = screenQuery(staticTable(asof), query);
    const server = screenQuery(serverRows(asof), query);
    assert.deepEqual(
      sharded.rows.map((r) => [r.ticker, r.score.accession]),
      server.rows.map((r) => [r.ticker, r.score.accession]),
      `as of ${asof}`,
    );
    // the order the years are loaded in must not matter
    const reversed = screenQuery(staticTable(asof, asOfShardYears(asof).slice().reverse()), query);
    assert.deepEqual(reversed.rows.map((r) => r.score.accession), sharded.rows.map((r) => r.score.accession));
  }
});

test('change filters compare with the filings of that date', () => {
  // T1 as of 2026-05-15: Q1 2026 (roe 80) against Q1 2025 (roe 60) = +20 points
  const rows = screenQuery(serverRows('2026-05-15'), { ...query, roe_yoy_min: 20 }).rows;
  assert.deepEqual(rows.map((r) => r.ticker), ['T1']);
  assert.equal(rows[0].yoy.values.roe, 60);
  assert.equal(screenQuery(serverRows('2026-05-15'), { ...query, roe_yoy_min: 21 }).total, 0);
  // and the columns agree
  assert.equal(screenQuery(staticTable('2026-05-15'), { ...query, roe_yoy_min: 20 }).rows[0].ticker, 'T1');
  assert.equal(screenQuery(staticTable('2026-05-15'), { ...query, roe_yoy_min: 21 }).total, 0);
});
