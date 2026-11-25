import test from 'node:test';
import assert from 'node:assert/strict';
import { cellNumber, namesCompany, periodIn, prospectusResults, unitsIn } from '../server/lib/prospectus.ts';
import { collapseAmendments, edgarAccession, filingUrls, fiscalLabel, newestFirst, periodAccession, pickFiling, reportsQuarterly } from '../server/lib/filings.ts';
import { normLabel, sectionOf } from '../server/lib/rowLabels.ts';
import { trimSubmissions } from '../server/lib/edgar.ts';
import { scoreFilingOf } from '../server/lib/scoreModel.ts';
import { currentView } from '../server/lib/current.ts';
import type { Company, FilingRef, ScrapeResult, Statement } from '../server/lib/types.ts';

// ---- the pieces ----

test('what a cell says: negatives in parentheses, dashes, currencies, no labels', () => {
  assert.equal(cellNumber('$ 7,752'), 7752);
  assert.equal(cellNumber('(1,531'), -1531, 'the closing parenthesis has a cell of its own');
  assert.equal(cellNumber('$ (50.10)'), -50.1);
  assert.equal(cellNumber('—'), 0);
  assert.equal(cellNumber('1 234 567'), 1234567, 'thousands set apart by spaces');
  assert.equal(cellNumber('12%'), undefined);
  assert.equal(cellNumber('4,24,31'), undefined, 'a list of notes');
  assert.equal(cellNumber('Class A'), undefined);
});

test('what a column covers, from the headings above it', () => {
  assert.deepEqual(periodIn('As of December 31, 2025', '', true), { instant: '2025-12-31' });
  assert.deepEqual(periodIn('Year Ended December 31, 2025', '', false), { start: '2025-01-01', end: '2025-12-31' });
  assert.deepEqual(periodIn('Nine Months Ended September 30, 2026 (unaudited)', '', false), { start: '2026-01-01', end: '2026-09-30' });
  assert.deepEqual(periodIn('Period from March 5, 2024 (inception) through December 31, 2024', '', false), { start: '2024-03-05', end: '2024-12-31' });
  assert.deepEqual(periodIn('31 March 2026', 'for the years ended', false), { start: '2025-04-01', end: '2026-03-31' });
  // a heading that is only a year: the statement says the rest
  assert.deepEqual(periodIn('2025', 'For the years ended December 31, 2025 and 2024', false), { start: '2025-01-01', end: '2025-12-31' });
  // a 52/53-week year named by its number alone: the balance sheet had the date
  assert.deepEqual(periodIn('Fiscal Years Ended 2022', '', false, ['2023-12-31', '2023-01-01'])!.end, '2023-01-01');
  // two headings over one column: its own has the year
  assert.deepEqual(periodIn('As of December 31, As of March 31, 2025', '', true), { instant: '2025-03-31' });
  for (const h of ['Pro Forma September 30, 2026', 'As Adjusted 2026', '% Change', 'Notes']) assert.equal(periodIn(h, 'As of December 31, 2025', true), null, h);
});

test('units: shares go by the money unless the line excepts them', () => {
  const u = (s: string) => unitsIn([s]);
  assert.deepEqual([u('(In thousands)').money, u('(In thousands)').shares], [1e3, 1e3]);
  assert.equal(u('(in thousands, except per share amounts)').shares, 1e3);
  assert.equal(u('(in thousands, except share and per share data)').shares, 1);
  const own = u('(In millions, except share amounts which are in thousands, and per share data)');
  assert.deepEqual([own.money, own.shares], [1e6, 1e3]);
  assert.equal(u('(Amounts in thousands of Renminbi (“RMB”))').currency, 'CNY');
  assert.equal(u('Thousands, except share counts').money, 1e3);
  assert.equal(unitsIn(['ACME, INC.']).given, false);
});

