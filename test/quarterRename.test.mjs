import test from 'node:test';
import assert from 'node:assert/strict';
import { yearQuarterPoints } from '../server/lib/quarters.js';
import { C, first } from '../server/lib/indicators.js';

// a filer's cash flow statement, year-to-date column only (the usual shape)
const END = { Q1: '2026-03-31', Q2: '2026-06-30', Q3: '2026-09-30', FY: '2026-12-31' };
const doc = (end, rows) => ({
  allStatements: [],
  statements: {
    cash_flow: {
      columns: [{ id: 'c1', dimensions: {}, period: { start: '2026-01-01', end, instant: null } }],
      lineItems: Object.entries(rows).map(([concept, value]) => ({ concept, label: concept, abstract: false, values: { c1: { value } } })),
    },
  },
});
const quarters = (byPeriod) => {
  const docs = {};
  const filings = {};
  for (const [q, rows] of Object.entries(byPeriod)) {
    docs[q] = doc(END[q], rows);
    filings[q] = { accession: `acc-${q}`, reportDate: END[q], form: q === 'FY' ? '10-K' : '10-Q' };
  }
  return yearQuarterPoints(docs, filings);
};
const flowsOf = (points, period) => points.find((p) => p.period === period).flows;

const DIV = 'us-gaap:PaymentsOfDividends';
const ORDINARY = 'us-gaap:PaymentsOfOrdinaryDividends';
const COMMON = 'us-gaap:PaymentsOfDividendsCommonStock';

test('a line renamed mid-year still yields the quarter (Alphabet 2026 Q2 dividends)', () => {
  const flows = flowsOf(quarters({ Q1: { [DIV]: 2542 }, Q2: { [ORDINARY]: 5231 } }), 'Q2');
  assert.equal(flows[ORDINARY], 2689); // 5231 year-to-date − 2542 in Q1
  assert.equal(first(flows, C.dividends), 2689);
});

test('the renamed line carries on: Q3 subtracts its own cumulative', () => {
  const flows = flowsOf(quarters({ Q1: { [DIV]: 2542 }, Q2: { [ORDINARY]: 5231 }, Q3: { [ORDINARY]: 7900 } }), 'Q3');
  assert.equal(flows[ORDINARY], 2669);
});

test('a rename in the 10-K gives Q4 = year − nine months', () => {
  const points = quarters({ Q1: { [DIV]: 2542 }, Q2: { [DIV]: 5231 }, Q3: { [DIV]: 7900 }, FY: { [ORDINARY]: 10700 } });
  assert.equal(points.find((p) => p.period === 'Q4').flows[ORDINARY], 2800);
});

test('a line that is still reported is a second line, not a new name', () => {
  const flows = flowsOf(quarters({ Q1: { [DIV]: 2542 }, Q2: { [DIV]: 5231, [ORDINARY]: 900 } }), 'Q2');
  assert.equal(flows[DIV], 2689);
  assert.equal(flows[ORDINARY], null);
});

test('two candidates that both vanished are ambiguous: no quarter', () => {
  const flows = flowsOf(quarters({ Q1: { [DIV]: 2000, [COMMON]: 542 }, Q2: { [ORDINARY]: 5231 } }), 'Q2');
  assert.equal(flows[ORDINARY], null);
});

test('concepts that are not interchangeable do not bridge', () => {
  const flows = flowsOf(quarters({ Q1: { [DIV]: 2542 }, Q2: { 'us-gaap:PaymentsForRepurchaseOfCommonStock': 5231 } }), 'Q2');
  assert.equal(flows['us-gaap:PaymentsForRepurchaseOfCommonStock'], null);
});

test('basic and diluted per-share lines are a preference order, not one series', () => {
  const eps = (rows) => ({
    allStatements: [],
    statements: {
      income_statement: {
        columns: [{ id: 'c1', dimensions: {}, period: { start: '2026-01-01', end: END.Q2, instant: null } }],
        lineItems: Object.entries(rows).map(([concept, value]) => ({ concept, label: concept, abstract: false, values: { c1: { value } } })),
      },
    },
  });
  const points = yearQuarterPoints(
    { Q1: eps({ 'us-gaap:EarningsPerShareBasic': 1 }), Q2: eps({ 'us-gaap:EarningsPerShareDiluted': 1.9 }) },
    { Q1: { accession: 'a1', reportDate: END.Q1, form: '10-Q' }, Q2: { accession: 'a2', reportDate: END.Q2, form: '10-Q' } },
  );
  assert.equal(flowsOf(points, 'Q2')['us-gaap:EarningsPerShareDiluted'], null);
});
