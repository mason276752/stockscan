// Financial-ratio page. Two views over the same quarterly data points:
//   mode=quarter  a window of N fiscal quarters ending at a chosen quarter; the
//                 quarter's flows are annualised (x4 or trailing four quarters)
//                 before entering any ratio.
//   mode=year     N "years" ending at the chosen quarter, each the sum of four
//                 consecutive quarters (e.g. 2022 Q4 + 2023 Q1..Q3); balances
//                 are the year-end quarter, averages use the balance four
//                 quarters earlier. With a Q4 end these are exactly the fiscal years.
// Columns are ordered oldest -> newest.

import { pickFiling } from './edgar.js';
import { scrapeFiling } from './scrape.js';
import { yearQuarterPoints } from './quarters.js';

// Concept fallbacks (US-GAAP first, then IFRS). Lists are tried in order.
export const C = {
  revenue: ['us-gaap:Revenues', 'us-gaap:RevenueFromContractWithCustomerIncludingAssessedTax', 'us-gaap:SalesRevenueNet', 'us-gaap:RevenuesNetOfInterestExpense', 'ifrs-full:Revenue', 'ifrs-full:RevenueFromContractsWithCustomers'],
  cogs: ['us-gaap:CostOfRevenue', 'us-gaap:CostOfGoodsSold', 'ifrs-full:CostOfSales'],
  grossProfit: ['us-gaap:GrossProfit', 'ifrs-full:GrossProfit'],
  operatingIncome: ['us-gaap:OperatingIncomeLoss', 'ifrs-full:ProfitLossFromOperatingActivities'],
  pretaxIncome: [
    'us-gaap:IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
    'us-gaap:IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments',
    'us-gaap:IncomeLossFromContinuingOperationsBeforeIncomeTaxesDomestic',
    'ifrs-full:ProfitLossBeforeTax',
  ],
  netIncome: ['us-gaap:NetIncomeLoss', 'us-gaap:NetIncomeLossAvailableToCommonStockholdersBasic', 'us-gaap:ProfitLoss', 'ifrs-full:ProfitLossAttributableToOwnersOfParent', 'ifrs-full:ProfitLoss'],
  eps: ['us-gaap:EarningsPerShareDiluted', 'us-gaap:EarningsPerShareBasicAndDiluted', 'us-gaap:EarningsPerShareBasic', 'ifrs-full:DilutedEarningsLossPerShare', 'ifrs-full:BasicEarningsLossPerShare'],
  ocf: ['us-gaap:NetCashProvidedByUsedInOperatingActivities', 'us-gaap:NetCashProvidedByUsedInOperatingActivitiesContinuingOperations', 'ifrs-full:CashFlowsFromUsedInOperatingActivities'],
  icf: ['us-gaap:NetCashProvidedByUsedInInvestingActivities', 'us-gaap:NetCashProvidedByUsedInInvestingActivitiesContinuingOperations', 'ifrs-full:CashFlowsFromUsedInInvestingActivities'],
  fcf: ['us-gaap:NetCashProvidedByUsedInFinancingActivities', 'us-gaap:NetCashProvidedByUsedInFinancingActivitiesContinuingOperations', 'ifrs-full:CashFlowsFromUsedInFinancingActivities'],
  capex: ['us-gaap:PaymentsToAcquirePropertyPlantAndEquipment', 'us-gaap:PaymentsToAcquireProductiveAssets', 'ifrs-full:PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities'],
  dividends: ['us-gaap:PaymentsOfDividends', 'us-gaap:PaymentsOfDividendsCommonStock', 'us-gaap:PaymentsOfOrdinaryDividends', 'us-gaap:PaymentsOfDividendsCommonStock', 'ifrs-full:DividendsPaidClassifiedAsFinancingActivities', 'ifrs-full:DividendsPaid'],
  // balances
  cash: ['us-gaap:CashAndCashEquivalentsAtCarryingValue', 'us-gaap:CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents', 'us-gaap:CashAndDueFromBanks', 'ifrs-full:CashAndCashEquivalents'],
  ar: ['us-gaap:AccountsReceivableNetCurrent', 'us-gaap:ReceivablesNetCurrent', 'us-gaap:AccountsNotesAndLoansReceivableNetCurrent', 'ifrs-full:CurrentTradeReceivables', 'ifrs-full:TradeAndOtherCurrentReceivables'],
  inventory: ['us-gaap:InventoryNet', 'us-gaap:InventoryFinishedGoodsNetOfReserves', 'ifrs-full:Inventories'],
  prepaid: ['us-gaap:PrepaidExpenseCurrent'],
  currentAssets: ['us-gaap:AssetsCurrent', 'ifrs-full:CurrentAssets'],
  totalAssets: ['us-gaap:Assets', 'ifrs-full:Assets'],
  ppe: ['us-gaap:PropertyPlantAndEquipmentNet', 'ifrs-full:PropertyPlantAndEquipment'],
  ppeGross: ['us-gaap:PropertyPlantAndEquipmentGross', 'ifrs-full:PropertyPlantAndEquipmentGrossCarryingAmount'],
  ltInvestments: ['us-gaap:LongTermInvestments', 'us-gaap:OtherLongTermInvestments', 'us-gaap:MarketableSecuritiesNoncurrent', 'us-gaap:EquityMethodInvestments', 'ifrs-full:NoncurrentFinancialAssets', 'ifrs-full:InvestmentAccountedForUsingEquityMethod'],
  otherAssets: ['us-gaap:OtherAssetsNoncurrent', 'ifrs-full:OtherNoncurrentAssets'],
  ap: ['us-gaap:AccountsPayableCurrent', 'us-gaap:AccountsPayableAndAccruedLiabilitiesCurrent', 'us-gaap:AccountsPayableTradeCurrent', 'ifrs-full:TradeAndOtherCurrentPayablesToTradeSuppliers', 'ifrs-full:TradeAndOtherCurrentPayables'],
  currentLiabilities: ['us-gaap:LiabilitiesCurrent', 'ifrs-full:CurrentLiabilities'],
  totalLiabilities: ['us-gaap:Liabilities', 'ifrs-full:Liabilities'],
  nonCurrentLiabilities: ['us-gaap:LiabilitiesNoncurrent', 'ifrs-full:NoncurrentLiabilities'],
  equityParent: ['us-gaap:StockholdersEquity', 'ifrs-full:EquityAttributableToOwnersOfParent'],
  equityTotal: ['us-gaap:StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest', 'us-gaap:StockholdersEquity', 'ifrs-full:Equity', 'ifrs-full:EquityAttributableToOwnersOfParent'],
  liabilitiesAndEquity: ['us-gaap:LiabilitiesAndStockholdersEquity', 'ifrs-full:EquityAndLiabilities'],
  paidInCapital: ['us-gaap:CommonStocksIncludingAdditionalPaidInCapital', 'ifrs-full:IssuedCapital'],
  commonStock: ['us-gaap:CommonStockValue', 'us-gaap:CommonStockValueOutstanding'],
  apic: ['us-gaap:AdditionalPaidInCapital', 'us-gaap:AdditionalPaidInCapitalCommonStock', 'ifrs-full:SharePremium'],
};

