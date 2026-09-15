// Valuation page: relative multiples over time (with the price quoted at each
// quarter end) and absolute models (DCF, DDM, RIM, EPV, Graham …) on the
// trailing-twelve-month figures of the chosen quarter and today's price.
//
// Financial inputs come from the same quarterly points as the indicators
// page; shares outstanding from SEC's companyconcept API (cover page
// dei:EntityCommonStockSharesOutstanding); prices from Yahoo Finance.

import { C, first, loadPoints, quarterKeys } from './indicators.js';
import { closeOn, history, quote } from './prices.js';
import { pickFiling } from './edgar.js';
import { scrapeFiling } from './scrape.js';
import { store } from './store.js';
import { MODELS, cagr, clamp, impliedPrice, multiplesAt, runModels } from '../../shared/valuation.js';

const CONCEPT_API = 'https://data.sec.gov/api/xbrl/companyconcept/';
const SHARES_TTL = 24 * 3600 * 1000;

// extra concepts beyond the indicators table
const V = {
  da: ['us-gaap:DepreciationDepletionAndAmortization', 'us-gaap:DepreciationAndAmortization', 'us-gaap:DepreciationAmortizationAndAccretionNet', 'us-gaap:Depreciation', 'ifrs-full:DepreciationAndAmortisationExpense'],
  tax: ['us-gaap:IncomeTaxExpenseBenefit', 'ifrs-full:IncomeTaxExpenseContinuingOperations'],
  dilutedShares: ['us-gaap:WeightedAverageNumberOfDilutedSharesOutstanding', 'us-gaap:WeightedAverageNumberOfShareOutstandingBasicAndDiluted', 'us-gaap:WeightedAverageNumberOfSharesOutstandingBasic', 'ifrs-full:AdjustedWeightedAverageShares', 'ifrs-full:WeightedAverageShares'],
  stInvestments: ['us-gaap:ShortTermInvestments', 'us-gaap:MarketableSecuritiesCurrent', 'us-gaap:AvailableForSaleSecuritiesDebtSecuritiesCurrent', 'ifrs-full:CurrentFinancialAssetsAtFairValueThroughProfitOrLoss'],
  ltDebtNoncurrent: ['us-gaap:LongTermDebtNoncurrent', 'us-gaap:LongTermDebtAndCapitalLeaseObligations', 'us-gaap:LongTermDebtAndFinanceLeasesNoncurrent', 'ifrs-full:NoncurrentPortionOfNoncurrentBorrowings', 'ifrs-full:LongtermBorrowings'],
  ltDebtTotal: ['us-gaap:LongTermDebt', 'us-gaap:DebtLongtermAndShorttermCombinedAmount', 'ifrs-full:Borrowings'],
  ltDebtCurrent: ['us-gaap:LongTermDebtCurrent', 'us-gaap:DebtCurrent', 'us-gaap:LongTermDebtAndCapitalLeaseObligationsCurrent', 'us-gaap:LongTermDebtAndFinanceLeasesCurrent', 'ifrs-full:CurrentPortionOfNoncurrentBorrowings', 'ifrs-full:CurrentBorrowingsAndCurrentPortionOfNoncurrentBorrowings'],
  stBorrowings: ['us-gaap:ShortTermBorrowings', 'us-gaap:CommercialPaper', 'ifrs-full:ShorttermBorrowings'],
  goodwill: ['us-gaap:Goodwill', 'ifrs-full:Goodwill'],
  intangibles: ['us-gaap:IntangibleAssetsNetExcludingGoodwill', 'us-gaap:FiniteLivedIntangibleAssetsNet', 'ifrs-full:IntangibleAssetsOtherThanGoodwill'],
  intangiblesInclGoodwill: ['us-gaap:IntangibleAssetsNetIncludingGoodwill'],
};

const nz = (x) => x ?? 0;

