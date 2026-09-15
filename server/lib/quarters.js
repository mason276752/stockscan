// Quarterly view for one fiscal year: Q1, Q2, Q3 from the 10-Qs, FY from the
// 10-K, and Q4 derived as FY − Q1 − Q2 − Q3 (equivalently FY − nine-month YTD).
//
// 10-Q flow statements report either three-month columns, year-to-date
// columns or both; cash flow statements are usually YTD only. So each quarter
// is computed from cumulative amounts: C1..C3 come from the 10-Qs (YTD column
// if present, otherwise previous cumulative + three-month column), C4 is the
// 10-K, and Qn = Cn − Cn−1. Balance sheets are point-in-time, so their
// quarterly columns are simply the period-end balances of each filing.

import { pickFiling } from './edgar.js';
import { scrapeFiling } from './scrape.js';

const QUARTERS = ['Q1', 'Q2', 'Q3'];
const TYPES = ['balance_sheet', 'income_statement', 'comprehensive_income', 'cash_flow'];
const DAY = 86400000;

const dimKey = (dims) =>
  Object.entries(dims)
    .sort()
    .map(([k, v]) => `${k}=${v}`)
    .join('|');
const near = (a, b, days = 4) => !!a && !!b && Math.abs(new Date(a) - new Date(b)) <= days * DAY;
const months = (start, end) => Math.round((new Date(end) - new Date(start)) / DAY / 30.4375);

// currency amounts subtract exactly; per-share amounts only approximately
// (weighted shares differ by period); share counts and ratios not at all.
function subtractability(unit) {
  if (!unit) return 'none';
  if (unit.includes('/')) return 'approx';
  if (unit === 'shares' || unit === 'pure') return 'none';
  return 'exact';
}

function statementOf(data, type) {
  if (!data) return null;
  if (type === 'comprehensive_income') return data.allStatements.find((s) => s.type === type && !s.parenthetical) || null;
  return data.statements[type];
}

function findColumn(stmt, { dims, instant, end, start, monthsLen }) {
  if (!stmt) return null;
  return (
    stmt.columns.find((c) => {
      if (dimKey(c.dimensions) !== dims) return false;
      if (instant) return !!c.period.instant && near(c.period.instant, instant);
      if (!c.period.end || !near(c.period.end, end)) return false;
      if (start) return near(c.period.start, start);
      if (monthsLen) return months(c.period.start, c.period.end) === monthsLen;
      return true;
    }) || null
  );
}

