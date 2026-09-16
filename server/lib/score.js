// A 0–100 score for one filing, from the indicator benchmarks.
//
// Five categories of 20 points, split evenly over their benchmark rows:
//   財務結構  負債佔資產比率、長期資金佔 PP&E 比率
//   償債能力  流動比率、速動比率
//   經營能力  平均收現日數、平均銷貨日數、做生意的完整週期、總資產週轉率
//   獲利能力  毛利率、營業利益率、淨利率、EPS、ROE
//   現金流量  現金流量比率、現金流量允當比率、現金再投資比率、現金佔總資產
// An item earns its full points when the benchmark is met, half when it is
// within 20% of the threshold, none otherwise; items the filing cannot
// answer are left out and the score is rescaled over what remains.
//
// Everything is taken from the one filing so the background crawl can score
// every company: balances at the period end (average with the comparative
// column), flows from the year-to-date column annualised (×12/months);
// cash-flow adequacy uses the same annualised year-to-date figures instead of
// five years.

import { C, ROWS, first, ratios } from './indicators.js';
import { balancesAt, costOfRevenueFromHeading, factsAt, months, noCostOfRevenue, statementOf } from './quarters.js';
import { store } from './store.js';
import { reclassify } from './statements.js';

export const SCORE_VERSION = 14;

const CATEGORY_OF = { debtRatio: '財務結構', ltCapToPpe: '財務結構', currentRatio: '償債能力', quickRatio: '償債能力', dso: '經營能力', dio: '經營能力', cycle: '經營能力', assetTurnover: '經營能力', grossMargin: '獲利能力', opMargin: '獲利能力', netMargin: '獲利能力', eps: '獲利能力', roe: '獲利能力', cfRatio: '現金流量', cfAdequacy: '現金流量', cfReinvest: '現金流量', cashPct: '現金流量' };
export const CATEGORIES = ['財務結構', '償債能力', '經營能力', '獲利能力', '現金流量'];

export const ITEMS = (() => {
  const rows = ROWS.filter((r) => r.benchmark && CATEGORY_OF[r.key]);
  const perCat = {};
  for (const r of rows) perCat[CATEGORY_OF[r.key]] = (perCat[CATEGORY_OF[r.key]] || 0) + 1;
  return rows.map((r) => ({ key: r.key, name: r.name, unit: r.unit, category: CATEGORY_OF[r.key], benchmark: r.benchmark, weight: 20 / perCat[CATEGORY_OF[r.key]] }));
})();

const OPS = { '>': (a, b) => a > b, '>=': (a, b) => a >= b, '<': (a, b) => a < b, '<=': (a, b) => a <= b };

// full / half / none for one value against its benchmark
function grade(value, { op, value: t }) {
  if (value == null || !Number.isFinite(value)) return null;
  if (OPS[op](value, t)) return 1;
  const near = t === 0 ? Math.abs(value) < 0.01 : Math.abs(value - t) <= Math.abs(t) * 0.2;
  return near ? 0.5 : 0;
}

export function scoreValues(values) {
  let earned = 0;
  let applicable = 0;
  const categories = {};
  const items = [];
  for (const it of ITEMS) {
    const v = values[it.key];
    const g = grade(v, it.benchmark);
    const cat = (categories[it.category] ||= { earned: 0, applicable: 0 });
    if (g != null) {
      earned += g * it.weight;
      applicable += it.weight;
      cat.earned += g * it.weight;
      cat.applicable += it.weight;
    }
    items.push({ key: it.key, name: it.name, unit: it.unit, category: it.category, value: v ?? null, benchmark: it.benchmark, grade: g, points: g == null ? null : Math.round(g * it.weight * 10) / 10, weight: it.weight });
  }
  // fewer than half the points answerable (banks, funds): no score rather than a misleading one
  const score = applicable >= 50 ? Math.round((earned / applicable) * 100) : null;
  return {
    score,
    earned: Math.round(earned * 10) / 10,
    applicable: Math.round(applicable),
    coverage: Math.round(applicable),
    categories: CATEGORIES.map((c) => ({ name: c, earned: Math.round((categories[c]?.earned || 0) * 10) / 10, applicable: categories[c]?.applicable || 0, score: categories[c]?.applicable ? Math.round(((categories[c].earned || 0) / categories[c].applicable) * 100) : null })),
    items,
  };
}

