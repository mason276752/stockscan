import test from 'node:test';
import assert from 'node:assert/strict';
import { conceptOf, dateSnapper, deraResult, mainCurrency, ownPrefixOf, parseSegments, unitOf } from '../server/lib/dera.js';
import { reclassify } from '../server/lib/statementTypes.js';
import { scoreFiling } from '../server/lib/scoreModel.js';

test('a tag names a concept the rest of the app recognises', () => {
  assert.equal(conceptOf('Assets', 'us-gaap/2025', 'tst'), 'us-gaap:Assets');
  // SEC's datasets call the IFRS taxonomy `ifrs`; the filings (and concepts.js) call it ifrs-full
  assert.equal(conceptOf('Equity', 'ifrs/2025', 'tst'), 'ifrs-full:Equity');
  assert.equal(conceptOf('Revenue', 'dei/2025', 'tst'), 'dei:Revenue');
  // an extension tag is versioned by the accession itself: it belongs to the filer
  assert.equal(conceptOf('SpecialThing', '0000320193-26-000013', 'aapl'), 'aapl:SpecialThing');
  assert.equal(ownPrefixOf('aapl-20260328_htm.xml'), 'aapl');
  assert.equal(ownPrefixOf('aapl-20111231.xml'), 'aapl', 'the pre-2019 spelling too');
  assert.equal(ownPrefixOf(''), 'ext');
});

test('the unit says what kind of number it is, which num.txt alone does not', () => {
  // a per-share amount is USD in num.txt like any other; only tag.txt's
  // datatype tells them apart, and quarters.js reads the '/' to know it
  // cannot subtract one period from another exactly
  assert.equal(unitOf('USD', 'perShare'), 'USD/shares');
  assert.equal(unitOf('USD', 'monetary'), 'USD');
  assert.equal(unitOf('shares', 'shares'), 'shares');
  assert.equal(unitOf('pure', 'percent'), 'pure');
  assert.equal(unitOf('EUR', undefined), 'EUR', 'an unknown datatype keeps the unit of measure');
});

test('segments become the dimensions of a column, and a truncated one drops it', () => {
  assert.deepEqual(parseSegments(''), {});
  assert.deepEqual(parseSegments('BusinessSegments=AmericasSegment;ConsolidationItems=OperatingSegments;'), {
    'dera:BusinessSegmentsAxis': 'dera:AmericasSegmentMember',
    'dera:ConsolidationItemsAxis': 'dera:OperatingSegmentsMember',
  });
  // SEC cuts the field off at its width; a half member is not a dimension
  assert.equal(parseSegments('BusinessSegments=AmericasSegment;Consolidation'), null);
});

test('a rounded date snaps back onto the period end the company really filed', () => {
  const snap = dateSnapper(['2021-12-28', '2020-12-29', '2021-09-28']);
  assert.equal(snap('2021-12-31'), '2021-12-28');
  assert.equal(snap('2020-12-31'), '2020-12-29');
  assert.equal(snap('2021-09-30'), '2021-09-28');
  assert.equal(snap('2018-06-30'), '2018-06-30', 'nothing within a fortnight: left as it is');
  assert.equal(dateSnapper([])('2021-12-31'), '2021-12-31');
});

// ---------------------------------------------------------------------------
// One small 10-K, the way a quarter's files carry it.

const SUB = {
  name: 'TEST CO',
  instance: 'tst-20211231.xml',
  fy: '2021',
  fp: 'FY',
};
const FILING = {
  cik: 1,
  accession: '0000000000-22-000001',
  form: '10-K',
  filingDate: '2022-02-15',
  // EDGAR's exact period end - a 52/53-week year, which the dataset rounds
  reportDate: '2021-12-28',
  primaryDocument: 'tst-20211231.htm',
  documentUrl: 'https://example.invalid/tst-20211231.htm',
};
const TAGS = {
  Assets: 'monetary',
  Liabilities: 'monetary',
  StockholdersEquity: 'monetary',
  Revenues: 'monetary',
  NetIncomeLoss: 'monetary',
  EarningsPerShareDiluted: 'perShare',
  CashAndCashEquivalentsAtCarryingValue: 'monetary',
  NetCashProvidedByUsedInOperatingActivities: 'monetary',
};
const tagOf = (tag) => ({
  datatype: TAGS[tag] || 'monetary',
  tlabel: `${tag} (standard)`,
  doc: `what ${tag} means`,
});