test('a label is looked up without its footnotes, notes and par value, in its section', () => {
  assert.equal(normLabel('Cost of revenue(1)'), 'cost of revenue');
  assert.equal(normLabel('Commitments and contingencies (Note 13)'), 'commitments and contingencies');
  assert.equal(normLabel('Class A common stock, $0.00001 par value; 6,319,705 shares authorized'), 'class a common stock');
  assert.deepEqual(sectionOf('balance_sheet', 'cl', 'total current liabilities'), ['cl', 'ncl']);
  assert.deepEqual(sectionOf('income_statement', 'is', 'net loss per share attributable to common stockholders basic and diluted')[0], 'eps');
  assert.deepEqual(sectionOf('income_statement', 'eps', 'weighted average shares used to compute net loss per share basic and diluted')[0], 'sh');
});

test('whose statements they are', () => {
  assert.ok(namesCompany(['F-5', 'Anthropic, PBC'], 'Anthropic, PBC'));
  assert.ok(namesCompany(['ACME WIDGETS, INC. AND SUBSIDIARIES'], 'Acme Widgets Inc'));
  assert.ok(!namesCompany(['Target Business LLC'], 'Acme Widgets Inc'));
});

// ---- a prospectus ----

type Cells = (string | [string, number])[];
const row = (...cells: Cells) => `<tr>${cells.map((c) => (Array.isArray(c) ? `<td colspan="${c[1]}">${c[0]}</td>` : `<td>${c}</td>`)).join('')}</tr>`;
const table = (...rows: string[]) => `<table>${rows.join('')}</table>`;
// '$' and the number in cells of their own, as most filer agents set them
const line = (label: string, ...values: string[]) => row(label, ...values.flatMap((v) => ['$', v] as Cells));

const BALANCE = [
  row('', ['As of December 31,', 4], ['As of<br>September 30,', 2]),
  row('', ['2024', 2], ['2025', 2], ['2026', 2]),
  row('Current assets:'),
  line('Cash and cash equivalents', '100', '200', '300'),
  line('Accounts receivable, net', '10', '20', '30'),
  line('Total current assets', '110', '220', '330'),
  line('Property and equipment, net', '40', '60', '90'),
  line('Total assets', '150', '280', '420'),
  row('Liabilities, Convertible Preferred Stock and Stockholders’ Deficit'),
  row('Current liabilities:'),
  line('Accounts payable', '30', '40', '50'),
  line('Deferred revenue', '5', '10', '15'),
  line('Total current liabilities', '35', '50', '65'),
  line('Deferred revenue', '5', '5', '5'),
  line('Total liabilities', '40', '55', '70'),
  line('Redeemable convertible preferred stock, $0.0001 par value; 10 shares authorized', '300', '500', '800'),
  row('Stockholders’ deficit:'),
  line('Class A common stock, $0.0001 par value; 5 shares authorized', '—', '—', '—'),
  line('Class B common stock, $0.0001 par value; 5 shares authorized', '—', '—', '—'),
  line('Accumulated deficit', '(190)', '(275)', '(450)'),
  line('Total stockholders’ deficit', '(190)', '(275)', '(450)'),
  line('Total liabilities, redeemable convertible preferred stock and stockholders’ deficit', '150', '280', '420'),
];
const HEAD = [row('', ['Year Ended December 31,', 4], ['Nine Months Ended September 30,', 4]), row('', ['2024', 2], ['2025', 2], ['2025', 2], ['2026', 2])];
const INCOME = [
  ...HEAD,
  line('Revenue', '100', '200', '140', '330'),
  line('Cost of revenue(1)', '60', '110', '80', '160'),
  line('Gross profit', '40', '90', '60', '170'),
  row('Operating expenses:'),
  line('Research and development', '70', '120', '90', '200'),
  line('Total operating expenses', '70', '120', '90', '200'),
  line('Loss from operations', '(30)', '(30)', '(30)', '(30)'),
  line('Brand new thing nobody tags', '(50)', '(53)', '(30)', '(143)'),
  line('Loss before provision for income taxes', '(80)', '(83)', '(60)', '(173)'),
  line('Provision for income taxes', '1', '2', '1', '2'),
  line('Net loss', '(81)', '(85)', '(61)', '(175)'),
  line('Net loss per share, basic and diluted', '(8.10)', '(8.50)', '(6.10)', '(17.50)'),
  line('Weighted-average shares used to compute net loss per share, basic and diluted', '10,000', '10,000', '10,000', '10,000'),
];
const CASH = [
  ...HEAD,
  row('Cash flows from operating activities:'),
  line('Net loss', '(81)', '(85)', '(61)', '(175)'),
  line('Accounts receivable, net', '(4)', '(10)', '(5)', '(10)'),
  line('Net cash used in operating activities', '(85)', '(95)', '(66)', '(185)'),
  row('Cash flows from investing activities:'),
  line('Purchases of property and equipment', '(15)', '(5)', '(4)', '(15)'),
  line('Net cash used in investing activities', '(15)', '(5)', '(4)', '(15)'),
  row('Cash flows from financing activities:'),
  line('Proceeds from issuance of redeemable convertible preferred stock', '150', '200', '90', '300'),
  line('Net cash provided by financing activities', '150', '200', '90', '300'),
  line('Net increase in cash and cash equivalents', '50', '100', '20', '100'),
  line('Cash and cash equivalents at beginning of period', '50', '100', '100', '200'),
  line('Cash and cash equivalents at end of period', '100', '200', '120', '300'),
];