// Shares outstanding per filing (accession) from the cover page, via companyconcept.
async function sharesByAccession(client, cik) {
  const key = `shares:${cik}`;
  const saved = store.getKV(key);
  if (saved && saved.ageMs < SHARES_TTL) return saved.value;
  const padded = String(cik).padStart(10, '0');
  const out = { byAccn: {}, list: [] };
  for (const [tax, concept] of [
    ['dei', 'EntityCommonStockSharesOutstanding'],
    ['us-gaap', 'CommonStockSharesOutstanding'],
  ]) {
    try {
      const j = await client.json(`${CONCEPT_API}CIK${padded}/${tax}/${concept}.json`);
      for (const f of j.units?.shares || []) {
        if (typeof f.val !== 'number' || f.val <= 0) continue;
        if (!out.byAccn[f.accn]) out.byAccn[f.accn] = f.val;
        out.list.push({ end: f.end, val: f.val, accn: f.accn });
      }
      if (out.list.length) break; // dei found: no need for the balance-sheet concept
    } catch (err) {
      if (err.status !== 404) console.warn(`companyconcept ${concept} for CIK ${cik}: ${err.message}`);
    }
  }
  out.list.sort((a, b) => (a.end < b.end ? -1 : 1));
  store.putKV(key, out);
  return out;
}