export const first = (map, keys) => {
  for (const k of keys) if (map && map[k] != null) return map[k];
  return null;
};
const sum = (...xs) => (xs.every((x) => x == null) ? null : xs.reduce((a, x) => a + (x ?? 0), 0));
const div = (a, b) => (a == null || b == null || b === 0 ? null : a / b);
const pct = (a, b) => (div(a, b) == null ? null : (a / b) * 100);
const avg = (a, b) => (a == null ? null : b == null ? a : (a + b) / 2);

// Row catalogue: group, name, unit, kind (ratio | flow amount | balance) and the formula shown in the tooltip.
// benchmark: the rule of thumb a value is judged against (the indicators page
// colours the hovered row green / red by it)
export const ROWS = [
  { key: 'cashPct', group: '資產負債結構', name: '現金與約當現金（佔總資產%）', unit: '%', kind: 'ratio', formula: '現金及約當現金 ÷ 總資產', benchmark: { op: '>=', value: 25 } },
  { key: 'arPct', group: '資產負債結構', name: '應收帳款（佔總資產%）', unit: '%', kind: 'ratio', formula: '應收帳款淨額 ÷ 總資產' },
  { key: 'invPct', group: '資產負債結構', name: '存貨（佔總資產%）', unit: '%', kind: 'ratio', formula: '存貨 ÷ 總資產' },
  { key: 'caPct', group: '資產負債結構', name: '流動資產（佔總資產%）', unit: '%', kind: 'ratio', formula: '流動資產 ÷ 總資產' },
  { key: 'apPct', group: '資產負債結構', name: '應付帳款（佔總資產%）', unit: '%', kind: 'ratio', formula: '應付帳款 ÷ 總資產' },
  { key: 'clPct', group: '資產負債結構', name: '流動負債（佔總資產%）', unit: '%', kind: 'ratio', formula: '流動負債 ÷ 總資產' },
  { key: 'nclPct', group: '資產負債結構', name: '長期負債（佔總資產%）', unit: '%', kind: 'ratio', formula: '非流動負債 ÷ 總資產（無非流動負債科目時用 總負債 − 流動負債）' },
  { key: 'equityPct', group: '資產負債結構', name: '股東權益（佔總資產%）', unit: '%', kind: 'ratio', formula: '權益總額（含非控制權益）÷ 總資產' },

  { key: 'debtRatio', group: '財務結構', name: '負債佔資產比率', unit: '%', kind: 'ratio', formula: '總負債 ÷ 總資產', benchmark: { op: '<=', value: 60 } },
  { key: 'ltCapToPpe', group: '財務結構', name: '長期資金佔不動產、廠房及設備比率', unit: '%', kind: 'ratio', formula: '（權益總額 + 非流動負債）÷ 不動產、廠房及設備淨額', benchmark: { op: '>=', value: 100 } },

  { key: 'currentRatio', group: '償債能力', name: '流動比率', unit: '%', kind: 'ratio', formula: '流動資產 ÷ 流動負債', benchmark: { op: '>=', value: 250 } },
  { key: 'quickRatio', group: '償債能力', name: '速動比率', unit: '%', kind: 'ratio', formula: '（流動資產 − 存貨 − 預付費用）÷ 流動負債', benchmark: { op: '>=', value: 150 } },

  { key: 'arTurnover', group: '經營能力', name: '應收款項週轉率', unit: '次', kind: 'ratio', annualized: true, formula: '營業收入（年化）÷ 平均應收帳款' },
  { key: 'dso', group: '經營能力', name: '平均收現日數', unit: '天', kind: 'ratio', annualized: true, formula: '365 ÷ 應收款項週轉率', benchmark: { op: '<=', value: 15 } },
  { key: 'invTurnover', group: '經營能力', name: '存貨週轉率', unit: '次', kind: 'ratio', annualized: true, formula: '營業成本（年化）÷ 平均存貨' },
  { key: 'dio', group: '經營能力', name: '平均銷貨日數（平均在庫天數）', unit: '天', kind: 'ratio', annualized: true, formula: '365 ÷ 存貨週轉率', benchmark: { op: '<=', value: 100 } },
  { key: 'apTurnover', group: '經營能力', name: '應付款項週轉率', unit: '次', kind: 'ratio', annualized: true, formula: '營業成本（年化）÷ 平均應付帳款' },
  { key: 'dpo', group: '經營能力', name: '平均付款日數', unit: '天', kind: 'ratio', annualized: true, formula: '365 ÷ 應付款項週轉率：進貨後平均多久才付錢給供應商' },
  { key: 'cashGap', group: '經營能力', name: '缺現金的天數（現金轉換循環）', unit: '天', kind: 'ratio', annualized: true, formula: '平均銷貨日數 + 平均收現日數 − 平均付款日數：從付錢給供應商到收到客戶的錢之間，自己要墊多少天的錢；愈少愈好，負數代表先收到錢才付款（如 Apple、Amazon）' },
  { key: 'cycle', group: '經營能力', name: '做生意的完整週期', unit: '天', kind: 'ratio', annualized: true, formula: '平均銷貨日數 + 平均收現日數：從進貨到賣出、再到收到現金要多久（未扣應付帳款天數的營業週期）', benchmark: { op: '<=', value: 200 } },
  { key: 'ppeTurnover', group: '經營能力', name: '不動產、廠房及設備週轉率', unit: '次', kind: 'ratio', annualized: true, formula: '營業收入（年化）÷ 平均不動產、廠房及設備淨額' },
  { key: 'assetTurnover', group: '經營能力', name: '總資產週轉率', unit: '次', kind: 'ratio', annualized: true, formula: '營業收入（年化）÷ 平均總資產', benchmark: { op: '>=', value: 1 } },

  { key: 'roa', group: '獲利能力', name: '資產報酬率 ROA', unit: '%', kind: 'ratio', annualized: true, formula: '稅後淨利（年化）÷ 平均總資產' },
  { key: 'roe', group: '獲利能力', name: '權益報酬率 ROE', unit: '%', kind: 'ratio', annualized: true, formula: '稅後淨利（年化）÷ 平均股東權益（母公司）', benchmark: { op: '>=', value: 20 } },
  { key: 'pretaxToCapital', group: '獲利能力', name: '稅前純益佔實收資本比率', unit: '%', kind: 'ratio', annualized: true, formula: '稅前淨利（年化）÷（普通股股本 + 資本公積）。美國公司面額極低，此比率意義有限' },
  { key: 'grossMargin', group: '獲利能力', name: '營業毛利率 ①', unit: '%', kind: 'ratio', formula: '毛利 ÷ 營業收入（無毛利科目時用 營業收入 − 營業成本）', benchmark: { op: '>=', value: 25 } },
  { key: 'opMargin', group: '獲利能力', name: '營業利益率 ②', unit: '%', kind: 'ratio', formula: '營業利益 ÷ 營業收入', benchmark: { op: '>=', value: 15 } },
  { key: 'safetyMargin', group: '獲利能力', name: '經營安全邊際率 ②/①', unit: '%', kind: 'ratio', formula: '營業利益率 ÷ 營業毛利率，愈大愈好' },
  { key: 'netMargin', group: '獲利能力', name: '純益率（淨利率）', unit: '%', kind: 'ratio', formula: '稅後淨利 ÷ 營業收入', benchmark: { op: '>=', value: 10 } },
  { key: 'eps', group: '獲利能力', name: '每股盈餘（稀釋）', unit: '元', kind: 'flow', formula: '申報書稀釋每股盈餘；Q4 為全年減前三季之近似值，年度檢視為四季相加。未做股票分割調整，跨越分割日的期間數字會失真', benchmark: { op: '>', value: 0 } },
  { key: 'netIncome', group: '獲利能力', name: '稅後淨利', unit: '百萬', kind: 'flow', formula: '歸屬於母公司之淨利' },
  { key: 'revenue', group: '獲利能力', name: '營業收入', unit: '百萬', kind: 'flow', formula: '營業收入' },

  { key: 'cfRatio', group: '現金流量', name: '現金流量比率', unit: '%', kind: 'ratio', annualized: true, formula: '營業活動現金流量（年化）÷ 流動負債', benchmark: { op: '>', value: 100 } },
  { key: 'cfAdequacy', group: '現金流量', name: '現金流量允當比率', unit: '%', kind: 'ratio', formula: '最近五年營業活動現金流量 ÷ 最近五年（資本支出 + 存貨增加 + 現金股利）。資料不足五年時用可取得的期間（至少四季），tooltip 會註明期數', benchmark: { op: '>', value: 100 } },
  { key: 'cfReinvest', group: '現金流量', name: '現金再投資比率', unit: '%', kind: 'ratio', annualized: true, formula: '（營業活動現金流量 − 現金股利，年化）÷（不動產、廠房及設備毛額 + 長期投資 + 其他資產 + 營運資金）', benchmark: { op: '>', value: 10 } },
  { key: 'ocf', group: '現金流量', name: '營業活動現金流量', unit: '百萬', kind: 'flow', formula: '來自現金流量表' },
  { key: 'icf', group: '現金流量', name: '投資活動現金流量', unit: '百萬', kind: 'flow', formula: '來自現金流量表' },
  { key: 'fcf', group: '現金流量', name: '籌資活動現金流量', unit: '百萬', kind: 'flow', formula: '來自現金流量表' },
];