interface Parts {
  name?: string;
  balance?: string[];
  income?: string[];
  cash?: string[];
}
const statements = ({ name = 'Acme Widgets, Inc.', balance = BALANCE, income = INCOME, cash = CASH }: Parts = {}) => `
<p>${name}</p><p><a name="b1"></a>C<a href="#x"></a>onsolidated Balance Sheets</p><p>(In thousands, except per share amounts)</p>${table(...balance)}
<p>The accompanying notes are an integral part of these consolidated financial statements.</p>
<p>${name}</p><p>Consolidated Statements of Operations</p><p>(In thousands, except per share amounts)</p>${table(...income)}
${table(row('(1) Includes stock-based compensation:'), line('Cost of revenue', '1', '2', '3', '4'), line('Research and development', '1', '2', '3', '4'))}
<p>${name}</p><p>Consolidated Statements of Cash Flows</p><p>(In thousands)</p>${table(...cash)}
<p>Notes to Consolidated Financial Statements</p>
${table(...HEAD, line('Revenue', '1', '2', '3', '4'), line('Net loss', '(9)', '(9)', '(9)', '(9)'))}`;
// what stands before the real pages and must not be read: the summary data
const prospectus = (...sets: string[]) => `<html><body>
<p>Summary Consolidated Financial Data</p><p>Consolidated Statements of Operations Data</p>${table(...HEAD, line('Revenue', '7', '7', '7', '7'), line('Net loss', '(7)', '(7)', '(7)', '(7)'))}
<p>INDEX TO CONSOLIDATED FINANCIAL STATEMENTS</p>${table(row('Consolidated Balance Sheets', 'F-3'))}
<p>Opinion on the Financial Statements</p><p>We have audited the accompanying consolidated balance sheets.</p>
${sets.join('\n')}</body></html>`;

const FILING = { cik: 1, accession: '0000000001-26-000001', form: '424B4', filingDate: '2026-11-19', primaryDocument: 'acme-424b4.htm' };
const COMPANY = { name: 'Acme Widgets, Inc.', tickers: ['ACME'], fiscalYearEnd: '1231' };
const read = (html: string, filing = FILING, opts = {}) => prospectusResults(html, filing, COMPANY, opts);
const value = (st: Statement | null, concept: string, column: string) => st!.lineItems.find((li) => li.concept === concept)?.values[column]?.value;

