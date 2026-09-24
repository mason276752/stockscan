// Valuation page: relative multiples over time (with the price quoted at each
// quarter end) and absolute models (DCF, DDM, RIM, EPV, Graham …) on the
// trailing-twelve-month figures of the chosen quarter and today's price.
//
// Financial inputs come from the same quarterly points as the indicators
// page. What else it needs comes through `deps`, so the server and the
// static build share this file (no Node I/O here):
//   load(filing)    -> the filing's data (scrapeFiling / the saved file)
//   shares(cik)     -> a structured cover-share index from SEC's companyconcept
//                      API on the server; stored parsed cover facts carried by
//                      the points below always win. When neither has a safe
//                      count, the filing's diluted weighted-average shares stand in.
//   prices(ticker)  -> { symbol, source, currency, days: [{ date, close }],
//                      splits, dividends?, fetchedAt, error?, eventsError? }
//                      daily closes as the sources give them (split-adjusted
//                      to today); splits: [{ date, ratio }] undoes them so
//                      old prices line up with the EPS and share counts of old
//                      filings, null when unknown - then the splits are
//                      inferred from the jumps in the filings' share counts
//   fx(pair)        -> { days: [{ date, close }] } for e.g. 'TWDUSD=X', or
//                      null when there is no FX data (the figures then stay in
//                      the reporting currency, flagged in `currency`)

import { C, first, loadPoints, quarterKeys } from './indicators.ts';
import { pickFiling } from './filings.ts';
import { coverSharesFor, indexCoverShares, mergeCoverShareIndexes } from './coverShares.ts';
import { MODELS, cagr, clamp, impliedPrice, multiplesAt, runModels } from '../../shared/valuation.ts';
import type { MultipleDef, Multiples, PerShare, ValuationAssumptions, ValuationInputs } from '../../shared/valuation.ts';
import type { FilingLoader } from './quarters.ts';
import type { Company, Concept, CoverShareIndex, IsoDate, QuarterPoint } from './types.ts';
import type { SplitEvent } from './prices.ts';

/** Daily closes, as a price source hands them over. */
export interface PriceDays {
  symbol?: string;
  source?: string | null;
  currency?: string | null;
  days: { date: IsoDate; close: number }[];
  splits?: SplitEvent[] | null;
  dividends?: unknown[];
  fetchedAt?: string | null;
  error?: string;
  eventsError?: string | null;
  headMissing?: boolean;
}

/**
 * What only the caller can fetch. The server reaches SEC and Yahoo; the
 * static build reads the files the site shipped.
 */
export interface ValuationDeps {
  load: FilingLoader;
  shares: (cik: number) => Promise<CoverShareIndex>;
  prices: (ticker: string) => Promise<PriceDays>;
  fx: (pair: string) => Promise<PriceDays | null>;
}

/** Which period to value, over how many points, and the ADR ratio. */
export interface ValuationOptions {
  year: number;
  period: string;
  n?: number;
  /** ordinary shares per listed share */
  adr?: number;
}

/** The share count used for a point, and where it came from. */
export interface ShareCount {
  value: number;
  source: string;
}

/** Trailing-twelve-month totals of one column. */
export interface TtmFigures {
  revenue: number | null;
  netIncome: number | null;
  eps: number | null;
  ocf: number | null;
  capex: number | null;
  dividends: number | null;
  ebit: number | null;
  da: number | null;
  tax: number | null;
  pretax: number | null;
  fcf?: number | null;
  ebitda?: number | null;
}

/** The balances one column is priced against. */
export interface BalanceFigures {
  equity: number | null;
  cash: number | null;
  stInvestments: number | null;
  debt: number | null;
  goodwill: number | null;
  intangibles: number | null;
  totalAssets: number | null;
}

/** One quarter end: the figures, the price then, and the multiples. */
export interface ValuationColumn {
  label: string;
  year: number;
  period: string;
  periodEnd: IsoDate | null;
  sources: string[];
  price: number | null;
  priceDate: IsoDate | null;
  filingDate: IsoDate | null;
  priceAtFiling: number | null;
  priceAtFilingDate: IsoDate | null;
  shares: number | null;
  sharesSource: string | null;
  marketCap: number | null;
  fx: number;
  ttm: TtmFigures;
  bal: BalanceFigures;
  perShare: PerShare;
  perShareQuote: PerShare;
  netDebtPs: number | null;
  multiples: Multiples;
}