function stepBack(year, q) {
  return q === 1 ? [year - 1, 4] : [year, q - 1];
}

// Ordered (oldest first) list of quarter keys ending at (year, q), `count` long.
export function quarterKeys(year, q, count) {
  const out = [];
  let y = year;
  let k = q;
  for (let i = 0; i < count; i++) {
    out.unshift({ year: y, q: k });
    [y, k] = stepBack(y, k);
  }
  return out;
}

// Load the quarter points needed and index them by "year-Qn" (or "year-FY").
export async function loadPoints(client, company, keys, quarterly) {
  const years = [...new Set(keys.map((k) => k.year))];
  const filingsByYear = {};
  for (const y of years) {
    filingsByYear[y] = {};
    for (const p of quarterly ? ['Q1', 'Q2', 'Q3', 'FY'] : ['FY']) {
      // a year's Q4 needs the 10-K and the 10-Qs (cumulative nine months)
      const needed = keys.some((k) => k.year === y && (!quarterly || k.q === 4 || p === `Q${k.q}`));
      const f = needed ? pickFiling(company.filings, { year: y, period: p }) : null;
      if (f) filingsByYear[y][p] = f;
    }
  }
  const docsByYear = {};
  await Promise.all(
    years.flatMap((y) =>
      Object.entries(filingsByYear[y]).map(async ([p, f]) => {
        (docsByYear[y] ||= {})[p] = await scrapeFiling(client, f, company);
      }),
    ),
  );
  const byKey = {};
  for (const y of years) {
    if (!docsByYear[y]) continue;
    if (quarterly) {
      for (const pt of yearQuarterPoints(docsByYear[y], filingsByYear[y])) byKey[`${y}-${pt.period}`] = { ...pt, year: y };
    } else if (docsByYear[y].FY) {
      const [pt] = yearQuarterPoints({ FY: docsByYear[y].FY }, { FY: filingsByYear[y].FY });
      byKey[`${y}-FY`] = { ...pt, period: 'FY', flows: pt.fy, year: y };
    }
  }
  return byKey;
}