test('each period with a balance sheet is a filing of its own, newest first', () => {
  const r = read(prospectus(statements()));
  assert.deepEqual(r.map((x) => [x.filing.fiscalPeriod, x.filing.fiscalYear, x.filing.periodEnd]), [['Q3', '2026', '2026-09-30'], ['FY', '2025', '2025-12-31'], ['FY', '2024', '2024-12-31']]);
  // the newest goes by EDGAR's accession, so the document counts as saved
  assert.deepEqual(r.map((x) => x.filing.accession), ['0000000001-26-000001', '0000000001-26-000001.20251231', '0000000001-26-000001.20241231']);
  for (const x of r) {
    assert.equal(x.filing.source, 'prospectus');
    assert.equal(x.filing.form, '424B4');
    assert.match(x.filing.viewerUrl!, /Archives\/edgar\/data\/1\/000000000126000001\/acme-424b4\.htm$/, 'not the iXBRL viewer, and no period in the path');
  }
  // the columns a 10-Q, and a 10-K, of that date would show
  assert.deepEqual(r[0]!.statements.income_statement!.columns.map((c) => c.period), [{ start: '2026-01-01', end: '2026-09-30' }, { start: '2025-01-01', end: '2025-09-30' }]);
  assert.deepEqual(r[1]!.statements.income_statement!.columns.map((c) => c.period.end), ['2025-12-31', '2024-12-31']);
  assert.deepEqual(r[2]!.statements.balance_sheet!.columns.map((c) => c.period.instant), ['2024-12-31']);
});

test('numbers come out raw: scaled, signed as XBRL has them, the footnote table left out', () => {
  const [q, fy] = read(prospectus(statements())) as [ScrapeResult, ScrapeResult];
  const { balance_sheet: bs, income_statement: is, cash_flow: cf } = q.statements;
  assert.equal(value(bs, 'us-gaap:Assets', 'i20260930'), 420_000);
  assert.equal(value(bs, 'us-gaap:StockholdersEquity', 'i20260930'), -450_000);
  assert.equal(value(bs, 'us-gaap:LiabilitiesAndStockholdersEquity', 'i20260930'), 420_000);
  // one label, two sections
  assert.equal(value(bs, 'us-gaap:ContractWithCustomerLiabilityCurrent', 'i20260930'), 15_000);
  assert.equal(value(bs, 'us-gaap:ContractWithCustomerLiabilityNoncurrent', 'i20260930'), 5_000);
  assert.equal(value(is, 'us-gaap:CostOfRevenue', 'd20260101_20260930'), 160_000, 'the statement’s line, not the footnote’s');
  assert.equal(value(is, 'us-gaap:NetIncomeLoss', 'd20260101_20260930'), -175_000);
  assert.equal(value(is, 'acme:BrandNewThingNobodyTags', 'd20260101_20260930'), -143_000, 'an extension of the filer’s own');
  const eps = is!.lineItems.find((li) => /per share/i.test(li.label!) && !/weighted/i.test(li.label!))!;
  assert.deepEqual([eps.values.d20260101_20260930!.value, eps.values.d20260101_20260930!.unit], [-17.5, 'USD/shares'], 'a per-share amount is not in thousands');
  const shares = is!.lineItems.find((li) => /^weighted/i.test(li.label!))!;
  assert.deepEqual([shares.values.d20260101_20260930!.value, shares.values.d20260101_20260930!.unit], [10_000, 'shares'], 'printed in full, whatever the units line leaves open: 175,000 / 17.50');
  // a payment is positive and shown subtracted
  const capex = cf!.lineItems.find((li) => li.concept === 'us-gaap:PaymentsToAcquirePropertyPlantAndEquipment')!;
  assert.deepEqual([capex.values.d20260101_20260930!.value, capex.negated], [15_000, true]);
  const ar = cf!.lineItems.find((li) => li.concept === 'us-gaap:IncreaseDecreaseInAccountsReceivable')!;
  assert.deepEqual([ar.values.d20260101_20260930!.value, ar.negated], [10_000, true]);
  // the balances a cash flow opens and closes with
  const open = cf!.lineItems.find((li) => li.preferredLabel === 'periodStartLabel')!;
  const close = cf!.lineItems.find((li) => li.preferredLabel === 'periodEndLabel')!;
  assert.equal(open.values.i20251231!.value, 200_000);
  assert.equal(close.values.i20260930!.value, 300_000);
  assert.equal(value(fy.statements.income_statement, 'us-gaap:NetIncomeLoss', 'd20250101_20251231'), -85_000);
});

