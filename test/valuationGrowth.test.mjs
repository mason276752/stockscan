import test from 'node:test';
import assert from 'node:assert/strict';
import { buildValuation } from '../server/lib/valuation.js';

// An annual filer whose share count multiplies by ten between the two years:
// no split events are shipped in the static build, so buildValuation infers
// the split from the share counts of consecutive filings. The per-share
// figures of the earlier filing are on the basis of the day it was filed.
const year = (end, { revenue, netIncome, eps, equity, shares }) => ({
  allStatements: [],
  coverShares: [{ end, value: shares, concept: 'dei:EntityCommonStockSharesOutstanding', basis: 'aggregate', classes: 1 }],
  statements: {
    income_statement: {
      columns: [{ id: 'd', dimensions: {}, period: { start: `${end.slice(0, 4)}-01-01`, end, instant: null } }],
      lineItems: [
        { concept: 'us-gaap:Revenues', label: 'Revenues', abstract: false, values: { d: { value: revenue } } },
        { concept: 'us-gaap:NetIncomeLoss', label: 'Net income', abstract: false, values: { d: { value: netIncome } } },
        { concept: 'us-gaap:EarningsPerShareDiluted', label: 'EPS', abstract: false, values: { d: { value: eps } } },
      ],
    },
    balance_sheet: {
      columns: [{ id: 'i', dimensions: {}, period: { start: null, end: null, instant: end } }],
      lineItems: [{ concept: 'us-gaap:StockholdersEquity', label: 'Equity', abstract: false, values: { i: { value: equity } } }],
    },
  },
});

const DOCS = {
  '2024': year('2024-12-31', { revenue: 100e6, netIncome: 50e6, eps: 5, equity: 1000e6, shares: 100e6 }),
  '2025': year('2025-12-31', { revenue: 120e6, netIncome: 60e6, eps: 0.6, equity: 1200e6, shares: 1000e6 }),
};
const company = {
  cik: 1,
  name: 'Ten For One Inc.',
  tickers: ['TFO'],
  filings: [
    { accession: 'acc-2025', form: '10-K', fiscalYear: 2025, fiscalPeriod: 'FY', reportDate: '2025-12-31', filingDate: '2026-02-01' },
    { accession: 'acc-2024', form: '10-K', fiscalYear: 2024, fiscalPeriod: 'FY', reportDate: '2024-12-31', filingDate: '2025-02-01' },
  ],
};
// closes as the source reports them today: adjusted for the split, so the
// 2024 quote of 200 shows up as 20
const days = [
  { date: '2024-12-31', close: 20 },
  { date: '2025-12-31', close: 30 },
];
const deps = {
  load: async (f) => DOCS[String(f.fiscalYear)],
  shares: async () => ({ version: 2, byAccn: {}, list: [] }),
  prices: async () => ({ symbol: 'TFO', source: 'test', currency: 'USD', days, splits: null }),
  fx: async () => null,
};

test('growth compares per-share figures on one share basis across a split', async () => {
  const v = await buildValuation(company, { year: 2025, period: 'FY', n: 2 }, deps);
  assert.deepEqual(v.priceHistory.splits, [{ date: '2025-01-01', ratio: 10 }]);
  assert.equal(v.growth.years, 1);
  assert.equal(Math.round(v.growth.revenue * 1000) / 1000, 0.2); // a total: nothing to undo
  assert.equal(Math.round(v.growth.eps * 1000) / 1000, 0.2); // 5 before the split is 0.50 after it
  assert.equal(Math.round(v.growth.bvps * 1000) / 1000, 0.2);
});

test('the quoted price of a column is the one of its own share basis', async () => {
  const v = await buildValuation(company, { year: 2025, period: 'FY', n: 2 }, deps);
  const [before, after] = v.columns;
  assert.equal(before.price, 200); // the split undone: what it traded at then
  assert.equal(before.multiples.pe, 40); // 200 / 5, not 20 / 5
  assert.equal(after.price, 30);
  assert.equal(after.multiples.pe, 50);
});