const num = (tag, ddate, qtrs, value, extra = {}) => ({
  tag,
  version: 'us-gaap/2021',
  ddate,
  qtrs,
  uom: TAGS[tag] === 'perShare' ? 'USD' : 'USD',
  segments: '',
  coreg: '',
  value: String(value),
  ...extra,
});
const pre = (report, line, stmt, tag, plabel, extra = {}) => ({
  report,
  line,
  stmt,
  inpth: 0,
  tag,
  version: 'us-gaap/2021',
  plabel,
  negating: 0,
  ...extra,
});

const NUM = [
  num('Assets', '20211231', 0, 1000),
  num('Assets', '20201231', 0, 900),
  num('Liabilities', '20211231', 0, 400),
  num('StockholdersEquity', '20211231', 0, 600),
  num('CashAndCashEquivalentsAtCarryingValue', '20211231', 0, 100),
  num('CashAndCashEquivalentsAtCarryingValue', '20201231', 0, 80),
  num('Revenues', '20211231', 4, 500),
  num('NetIncomeLoss', '20211231', 4, 50),
  num('EarningsPerShareDiluted', '20211231', 4, 0.5),
  num('NetCashProvidedByUsedInOperatingActivities', '20211231', 4, 120),
  // a co-registrant's own balance sheet: not this filer's number
  num('Assets', '20211231', 0, 7, { coreg: 'SUBSIDIARY' }),
];
const PRE = [
  pre(2, 1, 'IS', 'Revenues', 'Net sales'),
  pre(2, 2, 'IS', 'NetIncomeLoss', 'Net income'),
  pre(2, 3, 'IS', 'EarningsPerShareDiluted', 'Diluted (in dollars per share)'),
  pre(3, 1, 'BS', 'Assets', 'Total assets'),
  pre(3, 2, 'BS', 'Liabilities', 'Total liabilities'),
  pre(3, 3, 'BS', 'StockholdersEquity', "Total stockholders' equity"),
  pre(3, 4, 'BS', 'CashAndCashEquivalentsAtCarryingValue', 'Cash and cash equivalents'),
  pre(4, 1, 'CF', 'NetCashProvidedByUsedInOperatingActivities', 'Net cash provided by operating activities'),
  pre(4, 2, 'CF', 'CashAndCashEquivalentsAtCarryingValue', 'Cash at beginning of period'),
  pre(4, 3, 'CF', 'CashAndCashEquivalentsAtCarryingValue', 'Cash at end of period'),
];

const build = (over = {}) =>
  deraResult({
    filing: FILING,
    sub: SUB,
    pre: PRE,
    num: NUM,
    tagOf,
    snap: dateSnapper(['2021-12-28', '2020-12-29']),
    dataset: '2022q1',
    fetchedAt: '2026-09-23T00:00:00.000Z',
    ...over,
  });

test('a filing comes out in the shape the store saves and the app reads', () => {
  const r = build();
  assert.equal(r.source, 'dera');
  assert.equal(r.dataset, '2022q1');
  // the header is EDGAR's, not the dataset's
  assert.equal(r.filing.periodEnd, '2021-12-28');
  assert.equal(r.filing.form, '10-K');
  assert.equal(r.filing.accession, '0000000000-22-000001');
  assert.equal(r.filing.companyName, 'TEST CO');
  assert.deepEqual(
    r.allStatements.map((s) => s.type),
    ['income_statement', 'balance_sheet', 'cash_flow'],
  );
  assert.ok(r.statements.balance_sheet && r.statements.income_statement && r.statements.cash_flow);
  assert.equal(r.statements.equity, null);
  assert.equal(r.stats.statementRoles, 3);
});

test('the titles survive reclassify(), which re-runs the classifier on every load', () => {
  const r = reclassify(build());
  assert.deepEqual(
    r.allStatements.map((s) => s.type),
    ['income_statement', 'balance_sheet', 'cash_flow'],
  );
});

test("dates: the period end is EDGAR's, and a duration starts the day after the period before", () => {
  const r = build();
  const bs = r.statements.balance_sheet;
  assert.deepEqual(
    bs.columns.map((c) => c.period.instant),
    ['2021-12-28', '2020-12-29'],
    'newest first, both snapped',
  );
  const is = r.statements.income_statement;
  assert.deepEqual(
    is.columns.map((c) => c.period),
    [{ start: '2020-12-30', end: '2021-12-28' }],
    'the year after the previous year end',
  );
});