// Currency the statements are reported in (most common monetary unit on the income statement).
async function reportingCurrency(client, company, year, period) {
  const f = pickFiling(company.filings, { year, period }) || company.filings[0];
  if (!f) return 'USD';
  try {
    const data = await scrapeFiling(client, f, company);
    const counts = {};
    for (const stmt of [data.statements.income_statement, data.statements.balance_sheet]) {
      for (const li of stmt?.lineItems || []) for (const cell of Object.values(li.values)) if (/^[A-Z]{3}$/.test(cell.unit || '')) counts[cell.unit] = (counts[cell.unit] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'USD';
  } catch {
    return 'USD';
  }
}

// Sum of a flow concept over the `len` points ending at i (null if any is missing).
function sumFlows(points, i, len, keys) {
  let total = 0;
  for (let k = i - len + 1; k <= i; k++) {
    const x = first(points[k]?.flows, keys);
    if (x == null) return null;
    total += x;
  }
  return total;
}

export const MULTIPLES = [
  { key: 'pe', name: '本益比 P/E', formula: '股價 ÷ 近四季稀釋 EPS', metric: 'eps', kind: 'price' },
  { key: 'pb', name: '股價淨值比 P/B', formula: '股價 ÷ 每股淨值（歸屬母公司股東權益 ÷ 流通股數）', metric: 'bvps', kind: 'price' },
  { key: 'ps', name: '股價營收比 P/S', formula: '市值 ÷ 近四季營業收入', metric: 'revenueps', kind: 'price' },
  { key: 'pocf', name: '股價營業現金流比 P/OCF', formula: '市值 ÷ 近四季營業活動現金流量', metric: 'ocfps', kind: 'price' },
  { key: 'pfcf', name: '股價自由現金流比 P/FCF', formula: '市值 ÷ 近四季自由現金流（營業現金流量 − 資本支出）', metric: 'fcfps', kind: 'price' },
  { key: 'evEbitda', name: 'EV / EBITDA', formula: '企業價值（市值 + 有息負債 − 現金及短期投資）÷ 近四季 EBITDA（營業利益 + 折舊攤銷）', metric: 'ebitdaps', kind: 'ev' },
  { key: 'evSales', name: 'EV / 營收', formula: '企業價值 ÷ 近四季營業收入', metric: 'revenueps', kind: 'ev' },
  { key: 'divYield', name: '現金股利殖利率', formula: '近四季每股現金股利 ÷ 股價', metric: 'dps', kind: 'yield', unit: '%' },
  { key: 'earningsYield', name: '盈餘殖利率', formula: '近四季 EPS ÷ 股價（本益比的倒數）', metric: 'eps', kind: 'yield', unit: '%' },
  { key: 'fcfYield', name: '自由現金流殖利率', formula: '近四季每股自由現金流 ÷ 股價', metric: 'fcfps', kind: 'yield', unit: '%' },
];

const stats = (xs) => {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return { n: v.length, avg: v.reduce((a, b) => a + b, 0) / v.length, median: s[Math.floor(s.length / 2)], min: s[0], max: s[s.length - 1] };
};

export async function buildValuation(client, company, { year, period, n = 20, adr = 1 }) {
  const quarterly = company.filings.some((f) => f.fiscalPeriod && f.fiscalPeriod.startsWith('Q'));
  const ticker = company.tickers?.[0] || null;
  const endQ = period === 'FY' ? 4 : Number(period.slice(1));
  const span = quarterly ? 4 : 1; // points per trailing year

  // --- data points, oldest first ------------------------------------------
  let points;
  if (quarterly) {
    const keys = quarterKeys(year, endQ, n + 3);
    const byKey = await loadPoints(client, company, keys, true);
    points = keys.map((k) => byKey[`${k.year}-Q${k.q}`] || { year: k.year, period: `Q${k.q}`, flows: {}, balances: {}, missing: true });
  } else {
    const keys = [];
    for (let i = 0; i < n; i++) keys.unshift({ year: year - i, q: 4 });
    const byKey = await loadPoints(client, company, keys, false);
    points = keys.map((k) => byKey[`${k.year}-FY`] || { year: k.year, period: 'FY', flows: {}, balances: {}, missing: true });
  }

  // --- shares, prices, currency (in parallel) ------------------------------
  const [shares, hist, q, reporting] = await Promise.all([
    sharesByAccession(client, company.cik),
    ticker ? history(ticker).catch((e) => ({ error: e.message, days: [] })) : { days: [] },
    ticker ? quote(ticker).catch((e) => ({ error: e.message, price: null })) : { price: null, error: 'no ticker' },
    reportingCurrency(client, company, year, period),
  ]);
  // statements in another currency than the quote (20-F filers, ADRs): convert
  // per-share figures with the FX rate of each date, times the ADR ratio
  const quoteCurrency = q.currency || 'USD';
  let fxHist = null;
  let fxNow = 1;
  if (reporting !== quoteCurrency) {
    try {
      fxHist = await history(`${reporting}${quoteCurrency}=X`);
      fxNow = fxHist.days.at(-1)?.close ?? 1;
    } catch (err) {
      console.warn(`FX ${reporting}${quoteCurrency}: ${err.message}`);
    }
  }
  const fxOn = (date) => (fxHist ? (closeOn(fxHist, date)?.close ?? fxNow) : 1);
  const toQuote = (ps, fx) => Object.fromEntries(Object.entries(ps).map(([k, v]) => [k, v == null ? null : v * fx * adr]));
  const sharesFor = (pt) => {
    for (const a of pt.sources || []) if (shares.byAccn[a]) return { value: shares.byAccn[a], source: 'cover' };
    if (pt.periodEnd) {
      // nearest cover-page count dated within ~3 months after the period end
      const c = shares.list.find((s) => s.end >= pt.periodEnd && s.end <= addDays(pt.periodEnd, 100));
      if (c) return { value: c.val, source: 'cover' };
    }
    const wa = quarterly && pt.period === 'Q4' ? first(pt.fy, V.dilutedShares) : first(pt.flows, V.dilutedShares);
    return wa ? { value: wa, source: 'diluted' } : null;
  };

  // --- one column per point with a full trailing year ------------------------
  const columns = [];
  for (let i = span - 1; i < points.length; i++) {
    const pt = points[i];
    if (pt.missing) continue;
    const ttm = {
      revenue: sumFlows(points, i, span, C.revenue),
      netIncome: sumFlows(points, i, span, C.netIncome),
      eps: sumFlows(points, i, span, C.eps),
      ocf: sumFlows(points, i, span, C.ocf),
      capex: sumFlows(points, i, span, C.capex),
      dividends: sumFlows(points, i, span, C.dividends),
      ebit: sumFlows(points, i, span, C.operatingIncome),
      da: sumFlows(points, i, span, V.da),
      tax: sumFlows(points, i, span, V.tax),
      pretax: sumFlows(points, i, span, C.pretaxIncome),
    };
    ttm.fcf = ttm.ocf == null ? null : ttm.ocf - nz(ttm.capex);
    ttm.ebitda = ttm.ebit == null ? null : ttm.ebit + nz(ttm.da);
    const b = pt.balances;
    const ltNon = first(b, V.ltDebtNoncurrent);
    const debt = ltNon != null ? ltNon + nz(first(b, V.ltDebtCurrent)) + nz(first(b, V.stBorrowings)) : first(b, V.ltDebtTotal) != null ? first(b, V.ltDebtTotal) + nz(first(b, V.stBorrowings)) : null;
    const goodwill = first(b, V.goodwill);
    const intang = first(b, V.intangibles) ?? (goodwill == null ? first(b, V.intangiblesInclGoodwill) : null);
    const bal = {
      equity: first(b, C.equityParent) ?? first(b, C.equityTotal),
      cash: first(b, C.cash),
      stInvestments: first(b, V.stInvestments),
      debt,
      goodwill,
      intangibles: intang,
      totalAssets: first(b, C.totalAssets),
    };
    const sh = sharesFor(pt);
    const perShare = (x) => (sh && x != null ? x / sh.value : null);
    const ps = {
      eps: ttm.eps,
      bvps: perShare(bal.equity),
      tbvps: bal.equity == null ? null : perShare(bal.equity - nz(bal.goodwill) - nz(bal.intangibles)),
      revenueps: perShare(ttm.revenue),
      ocfps: perShare(ttm.ocf),
      fcfps: perShare(ttm.fcf),
      ebitps: perShare(ttm.ebit),
      ebitdaps: perShare(ttm.ebitda),
      daps: perShare(ttm.da),
      capexps: perShare(ttm.capex),
      dps: perShare(ttm.dividends),
      cashps: perShare(bal.cash == null && bal.stInvestments == null ? null : nz(bal.cash) + nz(bal.stInvestments)),
      debtps: perShare(bal.debt),
    };
    const fx = fxOn(pt.periodEnd);
    const psq = toQuote(ps, fx); // per ADR / share, in the quote currency
    const netDebtPs = psq.cashps == null && psq.debtps == null ? null : nz(psq.debtps) - nz(psq.cashps);
    const close = closeOn(hist, pt.periodEnd);
    // the day the statements became public: the filing date of the point's main source
    const filingDate = company.filings.find((f) => f.accession === pt.sources?.[0])?.filingDate || null;
    const atFiling = filingDate ? closeOn(hist, filingDate) : null;
    columns.push({
      label: quarterly ? `${pt.year} ${pt.period}` : `FY${pt.year}`,
      year: pt.year,
      period: pt.period,
      periodEnd: pt.periodEnd,
      sources: pt.sources || [],
      price: close?.close ?? null,
      priceDate: close?.date ?? null,
      filingDate,
      priceAtFiling: atFiling?.close ?? null,
      priceAtFilingDate: atFiling?.date ?? null,
      shares: sh?.value ?? null,
      sharesSource: sh?.source ?? null,
      marketCap: sh && close ? (close.close * sh.value) / adr : null,
      fx,
      ttm,
      bal,
      perShare: ps, // reporting currency, per ordinary share
      perShareQuote: psq, // quote currency, per listed share (ADR)
      netDebtPs,
      multiples: multiplesAt(close?.close ?? null, psq, netDebtPs),
    });
  }
  const latest = columns[columns.length - 1] || null;

  // --- today: latest trailing-year figures at the current price --------------
  const price = q.price ?? null;
  const nowPs = latest ? toQuote(latest.perShare, fxNow) : null;
  const nowNetDebt = nowPs ? (nowPs.cashps == null && nowPs.debtps == null ? null : nz(nowPs.debtps) - nz(nowPs.cashps)) : null;
  const now = latest && price != null ? { price, marketCap: latest.shares ? (price * latest.shares) / adr : null, perShare: nowPs, netDebtPs: nowNetDebt, multiples: multiplesAt(price, nowPs, nowNetDebt) } : null;
  const summary = MULTIPLES.map((def) => {
    const st = stats(columns.map((c) => c.multiples[def.key]));
    const current = now?.multiples[def.key] ?? null;
    const imp = (mult) => (nowPs ? impliedPrice(def, mult, nowPs, nowNetDebt) : null);
    return {
      ...def,
      current,
      ...(st || { n: 0, avg: null, median: null, min: null, max: null }),
      fair: st ? imp(st.avg) : null,
      fairMedian: st ? imp(st.median) : null,
      cheap: st ? imp(def.kind === 'yield' ? st.max : st.min) : null,
      dear: st ? imp(def.kind === 'yield' ? st.min : st.max) : null,
    };
  });

  // --- absolute models -----------------------------------------------------
  const years = columns.length > 1 ? (columns.length - 1) / span : null;
  const firstCol = columns[0];
  const growth = latest && firstCol && years
    ? {
        years,
        revenue: cagr(firstCol.ttm.revenue, latest.ttm.revenue, years),
        eps: cagr(firstCol.ttm.eps, latest.ttm.eps, years),
        fcf: cagr(firstCol.ttm.fcf, latest.ttm.fcf, years),
        dps: cagr(firstCol.perShare.dps, latest.perShare.dps, years),
        bvps: cagr(firstCol.perShare.bvps, latest.perShare.bvps, years),
      }
    : null;
  const taxRate = latest && latest.ttm.tax != null && latest.ttm.pretax > 0 ? clamp(latest.ttm.tax / latest.ttm.pretax, 0.1, 0.3) : 0.21;
  const g1 = clamp(growth?.revenue ?? growth?.eps ?? 0.05, 0, 0.15);
  const assumptions = { r: 0.09, g1: Math.round(g1 * 1000) / 1000, gT: 0.025, years: 5, taxRate: Math.round(taxRate * 1000) / 1000, aaaYield: 4.5, gGraham: Math.round(g1 * 1000) / 10 };
  const inputs = latest
    ? {
        ...nowPs,
        roe: latest.bal.equity ? latest.ttm.netIncome / latest.bal.equity : null,
        payout: latest.ttm.netIncome > 0 && latest.ttm.dividends != null ? latest.ttm.dividends / latest.ttm.netIncome : 0,
        taxRate,
      }
    : null;
  const absolute = inputs ? runModels(inputs, assumptions) : null;

  // is the chosen period the company's newest filing? (then today's price is the natural basis)
  const newest = company.filings.find((f) => !f.form.toUpperCase().endsWith('/A')) || company.filings[0];
  const chosen = pickFiling(company.filings, { year, period });
  const isLatest = !!newest && !!chosen && newest.accession === chosen.accession;

  return {
    fetchedAt: new Date().toISOString(),
    company: { cik: company.cik, name: company.name, ticker },
    quarterly,
    end: { year, period },
    isLatest,
    quote: { ...q, source: q.source || null },
    currency: { reporting, quote: quoteCurrency, fxNow: reporting === quoteCurrency ? 1 : fxNow, fxSource: fxHist ? `${reporting}${quoteCurrency}=X` : null, adr },
    nowPerShare: nowPs,
    priceHistory: { source: hist.source || null, from: hist.days?.[0]?.date || null, to: hist.days?.at?.(-1)?.date || null, splits: hist.splits || [], error: hist.error || null },
    shares: latest ? { value: latest.shares, source: latest.sharesSource, asOf: latest.periodEnd } : null,
    columns,
    now,
    multiples: MULTIPLES,
    summary,
    growth,
    assumptions,
    inputs,
    models: MODELS.map(({ key, name, formula }) => ({ key, name, formula })),
    absolute,
  };
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