// Inputs for ratios() from a single parsed filing.
export function singleFilingInputs(data) {
  const end = data.filing?.periodEnd;
  if (!end) return null;
  const bs = statementOf(data, 'balance_sheet');
  const balances = balancesAt(data, end);
  // comparative column: the other undimensioned instant (usually the prior fiscal year end)
  const prevCol = bs?.columns.filter((c) => Object.keys(c.dimensions).length === 0 && c.period.instant && c.period.instant < end).sort((a, b) => (a.period.instant < b.period.instant ? 1 : -1))[0];
  const balancesPrev = prevCol ? factsAt(bs, prevCol.id, {}) : balances;

  // flows: per statement, the undimensioned duration ending at the period end
  // that carries the most facts (ties -> longer, i.e. year to date). Amazon's
  // 10-Q has an extra trailing-twelve-month column with only a few lines, so
  // "longest" alone would pick an almost empty column.
  const flows = {};
  const flowsA = {};
  let monthsLen = null;
  for (const type of ['income_statement', 'comprehensive_income', 'cash_flow']) {
    const stmt = statementOf(data, type);
    if (!stmt) continue;
    const cols = stmt.columns.filter((c) => Object.keys(c.dimensions).length === 0 && c.period.start && c.period.end && Math.abs(new Date(c.period.end) - new Date(end)) <= 4 * 86400000);
    if (!cols.length) continue;
    const count = (c) => stmt.lineItems.reduce((n, li) => n + (typeof li.values[c.id]?.value === 'number' ? 1 : 0), 0);
    const best = cols.map((c) => ({ c, n: count(c), m: months(c.period.start, c.period.end) })).sort((a, b) => b.n - a.n || b.m - a.m)[0];
    if (!best.n) continue;
    const m = best.m || 12;
    if (type === 'income_statement' || !monthsLen) monthsLen = m;
    const raw = factsAt(stmt, best.c.id, {});
    if (type === 'income_statement') {
      const est = costOfRevenueFromHeading(stmt, best.c.id);
      if (est != null) raw['synthetic:CostOfRevenueFromHeading'] = est;
      else if (noCostOfRevenue(stmt, best.c.id)) raw['synthetic:NoCostOfRevenue'] = 1;
    }
    for (const [k, v] of Object.entries(raw)) {
      if (k in flows) continue;
      flows[k] = v;
      flowsA[k] = v * (12 / m);
    }
  }
  if (!monthsLen) monthsLen = 12;
  return { balances, balancesPrev, flows, flowsA, monthsLen, factor: 12 / monthsLen };
}

export function scoreFiling(data) {
  const inp = singleFilingInputs(data);
  if (!inp) return null;
  const { balances, balancesPrev, flows, flowsA, monthsLen } = inp;
  const flow = (key) => first(flows, C[key]);
  const g = {
    flow,
    flowA: (key) => first(flowsA, C[key]),
    bal: (key) => first(balances, C[key]),
    balPrev: (key) => first(balancesPrev, C[key]),
    adequacy: () => {
      const ocf = flow('ocf');
      // no capital spending line in a cash-flow statement that does show operating cash: none was spent
      const capex = (flow('capex') ?? 0) + (flow('capexIntangibles') ?? 0);
      if (ocf == null) return null;
      const inv = first(balances, C.inventory);
      const invPrev = first(balancesPrev, C.inventory);
      const invInc = inv != null && invPrev != null ? Math.max(0, inv - invPrev) : 0;
      return { ocf, out: capex + invInc + (flow('dividends') ?? 0), periods: 1 };
    },
  };
  const { values } = ratios(g);
  const s = scoreValues(values);
  // every ratio (rounded) is kept so the screener can filter on it
  const rounded = {};
  for (const [k, v] of Object.entries(values)) rounded[k] = typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
  return {
    values: rounded,
    version: SCORE_VERSION,
    accession: data.filing.accession,
    cik: data.filing.cik,
    form: data.filing.form,
    fiscalYear: data.filing.fiscalYear,
    fiscalPeriod: data.filing.fiscalPeriod,
    periodEnd: data.filing.periodEnd,
    filingDate: data.filing.filingDate,
    basis: { monthsLen, annualized: monthsLen !== 12, note: monthsLen === 12 ? '全年數字' : `年初至今 ${monthsLen} 個月，流量 ×${(12 / monthsLen).toFixed(2)} 年化；現金流量允當比率以同一期間計算而非五年` },
    ...s,
  };
}

// Score of a saved filing, cached in SQLite by accession.
export function scoreAccession(accession) {
  const hit = store.getScore(accession, SCORE_VERSION);
  if (hit) return hit;
  const data = store.getFiling(accession);
  if (!data) return null;
  const s = scoreFiling(reclassify(data));
  if (s) store.putScore(accession, data.filing.cik, data.filing.periodEnd, SCORE_VERSION, s);
  return s;
}

// Latest score of every company (for the screener), cached for a minute.
let latestAllMemo = null;
export function latestScores() {
  const n = store.scoreCount(SCORE_VERSION);
  if (latestAllMemo && latestAllMemo.n === n && Date.now() - latestAllMemo.at < 60_000) return latestAllMemo.rows;
  const rows = store.latestScoreRows(SCORE_VERSION);
  latestAllMemo = { n, at: Date.now(), rows };
  return rows;
}

// Latest saved filing of a company and its score (null when nothing is saved yet).
export function latestScore(cik) {
  const rows = store.filingIndex(cik).filter((r) => r.report_date && !/\/A$/i.test(r.form || ''));
  if (!rows.length) return null;
  rows.sort((a, b) => (a.report_date < b.report_date ? 1 : a.report_date > b.report_date ? -1 : 0));
  return scoreAccession(rows[0].accession);
}