test('a statement that does not add up is not used', () => {
  const broken = BALANCE.map((r) => r.replace('>420<', '>421<').replace('>280<', '>280<'));
  broken[7] = line('Total assets', '150', '280', '999');
  const r = read(prospectus(statements({ balance: broken })));
  assert.deepEqual(r.map((x) => x.filing.periodEnd), ['2025-12-31', '2024-12-31'], 'the September column does not balance');

  const cash = [...CASH];
  cash[cash.length - 3] = line('Net increase in cash and cash equivalents', '50', '100', '20', '777');
  cash[cash.length - 1] = line('Cash and cash equivalents at end of period', '100', '200', '120', '977');
  const [q, fy] = read(prospectus(statements({ cash }))) as [ScrapeResult, ScrapeResult];
  assert.equal(q.statements.cash_flow, null, 'its parts do not sum to its change');
  assert.ok(fy.statements.cash_flow);

  const income = INCOME.map((x) => (x.includes('>Net loss<') ? line('Net loss', '(81)', '(85)', '(61)', '(111)') : x));
  assert.deepEqual(read(prospectus(statements({ income }))).map((x) => x.filing.periodEnd), ['2025-12-31', '2024-12-31'], 'the cash flow starts from another net loss');
});

test('losses printed as plain numbers take their sign from the cash flow', () => {
  const plain = INCOME.map((x) => (/>(?:Net loss|Loss)/.test(x) ? x.replace(/\(([\d.,]+)\)/g, '$1') : x));
  const [q] = read(prospectus(statements({ income: plain })));
  assert.equal(value(q!.statements.income_statement, 'us-gaap:NetIncomeLoss', 'd20260101_20260930'), -175_000);
  assert.equal(q!.statements.income_statement!.lineItems.find((li) => li.concept === 'us-gaap:NetIncomeLoss')!.negated, true, 'and is shown as printed');
});

test('a pro forma column is not a period, with or without the words', () => {
  const pf = BALANCE.map((r, i) => (i === 0 ? row('', ['As of December 31,', 4], ['As of September 30,', 2], ['Pro Forma<br>September 30,', 2]) : i === 1 ? row('', ['2024', 2], ['2025', 2], ['2026', 2], ['2026', 2]) : /<td>\$<\/td>/.test(r) ? r.replace('</tr>', '<td>$</td><td>420</td></tr>') : r));
  assert.deepEqual(read(prospectus(statements({ balance: pf })))[0]!.statements.balance_sheet!.columns.map((c) => c.period.instant), ['2026-09-30', '2025-12-31', '2024-12-31']);
});

test('another company’s statements in the same pages are not mixed in', () => {
  const other = statements({ name: 'Target Business LLC' }).replace(/>420</g, '>421<').replace(/>\(175\)</g, '>(176)<');
  const r = read(prospectus(other, statements()));
  assert.equal(value(r[0]!.statements.balance_sheet, 'us-gaap:Assets', 'i20260930'), 420_000);
  // a merger's prospectus has to name the company at all
  assert.deepEqual(read(prospectus(other), FILING, { ownOnly: true }), []);
});

test('nothing in it that can be read: no filings', () => {
  assert.deepEqual(read('<html><body><p>Incorporated by reference.</p></body></html>'), []);
});

// ---- and in the rest of the app ----

const ref = (accession: string, form: string, reportDate: string, filingDate: string): FilingRef => ({ accession, form, reportDate, periodEnd: reportDate, filingDate, ...fiscalLabel(form, reportDate, '1231') });

