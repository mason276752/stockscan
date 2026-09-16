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

export const SCORE_VERSION = 16;

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

// screener amount fields: values key -> C key
export const BALANCE_AMOUNTS = { totalAssets: 'totalAssets', totalLiabilities: 'totalLiabilities', equity: 'equityTotal', cash: 'cash', ar: 'ar', inventory: 'inventory', ap: 'ap', ppe: 'ppe', currentAssets: 'currentAssets', currentLiabilities: 'currentLiabilities', longTermDebt: 'longTermDebt' };
export const FLOW_AMOUNTS = { revenueAnn: 'revenue', grossProfitAnn: 'grossProfit', operatingIncomeAnn: 'operatingIncome', pretaxIncomeAnn: 'pretaxIncome', netIncomeAnn: 'netIncome', rdAnn: 'rd', sgaAnn: 'sga', interestExpenseAnn: 'interestExpenseNonop', incomeTaxAnn: 'incomeTax', ocfAnn: 'ocf', capexAnn: 'capex', dividendsAnn: 'dividends', buybacksAnn: 'buybacks', stockIssuedAnn: 'stockIssued' };
export const AMOUNT_FIELDS = [
  { key: 'totalAssets', name: '總資產', group: '資產負債表' },
  { key: 'currentAssets', name: '流動資產', group: '資產負債表' },
  { key: 'cash', name: '現金及約當現金', group: '資產負債表' },
  { key: 'ar', name: '應收帳款', group: '資產負債表' },
  { key: 'inventory', name: '存貨', group: '資產負債表' },
  { key: 'ppe', name: '不動產、廠房及設備', group: '資產負債表' },
  { key: 'totalLiabilities', name: '總負債', group: '資產負債表' },
  { key: 'currentLiabilities', name: '流動負債', group: '資產負債表' },
  { key: 'ap', name: '應付帳款', group: '資產負債表' },
  { key: 'longTermDebt', name: '長期借款', group: '資產負債表' },
  { key: 'equity', name: '股東權益', group: '資產負債表' },
  { key: 'revenueAnn', name: '營業收入（年化）', group: '損益表' },
  { key: 'grossProfitAnn', name: '營業毛利（年化）', group: '損益表' },
  { key: 'rdAnn', name: '研發費用（年化）', group: '損益表' },
  { key: 'sgaAnn', name: '銷管費用（年化）', group: '損益表' },
  { key: 'operatingIncomeAnn', name: '營業利益（年化）', group: '損益表' },
  { key: 'interestExpenseAnn', name: '利息費用（年化）', group: '損益表' },
  { key: 'pretaxIncomeAnn', name: '稅前淨利（年化）', group: '損益表' },
  { key: 'incomeTaxAnn', name: '所得稅（年化）', group: '損益表' },
  { key: 'netIncomeAnn', name: '本期淨利（年化）', group: '損益表' },
  { key: 'sharesDiluted', name: '稀釋加權股數', group: '損益表', unit: '百萬股' },
  { key: 'ocfAnn', name: '營業活動現金流（年化）', group: '現金流量與權益' },
  { key: 'capexAnn', name: '資本支出（年化）', group: '現金流量與權益' },
  { key: 'dividendsAnn', name: '現金股利發放（年化）', group: '現金流量與權益' },
  { key: 'buybacksAnn', name: '庫藏股買回（年化）', group: '現金流量與權益' },
  { key: 'stockIssuedAnn', name: '發行新股所得（年化）', group: '現金流量與權益' },
].map((f) => ({ unit: '百萬', ...f }));

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
  // statement lines as amounts, for the screener: balances at the period end,
  // flows annualised like the ratios (a 10-Q's nine months ×12/9)
  for (const [key, ckey] of Object.entries(BALANCE_AMOUNTS)) values[key] = g.bal(ckey);
  values.equity = values.equity ?? (g.bal('liabilitiesAndEquity') != null && g.bal('totalLiabilities') != null ? g.bal('liabilitiesAndEquity') - g.bal('totalLiabilities') : null);
  for (const [key, ckey] of Object.entries(FLOW_AMOUNTS)) values[key] = g.flowA(ckey);
  values.grossProfitAnn = values.grossProfitAnn ?? (values.grossMargin != null && values.revenueAnn != null ? (values.grossMargin / 100) * values.revenueAnn : null);
  values.operatingIncomeAnn = values.operatingIncomeAnn ?? (values.opMargin != null && values.revenueAnn != null ? (values.opMargin / 100) * values.revenueAnn : null);
  values.sharesDiluted = g.flow('sharesDiluted');
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

// Latest score of every company (for the screener), each with the previous
// filing's values (`prev`) and the same period a year earlier (`yoy`) for
// change filters. Cached for a minute; decoded score JSON is kept per
// accession so a refresh only decodes what is new.
let latestAllMemo = null;
const decoded = new Map(); // accession -> score
const HISTORY = 6; // filings per company to look at for prev / yoy
function scoreOf(accession) {
  if (!decoded.has(accession)) decoded.set(accession, store.scoreJson(accession));
  return decoded.get(accession);
}
export function latestScores() {
  const n = store.scoreCount(SCORE_VERSION);
  if (latestAllMemo && latestAllMemo.n === n && Date.now() - latestAllMemo.at < 60_000) return latestAllMemo.rows;
  const byCik = new Map();
  for (const r of store.scoreIndex(SCORE_VERSION)) {
    if (!r.report_date) continue;
    const list = byCik.get(r.cik) || [];
    if (list.length < HISTORY) list.push(r.accession);
    byCik.set(r.cik, list);
  }
  const rows = [];
  for (const [, accs] of byCik) {
    const hist = accs.map(scoreOf).filter((x) => x && !/\/A$/i.test(x.form || ''));
    if (!hist.length) continue;
    const cur = hist[0];
    const prev = hist[1] || null;
    const yoy = hist.find((x, i) => i > 0 && x.fiscalPeriod === cur.fiscalPeriod && String(Number(x.fiscalYear) + 1) === String(cur.fiscalYear)) || null;
    rows.push({ ...cur, prev: prev ? { accession: prev.accession, fiscalYear: prev.fiscalYear, fiscalPeriod: prev.fiscalPeriod, periodEnd: prev.periodEnd, score: prev.score, values: prev.values } : null, yoy: yoy ? { accession: yoy.accession, fiscalYear: yoy.fiscalYear, fiscalPeriod: yoy.fiscalPeriod, periodEnd: yoy.periodEnd, score: yoy.score, values: yoy.values } : null, history: hist.length });
  }
  if (decoded.size > 60_000) decoded.clear();
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