// All ratios for one column. `g` supplies the inputs:
//   flow(key)   flow amount for the column's own period (a quarter, or a year)
//   flowA(key)  the same on an annual basis
//   bal(key)    closing balance, balPrev(key) opening balance
//   adequacy()  { ocf, out, periods } sums for the cash-flow-adequacy ratio
function ratios(g) {
  const v = {};
  const totalAssets = g.bal('totalAssets');
  const currentAssets = g.bal('currentAssets');
  const currentLiabilities = g.bal('currentLiabilities');
  const equityTotal = g.bal('equityTotal');
  const totalLiabilities = g.bal('totalLiabilities') ?? (g.bal('liabilitiesAndEquity') != null && equityTotal != null ? g.bal('liabilitiesAndEquity') - equityTotal : null);
  const ncl = g.bal('nonCurrentLiabilities') ?? (totalLiabilities != null && currentLiabilities != null ? totalLiabilities - currentLiabilities : null);
  const inventory = g.bal('inventory');
  const avgBal = (key) => avg(g.bal(key), g.balPrev(key));

  v.cashPct = pct(g.bal('cash'), totalAssets);
  v.arPct = pct(g.bal('ar'), totalAssets);
  v.invPct = pct(inventory, totalAssets);
  v.caPct = pct(currentAssets, totalAssets);
  v.apPct = pct(g.bal('ap'), totalAssets);
  v.clPct = pct(currentLiabilities, totalAssets);
  v.nclPct = pct(ncl, totalAssets);
  v.equityPct = pct(equityTotal, totalAssets);

  v.debtRatio = pct(totalLiabilities, totalAssets);
  v.ltCapToPpe = pct(sum(equityTotal, ncl), g.bal('ppe'));
  v.currentRatio = pct(currentAssets, currentLiabilities);
  v.quickRatio = currentAssets == null ? null : pct(currentAssets - (inventory ?? 0) - (g.bal('prepaid') ?? 0), currentLiabilities);

  const revenueA = g.flowA('revenue');
  v.arTurnover = div(revenueA, avgBal('ar'));
  v.dso = div(365, v.arTurnover);
  v.invTurnover = div(g.flowA('cogs'), avgBal('inventory'));
  v.dio = div(365, v.invTurnover);
  v.cycle = v.dso != null && v.dio != null ? v.dso + v.dio : null;
  v.apTurnover = div(g.flowA('cogs'), avgBal('ap'));
  v.dpo = div(365, v.apTurnover);
  v.cashGap = v.cycle != null && v.dpo != null ? v.cycle - v.dpo : null;
  v.ppeTurnover = div(revenueA, avgBal('ppe'));
  v.assetTurnover = div(revenueA, avgBal('totalAssets'));

  const netIncomeA = g.flowA('netIncome');
  v.roa = pct(netIncomeA, avgBal('totalAssets'));
  v.roe = pct(netIncomeA, avgBal('equityParent') ?? avgBal('equityTotal'));
  const paidIn = g.bal('paidInCapital') ?? sum(g.bal('commonStock'), g.bal('apic'));
  v.pretaxToCapital = pct(g.flowA('pretaxIncome'), paidIn);

  const revenue = g.flow('revenue');
  const cogs = g.flow('cogs');
  const gross = g.flow('grossProfit') ?? (revenue != null && cogs != null ? revenue - cogs : null);
  v.grossMargin = pct(gross, revenue);
  v.opMargin = pct(g.flow('operatingIncome'), revenue);
  v.safetyMargin = pct(v.opMargin, v.grossMargin);
  v.netMargin = pct(g.flow('netIncome'), revenue);

  v.eps = g.flow('eps');
  v.netIncome = g.flow('netIncome');
  v.revenue = revenue;
  v.ocf = g.flow('ocf');
  v.icf = g.flow('icf');
  v.fcf = g.flow('fcf');

  const ocfA = g.flowA('ocf');
  v.cfRatio = pct(ocfA, currentLiabilities);
  const ad = g.adequacy();
  v.cfAdequacy = ad ? pct(ad.ocf, ad.out) : null;
  v.cfAdequacyPeriods = ad ? ad.periods : 0;

  const reinvestBase = sum(g.bal('ppeGross') ?? g.bal('ppe'), g.bal('ltInvestments'), g.bal('otherAssets'), currentAssets != null && currentLiabilities != null ? currentAssets - currentLiabilities : null);
  v.cfReinvest = pct(ocfA == null ? null : ocfA - (g.flowA('dividends') ?? 0), reinvestBase);

  const flowsAnnualized = {};
  for (const k of ['eps', 'netIncome', 'revenue', 'ocf', 'icf', 'fcf']) flowsAnnualized[k] = g.flowA(k);
  return { values: v, flowsAnnualized };
}