test("a co-registrant's numbers are left out", () => {
  const bs = build().statements.balance_sheet;
  const assets = bs.lineItems.find((li) => li.concept === 'us-gaap:Assets');
  assert.deepEqual(
    Object.values(assets.values)
      .map((v) => v.value)
      .sort((a, b) => b - a),
    [1000, 900],
  );
});

test('units come from the datatype, so per-share amounts are not treated as money', () => {
  const is = build().statements.income_statement;
  const eps = is.lineItems.find((li) => li.concept === 'us-gaap:EarningsPerShareDiluted');
  assert.equal(Object.values(eps.values)[0].unit, 'USD/shares');
  assert.equal(Object.values(is.lineItems.find((li) => li.concept === 'us-gaap:Revenues').values)[0].unit, 'USD');
});

test("the filer's label is the row label, SEC's is kept beside it", () => {
  const bs = build().statements.balance_sheet;
  const assets = bs.lineItems.find((li) => li.concept === 'us-gaap:Assets');
  assert.equal(assets.label, 'Total assets');
  assert.equal(assets.labelStandard, 'Assets (standard)');
  assert.equal(assets.documentation, 'what Assets means');
  assert.equal(assets.depth, 0, 'the datasets carry no headings, so nothing is indented');
  assert.equal(assets.abstract, false);
});

test('the cash roll-forward keeps one instant on each of its two rows', () => {
  const cf = build().statements.cash_flow;
  const rows = cf.lineItems.filter((li) => li.concept === 'us-gaap:CashAndCashEquivalentsAtCarryingValue');
  assert.equal(rows.length, 2);
  const at = (li) => Object.keys(li.values).map((id) => cf.columns.find((c) => c.id === id)?.period.instant);
  assert.deepEqual(at(rows[0]), ['2020-12-29'], 'beginning of period: the day before the year starts');
  assert.deepEqual(at(rows[1]), ['2021-12-28'], 'end of period');
});

test('the rebuild scores like any other saved filing', () => {
  const s = scoreFiling(build());
  assert.equal(s.basis.kind, 'annual');
  assert.equal(s.values.totalAssets, 1000);
  assert.equal(s.values.revenueAnn, 500);
  assert.equal(s.values.ocfAnn, 120);
  assert.equal(s.values.netMargin, 10);
  assert.ok(s.coverage > 0);
});

test('a convenience translation does not overwrite the currency the filer reports in', () => {
  // a foreign private issuer restates its latest year in USD beside its own
  // currency: the same rows, the same period, and nowhere to put the second
  const num = [
    ...NUM.map((r) => ({ ...r, uom: 'CNY' })),
    {
      tag: 'Assets',
      version: 'us-gaap/2021',
      ddate: '20211231',
      qtrs: 0,
      uom: 'USD',
      segments: '',
      coreg: '',
      value: '157',
    },
    {
      tag: 'Revenues',
      version: 'us-gaap/2021',
      ddate: '20211231',
      qtrs: 4,
      uom: 'USD',
      segments: '',
      coreg: '',
      value: '78',
    },
    {
      tag: 'EarningsPerShareDiluted',
      version: 'us-gaap/2021',
      ddate: '20211231',
      qtrs: 4,
      uom: 'USD',
      segments: '',
      coreg: '',
      value: '0.08',
    },
  ];
  assert.equal(mainCurrency(num, tagOf), 'CNY');
  const r = build({ num });
  const value = (st, concept) => Object.values(r.statements[st].lineItems.find((li) => li.concept === concept).values)[0].value;
  assert.equal(value('balance_sheet', 'us-gaap:Assets'), 1000);
  assert.equal(value('income_statement', 'us-gaap:Revenues'), 500);
  // a per-share amount carries a currency too, so the same rule holds
  assert.equal(value('income_statement', 'us-gaap:EarningsPerShareDiluted'), 0.5);
});

test('a submission the dataset presents no statement for is nothing to save', () => {
  assert.equal(build({ pre: PRE.map((p) => ({ ...p, stmt: 'UN' })) }), null, 'the notes alone are not a filing');
  assert.equal(build({ num: [] }), null, 'no numbers, no statement');
});