test('a prospectus is labelled by its date, and is no quarterly report', () => {
  assert.deepEqual(fiscalLabel('424B4', '2026-09-30', '1231'), { fiscalYear: 2026, fiscalPeriod: 'Q3' });
  assert.deepEqual(fiscalLabel('S-1/A', '2025-12-31', '1231'), { fiscalYear: 2025, fiscalPeriod: 'FY' });
  assert.deepEqual(fiscalLabel('10-K', '2026-09-30', '0930'), { fiscalYear: 2026, fiscalPeriod: 'FY' });
  assert.deepEqual(fiscalLabel('424B4', '2026-09-30', '0930'), { fiscalYear: 2026, fiscalPeriod: 'FY' });
  const young = [ref('p', '424B4', '2026-09-30', '2026-11-19'), ref('p.1', '424B4', '2025-12-31', '2026-11-19')];
  assert.equal(reportsQuarterly(young), false);
  assert.equal(reportsQuarterly([...young, ref('q', '10-Q', '2027-03-31', '2027-05-10')]), true);
  assert.equal(edgarAccession(periodAccession('0000000001-26-000001', '2025-12-31')), '0000000001-26-000001');
  assert.equal(filingUrls(1, '0000000001-26-000001', 'x.htm').viewerUrl, 'https://www.sec.gov/ix?doc=/Archives/edgar/data/1/000000000126000001/x.htm');
});

test('the 10-K or 10-Q of a period takes the place of the prospectus', () => {
  const list = [ref('k', '10-K', '2025-12-31', '2027-02-20'), ref('p', '424B4', '2026-09-30', '2026-11-19'), ref('p.1', '424B4', '2025-12-31', '2026-11-19'), ref('s', 'S-1/A', '2026-09-30', '2026-11-02')];
  assert.deepEqual(collapseAmendments(list).map((f) => f.accession), ['k', 'p'], 'and the final prospectus that of its drafts');
  assert.equal(pickFiling(list, { year: 2025, period: 'FY' })!.accession, 'k');
  assert.equal(pickFiling(list, { year: 2026, period: 'Q3' })!.accession, 'p');
  assert.deepEqual([list[2]!, list[1]!].sort(newestFirst).map((f) => f.accession), ['p', 'p.1'], 'one filing date: the newest period first');
});

test('EDGAR’s list keeps the prospectus only of a company with nothing else to read', () => {
  const sub = (forms: string[], inline: number[]) => ({
    filings: { recent: { form: forms, accessionNumber: forms.map((_, i) => String(i)), filingDate: forms.map(() => '2026-11-19'), reportDate: forms.map(() => null), primaryDocument: forms.map(() => 'x.htm'), isInlineXBRL: inline }, files: [] },
  });
  // the S-1's flag is the filing-fee exhibit's: it makes no difference
  assert.deepEqual(trimSubmissions(sub(['4', '424B4', 'S-1', '8-A12B'], [0, 0, 1, 0])).filings!.recent.form, ['424B4', 'S-1']);
  assert.deepEqual(trimSubmissions(sub(['10-Q', '424B4', 'S-1'], [1, 0, 1])).filings!.recent.form, ['10-Q']);
  assert.deepEqual(trimSubmissions(sub(['20-F', '424B3', 'F-4'], [0, 0, 0])).filings!.recent.form, ['20-F', '424B3', 'F-4'], 'a shell report with no tags is not something to read');
});

test('scores and the current-period view work from what a prospectus has', async () => {
  const results = read(prospectus(statements()));
  const company: Company = { cik: 1, filings: results.map((r) => ({ ...ref(r.filing.accession, r.filing.form!, r.filing.periodEnd!, r.filing.filingDate!), cik: 1 })) };
  const load = async (f: FilingRef) => results.find((r) => r.filing.accession === f.accession)!;
  const [q, fy] = await Promise.all(company.filings.slice(0, 2).map((f) => scoreFilingOf(load, company, f)));
  assert.deepEqual([q!.basis.kind, q!.basis.monthsLen], ['ytd', 9]);
  assert.deepEqual([fy!.basis.kind, fy!.values.grossMargin], ['annual', 45]);
  assert.ok(q!.coverage >= 50);
  const view = currentView(results[0]!, company.filings[0]!, null);
  assert.ok(view.notes!.some((n) => n.code === 'ytdOnly'), 'nine months are shown as year to date');
  const whole = currentView(results[1]!, company.filings[1]!, null);
  assert.equal(whole.statements.income_statement!.columns.length, 1);
});