// Filers occasionally switch concepts between filings (e.g. Alphabet moved
// from RevenueFromContractWithCustomerExcludingAssessedTax to Revenues in
// 2025), so fall back on the row label and a few known synonyms.
const SYNONYMS = [
  ['us-gaap:Revenues', 'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax', 'us-gaap:SalesRevenueNet'],
  ['us-gaap:CostOfRevenue', 'us-gaap:CostOfGoodsAndServicesSold'],
  ['us-gaap:PropertyPlantAndEquipmentNet', 'us-gaap:PropertyPlantAndEquipmentAndFinanceLeaseRightOfUseAssetAfterAccumulatedDepreciationAndAmortization'],
].reduce((m, group) => {
  for (const c of group) m[c] = group;
  return m;
}, {});
const normLabel = (l) => (l || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function findRow(stmt, fyRow) {
  const rows = stmt.lineItems.filter((li) => !li.abstract);
  return (
    rows.find((li) => li.concept === fyRow.concept) ||
    rows.find((li) => normLabel(li.label) === normLabel(fyRow.label)) ||
    rows.find((li) => (SYNONYMS[fyRow.concept] || []).includes(li.concept)) ||
    null
  );
}

function valueOf(stmt, fyRow, colId) {
  if (!stmt || !colId) return undefined;
  const row = findRow(stmt, fyRow);
  const cell = row?.values[colId];
  return cell && typeof cell.value === 'number' ? cell : undefined;
}

function buildStatementQuarters(type, docs, filings) {
  const fy = statementOf(docs.FY, type);
  if (!fy) return null;
  const fyEnd = filings.FY.reportDate;
  const isInstant = type === 'balance_sheet';

  // Current-year columns of the 10-K, grouped by dimension.
  let fyStart = null;
  const groups = [];
  for (const c of fy.columns) {
    if (isInstant) {
      if (c.period.instant && near(c.period.instant, fyEnd)) groups.push({ dims: dimKey(c.dimensions), dimensions: c.dimensions, fyCol: c.id });
    } else if (c.period.end && near(c.period.end, fyEnd) && months(c.period.start, c.period.end) === 12) {
      fyStart ||= c.period.start;
      groups.push({ dims: dimKey(c.dimensions), dimensions: c.dimensions, fyCol: c.id });
    }
  }
  if (!groups.length) return null;

  const columns = [];
  const lineItems = fy.lineItems.map((li) => ({
    concept: li.concept,
    label: li.label,
    labelStandard: li.labelStandard,
    labelZh: li.labelZh,
    descriptionZh: li.descriptionZh,
    documentation: li.documentation,
    preferredLabel: li.preferredLabel,
    negated: li.negated,
    depth: li.depth,
    abstract: li.abstract,
    values: {},
  }));

  for (const g of groups) {
    const sfx = g.dims ? `|${g.dims}` : '';
    const qStmts = QUARTERS.map((q) => statementOf(docs[q], type));
    const qCols = QUARTERS.map((q, i) => {
      const end = filings[q].reportDate;
      const stmt = qStmts[i];
      if (isInstant) return { direct: findColumn(stmt, { dims: g.dims, instant: end }), end };
      return {
        ytd: findColumn(stmt, { dims: g.dims, end, start: fyStart }),
        three: findColumn(stmt, { dims: g.dims, end, monthsLen: 3 }),
        end,
      };
    });

    if (isInstant) {
      qCols.forEach((qc, i) =>
        columns.push({
          id: `q${i + 1}${sfx}`,
          label: QUARTERS[i],
          period: { instant: qc.end },
          dimensions: g.dimensions,
          derived: false,
          source: filings[QUARTERS[i]].accession,
        }),
      );
      columns.push({ id: `q4${sfx}`, label: 'Q4', period: { instant: fyEnd }, dimensions: g.dimensions, derived: false, source: filings.FY.accession });
    } else {
      qCols.forEach((qc, i) =>
        columns.push({
          id: `q${i + 1}${sfx}`,
          label: QUARTERS[i],
          period: { start: i === 0 ? fyStart : qCols[i - 1].end, end: qc.end },
          dimensions: g.dimensions,
          derived: i > 0, // may be computed from YTD differences
          source: filings[QUARTERS[i]].accession,
        }),
      );
      columns.push({ id: `q4${sfx}`, label: 'Q4', period: { start: qCols[2].end, end: fyEnd }, dimensions: g.dimensions, derived: true, source: filings.FY.accession });
      columns.push({ id: `fy${sfx}`, label: 'FY', period: { start: fyStart, end: fyEnd }, dimensions: g.dimensions, derived: false, source: filings.FY.accession });
    }

    for (const li of lineItems) {
      if (li.abstract) continue;
      const fyCell = valueOf(fy, li, g.fyCol);

      if (isInstant) {
        qCols.forEach((qc, i) => {
          const cell = valueOf(qStmts[i], li, qc.direct?.id);
          if (cell) li.values[`q${i + 1}${sfx}`] = { value: cell.value, unit: cell.unit, raw: cell.raw, factId: cell.factId };
        });
        if (fyCell) li.values[`q4${sfx}`] = { value: fyCell.value, unit: fyCell.unit, raw: fyCell.raw, factId: fyCell.factId };
        continue;
      }

      const unit = fyCell?.unit || valueOf(qStmts[0], li, qCols[0].ytd?.id || qCols[0].three?.id)?.unit;
      const mode = subtractability(unit);
      const cum = [0]; // cumulative amounts C0..C4 (undefined = unknown)
      const cellFor = (value, derived) => ({ value, unit, derived, ...(derived && mode === 'approx' ? { approx: true } : {}) });

      qCols.forEach((qc, i) => {
        const ytd = valueOf(qStmts[i], li, qc.ytd?.id);
        const three = valueOf(qStmts[i], li, qc.three?.id);
        const prev = cum[i];
        let c;
        if (ytd) c = ytd.value;
        else if (three && prev !== undefined && mode !== 'none') c = prev + three.value;
        else if (three && i === 0) c = three.value;
        cum[i + 1] = c;

        if (three) li.values[`q${i + 1}${sfx}`] = cellFor(three.value, false);
        else if (ytd && i === 0) li.values[`q1${sfx}`] = cellFor(ytd.value, false);
        else if (ytd && prev !== undefined && mode !== 'none') li.values[`q${i + 1}${sfx}`] = cellFor(ytd.value - prev, true);
      });

      if (fyCell) {
        li.values[`fy${sfx}`] = { value: fyCell.value, unit, raw: fyCell.raw, factId: fyCell.factId };
        if (cum[3] !== undefined && mode !== 'none') li.values[`q4${sfx}`] = cellFor(fyCell.value - cum[3], true);
      }
    }
  }

  return {
    type,
    title: fy.title,
    role: fy.role,
    parenthetical: false,
    axes: fy.axes,
    quarterly: true,
    columns,
    lineItems: lineItems.filter((li) => li.abstract || Object.keys(li.values).length),
  };
}

export async function buildQuarterly(client, company, year) {
  const filings = {};
  const missing = [];
  for (const p of [...QUARTERS, 'FY']) {
    filings[p] = pickFiling(company.filings, { year, period: p });
    if (!filings[p]) missing.push(p);
  }
  if (missing.length) {
    throw Object.assign(new Error(`FY${year} is missing ${missing.join(', ')} filings; cannot derive Q4.`), { status: 404 });
  }
  const docs = {};
  await Promise.all(
    Object.entries(filings).map(async ([p, f]) => {
      docs[p] = await scrapeFiling(client, f, company);
    }),
  );

  const statements = { balance_sheet: null, income_statement: null, cash_flow: null, equity: null };
  const all = [];
  for (const type of TYPES) {
    const st = buildStatementQuarters(type, docs, filings);
    if (!st) continue;
    all.push(st);
    if (type in statements) statements[type] = st;
  }

  return {
    fetchedAt: new Date().toISOString(),
    derived: true,
    filing: {
      cik: company.cik,
      companyName: company.name,
      form: 'Q4 推算',
      filingDate: filings.FY.filingDate,
      periodEnd: filings.FY.reportDate,
      fiscalYear: String(year),
      fiscalPeriod: 'Q4',
      accession: `q4-${year}`,
      viewerUrl: filings.FY.viewerUrl,
      indexUrl: filings.FY.indexUrl,
    },
    sources: Object.fromEntries(
      Object.entries(filings).map(([p, f]) => [p, { form: f.form, accession: f.accession, reportDate: f.reportDate, filingDate: f.filingDate, viewerUrl: f.viewerUrl }]),
    ),
    statements,
    allStatements: all,
    stats: { facts: Object.values(docs).reduce((n, d) => n + d.stats.facts, 0), contexts: 0, statementRoles: all.length },
  };
}
