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
// The numbers are the ones the indicator table shows for that filing's
// column: a quarterly filer's quarter has its flows ×4 and its balances
// averaged with the quarter before (Q4 = 10-K full year − nine months), so
// scoring a filing needs its neighbours (scoreFilingOf); an annual filer's
// year is the filing alone, flows as they are and the comparative column as
// the opening balances (scoreFiling). Cash-flow adequacy is that one period
// rather than the table's five years. A quarterly filing whose neighbours
// are not saved (the oldest one saved of a company) is scored alone from
// its year-to-date column (×12/months) and marked partial, to be redone
// once they are.

import { C, ROWS, adequacyOver, first, loadPoints, quarterInputs, quarterKeys, ratios } from './indicators.ts';
import { filingPeriodKey } from './filings.ts';
import { balancesAt, costOfRevenueFromHeading, factsAt, months, noCostOfRevenue, statementOf } from './quarters.ts';

export const SCORE_VERSION = 17;

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

// The score from ratios() inputs `g` (see indicators.js), for the filing
// `header` (accession, form, fiscal labels …). `basis` says what the flows
// cover: kind 'quarter' (one quarter ×4), 'annual' (a full year) or 'ytd'
// (a 10-Q's year-to-date column ×12/months - the fallback), with monthsLen;
// `partial` marks a fallback that should be redone once the neighbouring
// filing is saved.
function scoreInputs(g, header, basis, { sharesDiluted } = {}) {
  const { values } = ratios(g);
  // statement lines as amounts, for the screener: balances at the period end,
  // flows annualised like the ratios
  for (const [key, ckey] of Object.entries(BALANCE_AMOUNTS)) values[key] = g.bal(ckey);
  values.equity = values.equity ?? (g.bal('liabilitiesAndEquity') != null && g.bal('totalLiabilities') != null ? g.bal('liabilitiesAndEquity') - g.bal('totalLiabilities') : null);
  for (const [key, ckey] of Object.entries(FLOW_AMOUNTS)) values[key] = g.flowA(ckey);
  values.grossProfitAnn = values.grossProfitAnn ?? (values.grossMargin != null && values.revenueAnn != null ? (values.grossMargin / 100) * values.revenueAnn : null);
  values.operatingIncomeAnn = values.operatingIncomeAnn ?? (values.opMargin != null && values.revenueAnn != null ? (values.opMargin / 100) * values.revenueAnn : null);
  values.sharesDiluted = sharesDiluted ?? g.flow('sharesDiluted');
  const s = scoreValues(values);
  // every ratio (rounded) is kept so the screener can filter on it
  const rounded = {};
  for (const [k, v] of Object.entries(values)) rounded[k] = typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
  const { monthsLen } = basis;
  const note = basis.kind === 'quarter' ? '單季流量 ×4 年化，平均餘額用本季末與上季末（同財務指標表）；現金流量允當比率以這一季計算而非五年' : monthsLen === 12 ? '全年數字' : `年初至今 ${monthsLen} 個月，流量 ×${(12 / monthsLen).toFixed(2)} 年化；現金流量允當比率以同一期間計算而非五年`;
  return {
    values: rounded,
    version: SCORE_VERSION,
    accession: header.accession,
    cik: header.cik,
    form: header.form,
    fiscalYear: header.fiscalYear,
    fiscalPeriod: header.fiscalPeriod,
    periodEnd: header.periodEnd,
    filingDate: header.filingDate,
    basis: { ...basis, annualized: monthsLen !== 12, note: basis.partial ? `缺上一季的申報，先以這份申報單獨計算：${note}` : note },
    ...s,
  };
}

// Score from one filing alone: an annual filer's year, or the fallback for a
// quarterly filing whose neighbours are not saved (`partial`).
export function scoreFiling(data, { partial = false } = {}) {
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
  return scoreInputs(g, data.filing, { kind: monthsLen === 12 ? 'annual' : monthsLen === 3 ? 'quarter' : 'ytd', monthsLen, ...(partial ? { partial: true } : {}) });
}

// Score of `filing` (an entry of company.filings) the way the indicator
// table computes its column. `load(filing)` fetches a saved filing; a
// quarterly filer's quarter needs the one before (opening balances) and,
// for Q4, the year's 10-Qs (Q4 flows = full year − nine months). When those
// are not there the filing is scored alone and marked partial.
// Score one saved filing against its neighbouring quarters. The filing
// being scored serves its own period, whatever else was filed for it: the
// other versions of that period (its original, or a later amendment) are
// taken out of the list first, so `loadPoints` cannot answer with one of
// them - scoring a filing means scoring the numbers in *that* filing. Every
// other period still resolves to its amended version (filings.js).
export async function scoreFilingOf(load, company, filing) {
  const own = filingPeriodKey(filing);
  company = { ...company, filings: company.filings.filter((f) => f.accession === filing.accession || filingPeriodKey(f) !== own) };
  const quarterly = company.filings.some((f) => f.fiscalPeriod && f.fiscalPeriod.startsWith('Q'));
  const year = Number(filing.fiscalYear);
  const q = filing.fiscalPeriod === 'FY' ? 4 : Number(String(filing.fiscalPeriod || '').slice(1));
  if (!quarterly || !year || !(q >= 1 && q <= 4)) return scoreFiling(await load(filing));
  const keys = quarterKeys(year, q, 2);
  const byKey = await loadPoints(load, company, keys, true);
  const points = keys.map((k) => byKey[`${k.year}-Q${k.q}`] || { missing: true, flows: {}, balances: {} });
  const [prev, cur] = points;
  const hasFlows = Object.values(cur.flows).some((x) => x != null);
  if (cur.missing || !hasFlows || !cur.sources?.includes(filing.accession)) return scoreFiling(await load(filing), { partial: true });
  // a first quarter without the 10-K before it: the 10-Q's own comparative
  // column is that quarter end, and its three-month column the quarter
  if (prev.missing) return scoreFiling(await load(filing), { partial: q !== 1 });
  const g = quarterInputs(points, 1, () => adequacyOver(points, 1, 1, 1));
  const header = { accession: filing.accession, cik: company.cik, form: filing.form, fiscalYear: String(year), fiscalPeriod: filing.fiscalPeriod, periodEnd: cur.periodEnd || filing.reportDate, filingDate: filing.filingDate };
  // Q4's weighted shares cannot be full year − nine months: the 10-K's own
  return scoreInputs(g, header, { kind: 'quarter', monthsLen: 3, quarter: `${year} Q${q}` }, { sharesDiluted: q === 4 ? first(cur.fy, C.sharesDiluted) : undefined });
}