// Cash-flow adequacy inputs over the trailing `span` points ending at index i.
function adequacyOver(points, i, span, minPeriods) {
  let ocf = 0;
  let out = 0;
  let periods = 0;
  const flow = (k, key) => first(points[k]?.flows, C[key]);
  const bal = (k, key) => first(points[k]?.balances, C[key]);
  for (let k = i; k > Math.max(0, i - span); k--) {
    const o = flow(k, 'ocf');
    const capex = flow(k, 'capex');
    if (o == null || capex == null) break;
    const invInc = bal(k, 'inventory') != null && bal(k - 1, 'inventory') != null ? Math.max(0, bal(k, 'inventory') - bal(k - 1, 'inventory')) : 0;
    ocf += o;
    out += capex + invInc + (flow(k, 'dividends') ?? 0);
    periods++;
  }
  return periods >= minPeriods ? { ocf, out, periods } : null;
}

export async function buildIndicators(client, company, { year, period, n = 20, basis = 'x4', mode = 'quarter' }) {
  const quarterly = company.filings.some((f) => f.fiscalPeriod && f.fiscalPeriod.startsWith('Q'));
  const endQ = period === 'FY' ? 4 : Number(period.slice(1));
  const yearMode = mode === 'year' && quarterly;
  const sameMode = mode === 'same' && quarterly; // the chosen quarter only, one column per year

  // --- annual filers: one point per fiscal year -------------------------
  if (!quarterly) {
    const keys = [];
    for (let i = 0; i < n + 1; i++) keys.unshift({ year: year - i, q: 4 });
    const byKey = await loadPoints(client, company, keys, false);
    const points = keys.map((k) => byKey[`${k.year}-FY`] || { year: k.year, period: 'FY', flows: {}, balances: {}, missing: true });
    const columns = [];
    for (let i = 1; i < points.length; i++) {
      const g = {
        flow: (key) => first(points[i].flows, C[key]),
        flowA: (key) => first(points[i].flows, C[key]),
        bal: (key) => first(points[i].balances, C[key]),
        balPrev: (key) => first(points[i - 1].balances, C[key]),
        adequacy: () => adequacyOver(points, i, 5, 1),
      };
      columns.push({ label: `FY${points[i].year}`, year: points[i].year, period: 'FY', periodEnd: points[i].periodEnd || null, missing: !!points[i].missing, sources: points[i].sources || [], ...ratios(g) });
    }
    return { fetchedAt: new Date().toISOString(), company: meta(company), quarterly: false, mode: 'year', basis: 'annual', end: { year, period }, rows: ROWS, columns };
  }

  // --- quarterly filers ---------------------------------------------------
  // year mode needs 4 quarters per column plus 4 more for opening balances;
  // quarter mode needs one extra quarter for opening balances.
  const count = yearMode || sameMode ? n * 4 + 4 : n + 1;
  const keys = quarterKeys(year, endQ, count);
  const byKey = await loadPoints(client, company, keys, true);
  const points = keys.map((k) => byKey[`${k.year}-Q${k.q}`] || { year: k.year, period: `Q${k.q}`, flows: {}, balances: {}, missing: true });
  const flowAt = (i, key) => first(points[i]?.flows, C[key]);
  const balAt = (i, key) => first(points[i]?.balances, C[key]);
  const sumFlows = (i, len, key) => {
    let total = 0;
    for (let k = i - len + 1; k <= i; k++) {
      const x = flowAt(k, key);
      if (x == null) return null;
      total += x;
    }
    return total;
  };

  const columns = [];
  if (yearMode) {
    for (let j = n - 1; j >= 0; j--) {
      const i = points.length - 1 - j * 4; // closing quarter of this "year"
      const span = points.slice(i - 3, i + 1);
      const g = {
        flow: (key) => sumFlows(i, 4, key),
        flowA: (key) => sumFlows(i, 4, key),
        bal: (key) => balAt(i, key),
        balPrev: (key) => balAt(i - 4, key),
        adequacy: () => adequacyOver(points, i, 20, 4),
      };
      const end = points[i];
      const start = points[i - 3];
      const isFiscalYear = endQ === 4;
      columns.push({
        label: isFiscalYear ? `FY${end.year}` : `${end.year} ${end.period}`,
        sublabel: isFiscalYear ? null : `${start.year} ${start.period} ~ ${end.year} ${end.period}`,
        year: end.year,
        period: end.period,
        periodEnd: end.periodEnd || null,
        missing: span.some((p) => p.missing),
        sources: span.flatMap((p) => p.sources || []),
        ...ratios(g),
      });
    }
  } else {
    for (let i = 1; i < points.length; i++) {
      const flowA = (key) => {
        if (basis === 'ttm') return i < 3 ? null : sumFlows(i, 4, key);
        const x = flowAt(i, key);
        return x == null ? null : x * 4;
      };
      const g = {
        flow: (key) => flowAt(i, key),
        flowA,
        bal: (key) => balAt(i, key),
        balPrev: (key) => balAt(i - 1, key),
        adequacy: () => adequacyOver(points, i, 20, 4),
      };
      const p = points[i];
      // same-quarter view: the first four points only feed opening balances / trailing sums
      if (sameMode && (p.period !== `Q${endQ}` || i < points.length - n * 4)) continue;
      columns.push({ label: `${p.year} ${p.period}`, year: p.year, period: p.period, periodEnd: p.periodEnd || null, missing: !!p.missing, sources: p.sources || [], ...ratios(g) });
    }
  }

  return {
    fetchedAt: new Date().toISOString(),
    company: meta(company),
    quarterly: true,
    mode: yearMode ? 'year' : sameMode ? 'same' : 'quarter',
    basis: yearMode ? 'sum4' : basis,
    end: { year, period },
    rows: ROWS,
    columns,
  };
}

const meta = (company) => ({ cik: company.cik, name: company.name, tickers: company.tickers, fiscalYearEnd: company.fiscalYearEnd });