/** Simple statistics of one multiple over the columns. */
interface MultipleStats {
  n: number;
  avg: number;
  median: number;
  min: number;
  max: number;
}

// extra concepts beyond the indicators table
const V: Record<string, Concept[]> = {
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

const nz = (x: number | null | undefined) => x ?? 0;

// Close on or before a date (null when the history does not reach it).
export function closeOn<T extends { date: IsoDate }>(hist: { days: readonly T[] } | null | undefined, date: IsoDate | null | undefined): T | null {
  if (!hist || !date) return null;
  let best: T | null = null;
  for (const d of hist.days) {
    if (d.date > date) break;
    best = d;
  }
  return best;
}

// Split-adjusted closes -> the prices quoted on each day: every split after
// the day is undone (a 4:1 split later multiplies the day's price by 4).
const unadjusted = (days: readonly { date: IsoDate; close: number }[], splits: readonly SplitEvent[]) =>
  days.map((d) => {
    let factor = 1;
    for (const s of splits) if (s.date > d.date) factor *= s.ratio;
    return { date: d.date, adjClose: d.close, close: d.close * factor };
  });

// Splits inferred from the share counts of consecutive filings when no
// split events are known: a jump by (about) a whole ratio - 2:1 … 100:1, or a
// reverse split 1:2 … 1:100 - between two points is taken as a split dated
// the day after the earlier period (buybacks and issues move the count by a
// few percent, not by half or double). A 3:2 or 5:4 split is not caught.
export function inferSplits(points: readonly QuarterPoint[], sharesOf: (pt: QuarterPoint) => number | null | undefined): SplitEvent[] {
  const out: SplitEvent[] = [];
  let prev: { n: number; periodEnd: IsoDate } | null = null;
  for (const pt of points) {
    const n = sharesOf(pt);
    if (!(n! > 0) || !pt.periodEnd) continue;
    if (prev && prev.n > 0) {
      const r = n! / prev.n;
      const ratio = r >= 1 ? Math.round(r) : 1 / Math.round(1 / r);
      if (ratio !== 1 && (r >= 1.85 || r <= 0.54) && Math.abs(r / ratio - 1) < 0.08) out.push({ date: addDays(prev.periodEnd, 1), ratio });
    }
    prev = { n: n!, periodEnd: pt.periodEnd };
  }
  return out;
}

// Currency the statements are reported in (most common monetary unit on the income statement).
async function reportingCurrency(load: FilingLoader, company: Company, year: number, period: string): Promise<string> {
  const f = pickFiling(company.filings, { year, period }) || company.filings[0];
  if (!f) return 'USD';
  try {
    const data = await load(f);
    const counts: Record<string, number> = {};
    for (const stmt of [data.statements.income_statement, data.statements.balance_sheet]) {
      for (const li of stmt?.lineItems || []) for (const cell of Object.values(li.values)) if (/^[A-Z]{3}$/.test(cell.unit || '')) counts[cell.unit!] = (counts[cell.unit!] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'USD';
  } catch {
    return 'USD';
  }
}

// Sum of a flow concept over the `len` points ending at i (null if any is missing).
function sumFlows(points: readonly QuarterPoint[], i: number, len: number, keys: readonly Concept[]): number | null {
  let total = 0;
  for (let k = i - len + 1; k <= i; k++) {
    const x = first(points[k]?.flows, keys);
    if (x == null) return null;
    total += x;
  }
  return total;
}

/** One multiple the page charts, with the per-share figure behind it. */
export interface MultipleRow extends MultipleDef {
  key: string;
  name: string;
  formula: string;
  unit?: string;
}

export const MULTIPLES: MultipleRow[] = [
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

const stats = (xs: readonly (number | null | undefined)[]): MultipleStats | null => {
  const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return { n: v.length, avg: v.reduce((a, b) => a + b, 0) / v.length, median: s[Math.floor(s.length / 2)]!, min: s[0]!, max: s[s.length - 1]! };
};

export async function buildValuation(company: Company, { year, period, n = 20, adr = 1 }: ValuationOptions, deps: ValuationDeps) {
  const { load } = deps;
  const quarterly = company.filings.some((f) => f.fiscalPeriod && f.fiscalPeriod.startsWith('Q'));
  const ticker = company.tickers?.[0] || null;
  const endQ = period === 'FY' ? 4 : Number(period.slice(1));
  const span = quarterly ? 4 : 1; // points per trailing year

  // --- data points, oldest first ------------------------------------------
  let points: (QuarterPoint & { year: number })[];
  if (quarterly) {
    const keys = quarterKeys(year, endQ, n + 3);
    const byKey = await loadPoints(load, company, keys, true);
    points = keys.map((k) => byKey[`${k.year}-Q${k.q}`] || { year: k.year, period: `Q${k.q}`, periodEnd: null, sources: [], flows: {}, balances: {}, missing: true });
  } else {
    const keys: { year: number; q: number }[] = [];
    for (let i = 0; i < n; i++) keys.unshift({ year: year - i, q: 4 });
    const byKey = await loadPoints(load, company, keys, false);
    points = keys.map((k) => byKey[`${k.year}-FY`] || { year: k.year, period: 'FY', periodEnd: null, sources: [], flows: {}, balances: {}, missing: true });
  }

  // --- shares, prices, currency (in parallel) ------------------------------
  // The saved parser facts work in both server and static builds. The server's
  // companyconcept response is only a fallback for older saved filings.
  const savedShares = indexCoverShares(points.flatMap((pt) => pt.coverShares || []));
  const [externalShares, raw, reporting] = await Promise.all([
    deps.shares(company.cik).catch((): CoverShareIndex => ({ version: 2, byAccn: {}, list: [] })),
    ticker ? deps.prices(ticker).catch((e): PriceDays => ({ error: (e as Error).message, days: [] })) : Promise.resolve<PriceDays>({ error: 'no ticker', days: [] }),
    reportingCurrency(load, company, year, period),
  ]);
  const shares = mergeCoverShareIndexes(savedShares, externalShares);
  const sharesFor = (pt: QuarterPoint): ShareCount | null => {
    const cover = coverSharesFor(shares, pt);
    if (cover) return { value: cover.value, source: cover.source };
    const wa = quarterly && pt.period === 'Q4' ? first(pt.fy, V.dilutedShares) : first(pt.flows, V.dilutedShares);
    return wa ? { value: wa, source: 'diluted' } : null;
  };
  // the closes as quoted on each day: the known splits undone, else the ones the share counts betray
  const splits = raw.splits ?? inferSplits(points, (pt) => sharesFor(pt)?.value);
  const hist = { ...raw, splits, splitsInferred: raw.splits == null, days: unadjusted(raw.days || [], splits), last: null as { date: IsoDate; adjClose: number; close: number } | null };
  hist.last = hist.days.at(-1) || null;
  const q = hist.last
    ? { symbol: hist.symbol, price: hist.last.close, time: `${hist.last.date}T21:00:00Z`, date: hist.last.date, currency: hist.currency, source: hist.source, live: false }
    : { price: null, error: hist.error || 'no price data', source: null };
  // statements in another currency than the quote (20-F filers, ADRs): convert
  // per-share figures with the FX rate of each date, times the ADR ratio
  const quoteCurrency = q.currency || 'USD';
  let fxHist: PriceDays | null = null;
  let fxNow = 1;
  if (reporting !== quoteCurrency) {
    try {
      fxHist = await deps.fx(`${reporting}${quoteCurrency}=X`);
      fxNow = fxHist?.days.at(-1)?.close ?? 1;
    } catch (err) {
      console.warn(`FX ${reporting}${quoteCurrency}: ${(err as Error).message}`);
    }
  }
  const fxOn = (date: IsoDate | null) => (fxHist ? (closeOn(fxHist, date)?.close ?? fxNow) : 1);
  const toQuote = (ps: PerShare, fx: number): PerShare => Object.fromEntries(Object.entries(ps).map(([k, v]) => [k, v == null ? null : v * fx * adr]));

  // a per-share flow of an earlier point on the share basis of a later one:
  // the splits between the two period ends undone (a quarter's EPS reported
  // before a 4:1 split is a quarter of itself after it)
  const splitFactor = (from: IsoDate | null, to: IsoDate | null) => {
    let f = 1;
    for (const s of splits) if (s.date > from! && s.date <= to!) f *= s.ratio;
    return f;
  };
  const sumPerShare = (i: number, len: number, keys: readonly Concept[]): number | null => {
    let total = 0;
    for (let k = i - len + 1; k <= i; k++) {
      const x = first(points[k]?.flows, keys);
      if (x == null) return null;
      total += x / splitFactor(points[k]!.periodEnd, points[i]!.periodEnd);
    }
    return total;
  };

  // --- one column per point with a full trailing year ------------------------
  const columns: ValuationColumn[] = [];
  for (let i = span - 1; i < points.length; i++) {
    const pt = points[i]!;
    if (pt.missing) continue;
    const ttm: TtmFigures = {
      revenue: sumFlows(points, i, span, C.revenue),
      netIncome: sumFlows(points, i, span, C.netIncome),
      eps: sumPerShare(i, span, C.eps),
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
    const debt = ltNon != null ? ltNon + nz(first(b, V.ltDebtCurrent!)) + nz(first(b, V.stBorrowings!)) : first(b, V.ltDebtTotal!) != null ? first(b, V.ltDebtTotal!)! + nz(first(b, V.stBorrowings!)) : null;
    const goodwill = first(b, V.goodwill);
    const intang = first(b, V.intangibles) ?? (goodwill == null ? first(b, V.intangiblesInclGoodwill) : null);
    const bal: BalanceFigures = {
      equity: first(b, C.equityParent) ?? first(b, C.equityTotal),
      cash: first(b, C.cash),
      stInvestments: first(b, V.stInvestments),
      debt,
      goodwill,
      intangibles: intang,
      totalAssets: first(b, C.totalAssets),
    };
    const sh = sharesFor(pt);
    const perShare = (x: number | null | undefined) => (sh && x != null ? x / sh.value : null);
    const ps: PerShare = {
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
    const imp = (mult: number | null) => (nowPs ? impliedPrice(def, mult, nowPs, nowNetDebt) : null);
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
  // per-share figures of the first column are on the share basis of its own
  // filing: the splits since then have to be undone before they can be
  // compared with the latest (20 years of EPS across a 20:1 split is not a
  // 29 % a year decline). Totals need nothing.
  const wasSplit = firstCol && latest ? splitFactor(firstCol.periodEnd, latest.periodEnd) : 1;
  const onLatestBasis = (x: number | null | undefined) => (x == null ? null : x / wasSplit);
  const growth = latest && firstCol && years
    ? {
        years,
        revenue: cagr(firstCol.ttm.revenue, latest.ttm.revenue, years),
        eps: cagr(onLatestBasis(firstCol.ttm.eps), latest.ttm.eps, years),
        fcf: cagr(firstCol.ttm.fcf, latest.ttm.fcf, years),
        dps: cagr(onLatestBasis(firstCol.perShare.dps), latest.perShare.dps, years),
        bvps: cagr(onLatestBasis(firstCol.perShare.bvps), latest.perShare.bvps, years),
      }
    : null;
  const taxRate = latest && latest.ttm.tax != null && latest.ttm.pretax! > 0 ? clamp(latest.ttm.tax / latest.ttm.pretax!, 0.1, 0.3)! : 0.21;
  const g1 = clamp(growth?.revenue ?? growth?.eps ?? 0.05, 0, 0.15)!;
  const assumptions: ValuationAssumptions = { r: 0.09, g1: Math.round(g1 * 1000) / 1000, gT: 0.025, years: 5, taxRate: Math.round(taxRate * 1000) / 1000, aaaYield: 4.5, gGraham: Math.round(g1 * 1000) / 10 };
  const inputs: ValuationInputs | null = latest
    ? {
        ...nowPs,
        roe: latest.bal.equity ? latest.ttm.netIncome! / latest.bal.equity : null,
        payout: latest.ttm.netIncome! > 0 && latest.ttm.dividends != null ? latest.ttm.dividends / latest.ttm.netIncome! : 0,
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
    // fxMissing: another reporting currency but no rate - the per-share figures are still in it
    currency: { reporting, quote: quoteCurrency, fxNow: reporting === quoteCurrency ? 1 : fxNow, fxSource: fxHist ? `${reporting}${quoteCurrency}=X` : null, fxMissing: reporting !== quoteCurrency && !fxHist, adr },
    nowPerShare: nowPs,
    priceHistory: { source: hist.source || null, from: hist.days[0]?.date || null, to: hist.last?.date || null, splits: hist.splits, splitsInferred: hist.splitsInferred, headMissing: !!hist.headMissing, error: hist.error || null, eventsError: hist.eventsError || null, fetchedAt: hist.fetchedAt || null },
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

function addDays(date: IsoDate, days: number): IsoDate {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** What buildValuation() answers with, for the page that renders it. */
export type Valuation = Awaited<ReturnType<typeof buildValuation>>;
