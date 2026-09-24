// Quarterly view for one fiscal year: Q1, Q2, Q3 from the 10-Qs, FY from the
// 10-K, and Q4 derived as FY − Q1 − Q2 − Q3 (equivalently FY − nine-month YTD).
//
// 10-Q flow statements report either three-month columns, year-to-date
// columns or both; cash flow statements are usually YTD only. So each quarter
// is computed from cumulative amounts: C1..C3 come from the 10-Qs (YTD column
// if present, otherwise previous cumulative + three-month column), C4 is the
// 10-K, and Qn = Cn − Cn−1. Balance sheets are point-in-time, so their
// quarterly columns are simply the period-end balances of each filing.

import { pickFiling } from './filings.ts';
import { SIBLINGS } from './concepts.ts';
import type {
  Company, Concept, Facts, FilingRef, IsoDate, LineItem, PrimaryType, QuarterCell, QuarterColumn, QuarterKey,
  QuarterLineItem, QuarterPoint, QuarterStatement, QuarterlyResult, ScrapeResult, Statement, StatementColumn, StatementType,
} from './types.ts';

const QUARTERS: QuarterKey[] = ['Q1', 'Q2', 'Q3'];
const TYPES: StatementType[] = ['balance_sheet', 'income_statement', 'comprehensive_income', 'cash_flow'];
const DAY = 86400000;

/** Loads the parsed filing behind a list entry. */
export type FilingLoader = (f: FilingRef) => Promise<ScrapeResult>;

export const dimKey = (dims: Record<Concept, Concept>): string =>
  Object.entries(dims)
    .sort()
    .map(([k, v]) => `${k}=${v}`)
    .join('|');
export const near = (a: IsoDate | null | undefined, b: IsoDate | null | undefined, days = 4): boolean =>
  !!a && !!b && Math.abs(new Date(a).getTime() - new Date(b).getTime()) <= days * DAY;
export const months = (start: IsoDate | null | undefined, end: IsoDate | null | undefined): number =>
  Math.round((new Date(end!).getTime() - new Date(start!).getTime()) / DAY / 30.4375);

// currency amounts subtract exactly; per-share amounts only approximately
// (weighted shares differ by period); share counts and ratios not at all.
/** How far amounts of this unit may be subtracted between periods. */
type Subtractability = 'exact' | 'approx' | 'none';

function subtractability(unit: string | null | undefined): Subtractability {
  if (!unit) return 'none';
  if (unit.includes('/')) return 'approx';
  if (unit === 'shares' || unit === 'pure') return 'none';
  return 'exact';
}

export function statementOf(data: ScrapeResult | null | undefined, type: StatementType): Statement | null {
  if (!data) return null;
  if (type === 'comprehensive_income') return data.allStatements.find((s) => s.type === type && !s.parenthetical) || null;
  return data.statements[type as PrimaryType];
}

/** How to pick one column out of a statement. */
export interface ColumnQuery {
  dims: string;
  instant?: IsoDate | null;
  end?: IsoDate | null;
  start?: IsoDate | null;
  monthsLen?: number;
}

export function findColumn(stmt: Statement | null, { dims, instant, end, start, monthsLen }: ColumnQuery): StatementColumn | null {
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
export const SYNONYMS = [
  ['us-gaap:Revenues', 'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax', 'us-gaap:SalesRevenueNet'],
  ['us-gaap:CostOfRevenue', 'us-gaap:CostOfGoodsAndServicesSold'],
  ['us-gaap:PropertyPlantAndEquipmentNet', 'us-gaap:PropertyPlantAndEquipmentAndFinanceLeaseRightOfUseAssetAfterAccumulatedDepreciationAndAmortization'],
].reduce<Record<Concept, Concept[]>>((m, group) => {
  for (const c of group) m[c] = group;
  return m;
}, {});
const normLabel = (l: string | null | undefined) => (l || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function findRow(stmt: Statement, fyRow: { concept: Concept; label: string | null }): LineItem | null {
  const rows = stmt.lineItems.filter((li) => !li.abstract);
  return (
    rows.find((li) => li.concept === fyRow.concept) ||
    rows.find((li) => normLabel(li.label) === normLabel(fyRow.label)) ||
    rows.find((li) => (SYNONYMS[fyRow.concept] || []).includes(li.concept)) ||
    null
  );
}

function valueOf(stmt: Statement | null, fyRow: { concept: Concept; label: string | null }, colId: string | null | undefined) {
  if (!stmt || !colId) return undefined;
  const row = findRow(stmt, fyRow);
  const cell = row?.values[colId];
  return cell && typeof cell.value === 'number' ? cell : undefined;
}

function buildStatementQuarters(type: StatementType, docs: Record<QuarterKey, ScrapeResult>, filings: Record<QuarterKey, FilingRef>): QuarterStatement | null {
  const fy = statementOf(docs.FY, type);
  if (!fy) return null;
  const fyEnd = filings.FY.reportDate;
  const isInstant = type === 'balance_sheet';

  // Current-year columns of the 10-K, grouped by dimension.
  let fyStart: IsoDate | null = null;
  const groups: { dims: string; dimensions: Record<Concept, Concept>; fyCol: string }[] = [];
  for (const c of fy.columns) {
    if (isInstant) {
      if (c.period.instant && near(c.period.instant, fyEnd)) groups.push({ dims: dimKey(c.dimensions), dimensions: c.dimensions, fyCol: c.id });
    } else if (c.period.end && near(c.period.end, fyEnd) && months(c.period.start, c.period.end) === 12) {
      fyStart ||= c.period.start!;
      groups.push({ dims: dimKey(c.dimensions), dimensions: c.dimensions, fyCol: c.id });
    }
  }
  if (!groups.length) return null;

  const columns: QuarterColumn[] = [];
  const lineItems: QuarterLineItem[] = fy.lineItems.map((li) => ({
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
    const qCols = QUARTERS.map((q, i): { direct?: StatementColumn | null; ytd?: StatementColumn | null; three?: StatementColumn | null; end: IsoDate | null } => {
      const end = filings[q]!.reportDate;
      const stmt = qStmts[i]!;
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
          label: QUARTERS[i]!,
          period: { instant: qc.end },
          dimensions: g.dimensions,
          derived: false,
          source: filings[QUARTERS[i]!]!.accession,
        }),
      );
      columns.push({ id: `q4${sfx}`, label: 'Q4', period: { instant: fyEnd }, dimensions: g.dimensions, derived: false, source: filings.FY.accession });
    } else {
      qCols.forEach((qc, i) =>
        columns.push({
          id: `q${i + 1}${sfx}`,
          label: QUARTERS[i]!,
          period: { start: i === 0 ? fyStart : qCols[i - 1]!.end, end: qc.end },
          dimensions: g.dimensions,
          derived: i > 0, // may be computed from YTD differences
          source: filings[QUARTERS[i]!]!.accession,
        }),
      );
      columns.push({ id: `q4${sfx}`, label: 'Q4', period: { start: qCols[2]!.end, end: fyEnd }, dimensions: g.dimensions, derived: true, source: filings.FY.accession });
      columns.push({ id: `fy${sfx}`, label: 'FY', period: { start: fyStart, end: fyEnd }, dimensions: g.dimensions, derived: false, source: filings.FY.accession });
    }

    for (const li of lineItems) {
      if (li.abstract) continue;
      const fyCell = valueOf(fy, li, g.fyCol);

      if (isInstant) {
        qCols.forEach((qc, i) => {
          const cell = valueOf(qStmts[i]!, li, qc.direct?.id);
          if (cell) li.values[`q${i + 1}${sfx}`] = { value: cell.value as number, unit: cell.unit, raw: cell.raw, factId: cell.factId };
        });
        if (fyCell) li.values[`q4${sfx}`] = { value: fyCell.value as number, unit: fyCell.unit, raw: fyCell.raw, factId: fyCell.factId };
        continue;
      }

      const unit = fyCell?.unit || valueOf(qStmts[0]!, li, qCols[0]!.ytd?.id || qCols[0]!.three?.id)?.unit;
      const mode = subtractability(unit);
      const cum: (number | undefined)[] = [0]; // cumulative amounts C0..C4 (undefined = unknown)
      const cellFor = (value: number, derived: boolean): QuarterCell => ({ value, unit, derived, ...(derived && mode === 'approx' ? { approx: true as const } : {}) });

      qCols.forEach((qc, i) => {
        const ytd = valueOf(qStmts[i]!, li, qc.ytd?.id);
        const three = valueOf(qStmts[i]!, li, qc.three?.id);
        const prev = cum[i];
        let c: number | undefined;
        if (ytd) c = ytd.value as number;
        else if (three && prev !== undefined && mode !== 'none') c = prev + (three.value as number);
        else if (three && i === 0) c = three.value as number;
        cum[i + 1] = c;

        if (three) li.values[`q${i + 1}${sfx}`] = cellFor(three.value as number, false);
        else if (ytd && i === 0) li.values[`q1${sfx}`] = cellFor(ytd.value as number, false);
        else if (ytd && prev !== undefined && mode !== 'none') li.values[`q${i + 1}${sfx}`] = cellFor((ytd.value as number) - prev, true);
      });

      if (fyCell) {
        li.values[`fy${sfx}`] = { value: fyCell.value as number, unit, raw: fyCell.raw, factId: fyCell.factId };
        if (cum[3] !== undefined && mode !== 'none') li.values[`q4${sfx}`] = cellFor((fyCell.value as number) - cum[3], true);
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

// `load(filing)` resolves to the parsed filing (the server scrapes / reads
// its store; the browser build fetches the saved file)
export async function buildQuarterly(load: FilingLoader, company: Company, year: number | string): Promise<QuarterlyResult> {
  const filings = {} as Record<QuarterKey, FilingRef>;
  const missing: QuarterKey[] = [];
  for (const p of [...QUARTERS, 'FY'] as QuarterKey[]) {
    filings[p] = pickFiling(company.filings, { year, period: p })!;
    if (!filings[p]) missing.push(p);
  }
  if (missing.length) {
    throw Object.assign(new Error(`FY${year} is missing ${missing.join(', ')} filings; cannot derive Q4.`), { status: 404 });
  }
  const docs = {} as Record<QuarterKey, ScrapeResult>;
  await Promise.all(
    (Object.entries(filings) as [QuarterKey, FilingRef][]).map(async ([p, f]) => {
      docs[p] = await load(f);
    }),
  );

  const statements: Record<PrimaryType, QuarterStatement | null> = { balance_sheet: null, income_statement: null, cash_flow: null, equity: null };
  const all: QuarterStatement[] = [];
  for (const type of TYPES) {
    const st = buildStatementQuarters(type, docs, filings);
    if (!st) continue;
    all.push(st);
    if (type in statements) statements[type as PrimaryType] = st;
  }

  return {
    fetchedAt: new Date().toISOString(),
    derived: true,
    filing: {
      cik: company.cik,
      companyName: company.name,
      form: 'Q4*',
      filingDate: filings.FY.filingDate,
      periodEnd: filings.FY.reportDate,
      fiscalYear: String(year),
      fiscalPeriod: 'Q4',
      accession: `q4-${year}`,
      viewerUrl: filings.FY.viewerUrl,
      indexUrl: filings.FY.indexUrl,
    },
    sources: Object.fromEntries(
      (Object.entries(filings) as [QuarterKey, FilingRef][]).map(([p, f]) => [p, { form: f.form, accession: f.accession, reportDate: f.reportDate, filingDate: f.filingDate, viewerUrl: f.viewerUrl }]),
    ),
    statements,
    allStatements: all,
    stats: { facts: Object.values(docs).reduce((n: number, d) => n + d.stats.facts, 0), contexts: 0, statementRoles: all.length },
  };
}

// ---------------------------------------------------------------------------
// Generic per-year extraction used by the indicators page: every undimensioned
// numeric fact of the flow statements and the balance sheet, per quarter.
// Works with any subset of {Q1, Q2, Q3, FY}; Q4 flows need FY plus a cumulative
// nine-month figure (Q3 YTD, or Q1..Q3 three-month columns).

const FLOW_TYPES: StatementType[] = ['income_statement', 'comprehensive_income', 'cash_flow'];
// A filer's own extension element that merely re-spells a standard one
// (BGMS:CostOfSales, ABC:TotalRevenues) counts as the standard concept when
// the filing has no standard one - the ratios look them up by standard name.
const EXT_ALIASES: Record<string, Concept> = {
  CostOfSales: 'us-gaap:CostOfRevenue',
  CostOfRevenue: 'us-gaap:CostOfRevenue',
  CostOfRevenues: 'us-gaap:CostOfRevenue',
  TotalCostOfRevenue: 'us-gaap:CostOfRevenue',
  TotalCostOfRevenues: 'us-gaap:CostOfRevenue',
  TotalCostOfSales: 'us-gaap:CostOfRevenue',
  CostOfGoodsSold: 'us-gaap:CostOfGoodsSold',
  CostOfGoodsAndServicesSold: 'us-gaap:CostOfGoodsAndServicesSold',
  CostOfServices: 'us-gaap:CostOfServices',
  CostOfProductsSold: 'us-gaap:CostOfGoodsSold',
  CostOfServicesExcludingDepreciationAndAmortization: 'us-gaap:CostOfServicesExcludingDepreciationDepletionAndAmortization',
  CostOfRevenueExcludingDepreciationAndAmortization: 'us-gaap:CostOfGoodsAndServiceExcludingDepreciationDepletionAndAmortization',
  CostOfGoodsSoldExcludingDepreciationAndAmortization: 'us-gaap:CostOfGoodsSoldExcludingDepreciationDepletionAndAmortization',
  CostOfSalesExcludingDepreciationAndAmortization: 'us-gaap:CostOfGoodsAndServiceExcludingDepreciationDepletionAndAmortization',
  Revenues: 'us-gaap:Revenues',
  Revenue: 'us-gaap:Revenues',
  TotalRevenues: 'us-gaap:Revenues',
  TotalRevenue: 'us-gaap:Revenues',
  NetSales: 'us-gaap:Revenues',
  NetRevenues: 'us-gaap:Revenues',
  NetRevenue: 'us-gaap:Revenues',
  GrossProfit: 'us-gaap:GrossProfit',
  GrossMargin: 'us-gaap:GrossProfit',
  OperatingIncomeLoss: 'us-gaap:OperatingIncomeLoss',
  IncomeLossFromOperations: 'us-gaap:OperatingIncomeLoss',
  OperatingIncome: 'us-gaap:OperatingIncomeLoss',
  NetIncomeLoss: 'us-gaap:NetIncomeLoss',
  NetIncome: 'us-gaap:NetIncomeLoss',
  NetLoss: 'us-gaap:NetIncomeLoss',
  TotalAssets: 'us-gaap:Assets',
  Assets: 'us-gaap:Assets',
  TotalLiabilities: 'us-gaap:Liabilities',
  Liabilities: 'us-gaap:Liabilities',
  TotalCurrentAssets: 'us-gaap:AssetsCurrent',
  AssetsCurrent: 'us-gaap:AssetsCurrent',
  TotalCurrentLiabilities: 'us-gaap:LiabilitiesCurrent',
  LiabilitiesCurrent: 'us-gaap:LiabilitiesCurrent',
  StockholdersEquity: 'us-gaap:StockholdersEquity',
  TotalStockholdersEquity: 'us-gaap:StockholdersEquity',
  TotalShareholdersEquity: 'us-gaap:StockholdersEquity',
  TotalCommonShareholdersEquity: 'us-gaap:StockholdersEquity',
  TotalEquity: 'us-gaap:StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest',
  TotalLiabilitiesAndStockholdersEquity: 'us-gaap:LiabilitiesAndStockholdersEquity',
  LiabilitiesAndStockholdersEquity: 'us-gaap:LiabilitiesAndStockholdersEquity',
  NetCashProvidedByUsedInOperatingActivities: 'us-gaap:NetCashProvidedByUsedInOperatingActivities',
  CashAndCashEquivalents: 'us-gaap:CashAndCashEquivalentsAtCarryingValue',
  InterestExpense: 'us-gaap:InterestExpense',
  InterestExpenseNet: 'us-gaap:InterestExpense',
  InterestAndDebtExpense: 'us-gaap:InterestAndDebtExpense',
  InvestmentAndDebtInterestIncomeExpenseNet: 'us-gaap:InvestmentAndDebtInterestIncomeExpenseNet',
};
const canon = (concept: Concept): Concept => {
  if (SYNONYMS[concept]) return SYNONYMS[concept][0]!;
  const [prefix, local] = concept.split(':');
  if (local && prefix !== 'us-gaap' && prefix !== 'ifrs-full' && EXT_ALIASES[local]) return EXT_ALIASES[local]!;
  return concept;
};

// Columns for the same period as colId that carry exactly one dimension: a
// line reported only per member (Intuit tags cost of revenue by product /
// service with no total, an oil producer its operating expenses by oil / gas)
// is rolled up by summing the members of one axis.
function rollupColumns(stmt: Statement, colId: string): StatementColumn[] {
  const col = stmt.columns.find((c) => c.id === colId);
  return col ? stmt.columns.filter((c) => c.id !== colId && Object.keys(c.dimensions).length === 1 && c.period.instant === col.period.instant && c.period.start === col.period.start && c.period.end === col.period.end) : [];
}
function rolledUp(li: LineItem, samePeriod: readonly StatementColumn[]): number | undefined {
  const byAxis: Record<Concept, number[]> = {};
  for (const c of samePeriod) {
    const v = li.values[c.id];
    if (!v || typeof v.value !== 'number') continue;
    const [axis, member] = Object.entries(c.dimensions)[0]!;
    if (/Total|Aggregate/i.test(member)) continue;
    (byAxis[axis] ||= []).push(v.value);
  }
  const axes = Object.values(byAxis);
  return axes.length === 1 && axes[0]!.length ? axes[0]!.reduce((a, b) => a + b, 0) : undefined;
}
// the line's value in the column, else the roll-up of its members
export function lineValue(li: LineItem, colId: string, samePeriod: readonly StatementColumn[] | null | undefined): number | undefined {
  const v = li.values[colId]?.value;
  if (typeof v === 'number') return v;
  return samePeriod?.length ? rolledUp(li, samePeriod) : undefined;
}

export function factsAt(stmt: Statement | null, colId: string | null | undefined, into: Facts): Facts {
  if (!stmt || !colId) return into;
  const samePeriod = rollupColumns(stmt, colId);
  // a value that came in through a synonym / extension alias yields to the
  // real concept when that turns up later (a REIT lists the small
  // RevenueFromContractWithCustomer line before the Revenues total)
  const aliased = new Set<Concept>();
  for (const li of stmt.lineItems) {
    if (li.abstract) continue;
    const key = canon(li.concept);
    const exact = key === li.concept;
    if (key in into && !(exact && aliased.has(key))) continue;
    const cell = li.values[colId];
    if (cell && typeof cell.value === 'number') {
      into[key] = cell.value;
      if (exact) aliased.delete(key);
      else aliased.add(key);
      continue;
    }
    if (!samePeriod.length) continue;
    const r = rolledUp(li, samePeriod);
    if (r !== undefined) {
      into[key] = r;
      if (exact) aliased.delete(key);
      else aliased.add(key);
    }
  }
  return into;
}

// Some filers (oil & gas, utilities, services) have no cost-of-revenue total:
// their direct costs sit as separate lines under a "Cost of revenue" /
// "Operating expenses" heading. Sum those lines, leaving out overhead-type
// items (G&A, selling, R&D, depreciation, impairments, restructuring), so a
// gross margin can still be estimated. Returns null when a real total exists.
const COGS_HEADING = /^(us-gaap:)?(CostOfRevenue|CostOfGoodsAndServicesSold|CostsAndExpenses)Abstract$/;
// a plain "Operating expenses" heading mixes direct costs with overhead: only
// lines that are recognisably the cost of delivering the revenue count -
// voyage / vessel costs (shipping), production costs, commissions (agencies),
// royalties, purchases, subcontracting, fuel, freight, occupancy ...
const EXPENSES_HEADING = /(OperatingExpenses|OperatingCostsAndExpenses|Expenses?|CostsAndExpenses|OperatingCosts|ExpensesByNature|ExpenseByNature|CostsByNature)Abstract$/;
const DIRECT_COST = /DirectOperating|Production|Distribution(?!Expense)|StoreOperating|Restaurant|Hotel|Casino|Property(Operating|Expenses)|RealEstateOperating|Cost(s)?OfProperty|FloorBrokerage|Clearance|Voyage|Vessel|Ship(?!ping)|Charter|Bunker|Fuel|PortExpense|Crew|Dry[Dd]ock|ProductionCost|Commission|Royalt|Subcontract|ContractCost|DirectCost|CostDirect|Purchase|Merchandise|Materials?|RawMaterial|Freight|Shipping|ProductCost|ServiceCost|Occupancy|LeaseOperating|Exploration|Transportation|Processing|Gathering|Manufacturing|CostOf(?!Revenue$|GoodsSold$|GoodsAndServicesSold$|Services$)|Program(ming)?Cost|Content|Reinsurance|Claims|PolicyholderBenefits|Policy.*Benefits|LossAdjustment|LossesAndLoss|BenefitsIncurred|InsuranceBenefits|InterestCreditedToPolicyholders|CostOfSales|PurchasedPower|MaintenanceAndOperations|ProductsAndServices|CostOfEnergy|TransactionExpense$|Instruct|Tuition|Educator|Faculty|Course/;
const COGS_TOTALS = /^(us-gaap:)?(CostOfRevenue|CostOfGoodsSold|CostOfGoodsAndServicesSold|CostOfServices|CostsAndExpenses|OperatingCostsAndExpenses|OperatingExpenses|BenefitsLossesAndExpenses)$|^ifrs-full:(CostOfSales|OperatingExpense)$/;
const NOT_COGS = /GeneralAndAdministrative|Pension|PostretirementBenefit|DefinedBenefit|SellingAndMarketing|SellingExpense|ResearchAndDevelopment|Depreciation|Amortization|Impairment|Restructuring|MarketingExpense$|AdvertisingExpense|IncomeTax|InterestExpense|ShareBasedCompensation|GainLoss|OtherOperating|OtherCostAndExpense/;
// Lines of an income statement that make up the "costs" section, and whether
// only whitelisted (recognisably direct) lines count:
//   1. under a cost-of-revenue heading: every line but overhead
//   2. under a generic expenses heading (or IFRS "expenses by nature"): whitelist
//   3. a heading whose lines sit at its own depth (flat presentation): the
//      lines after it up to the operating result
//   4. no headings at all: the lines after the revenue up to the operating result
// The section always stops at the first result line (operating income,
// pre-tax income, net income) so those never get summed as costs.
const REVENUE_LINE = /Revenue|^(us-gaap:)?(Sales|NetSales)|RevenueFromContract|GrossInvestmentIncome|InterestAndDividendIncomeOperating/;
const RESULT_LINE = /OperatingIncomeLoss|IncomeLossFromContinuingOperationsBefore|ProfitLossBeforeTax|ProfitLossFromOperatingActivities|IncomeLossBeforeIncomeTaxes|OperatingIncome$|NetIncomeLoss$|ProfitLoss$|IncomeLossFromContinuingOperations$/;
/** Where an income statement's costs section runs, and how strictly to read it. */
interface ExpenseSection {
  h: number;
  end: number;
  whitelist: boolean;
}

function expenseSection(items: readonly LineItem[]): ExpenseSection | null {
  const isResult = (li: LineItem) => !li.abstract && RESULT_LINE.test(li.concept.split(':').pop()!);
  let h = items.findIndex((li) => li.abstract && COGS_HEADING.test(li.concept));
  let whitelist = false;
  if (h < 0) {
    h = items.findIndex((li) => li.abstract && EXPENSES_HEADING.test(li.concept));
    whitelist = true;
  }
  let end: number;
  if (h >= 0) {
    end = h + 1;
    while (end < items.length && items[end]!.depth > items[h]!.depth && !isResult(items[end]!)) end++;
    if (end === h + 1) {
      // nothing nested: the heading's siblings up to the next heading / result line
      while (end < items.length && !items[end]!.abstract && !isResult(items[end]!)) end++;
    }
  } else {
    let start = -1;
    for (let i = 0; i < items.length; i++) if (!items[i]!.abstract && REVENUE_LINE.test(items[i]!.concept.split(':').pop()!)) start = i;
    if (start < 0) return null;
    h = start;
    end = h + 1;
    while (end < items.length && !isResult(items[end]!)) end++;
    whitelist = true;
  }
  return end > h + 1 ? { h, end, whitelist } : null;
}
// the name to classify a line by: "CostOfServicesExcludingDepreciationAndAmortization" is a cost line, not D&A
const classifyName = (concept: Concept) => concept.split(':').pop()!.replace(/(Excluding|Net|Before)[A-Z].*$/, '');
const OVERHEAD_EXACT = /^(SellingGeneralAndAdministrativeExpense|GeneralAndAdministrativeExpense|ResearchAndDevelopmentExpense|ProfessionalFees|LegalFees|StockOrUnitOptionPlanExpense|AllocatedShareBasedCompensationExpense|OperatingLeaseExpense|OtherGeneralExpense|OtherExpenses|LaborAndRelatedExpense|SalariesAndWages|EmployeeBenefitsAndShareBasedCompensation|OfficersCompensation|ProvisionForDoubtfulAccounts|BusinessCombinationAcquisitionRelatedCosts|MarketingAndAdvertisingExpense|TravelAndEntertainmentExpense|OtherSellingGeneralAndAdministrativeExpense|Franchise.*Tax|FranchisorCosts|MarketingFundExpenses|OccupancyNet|OtherSellingAndMarketingExpense|Communications?|CommunicationsAndInformationTechnology|RegulatoryFeesAndAssessments|BusinessDevelopment|InvestorRelations|DirectorsRemunerationExpense|AccountingAndAuditFees|AuditFees|ShareBasedCompensation|CompensationExpense|EmployeeBenefitsExpense|WagesAndSalaries|SalariesWagesAndOfficersCompensation|ExplorationAndEvaluationCosts|FormationAndOperationalCosts|AdministrativeFeesExpense|AdministrativeExpense|SellingAndDistributionExpense|OtherExpenseByFunction|OtherExpenseByNature|PatentDevelopmentCosts|LitigationSettlementExpense)$/;
const NOISE = /FairValue|ContingentConsideration|Warrant|Remeasurement|Litigation|Settlement|LossContingency|^Interest(Income|Expense|AndDebt|AndDividend)|EquityMethod|GainLoss|Derivative/;

export function costOfRevenueFromHeading(stmt: Statement | null, colId: string | null | undefined): number | null {
  if (!stmt || !colId) return null;
  const items = stmt.lineItems;
  const samePeriod = rollupColumns(stmt, colId);
  const val = (li: LineItem) => lineValue(li, colId, samePeriod);
  const isCogsLine = (li: LineItem) => !li.abstract && COGS_TOTALS.test(li.concept) && !/^(us-gaap:)?(CostsAndExpenses|OperatingCostsAndExpenses|OperatingExpenses|BenefitsLossesAndExpenses)$|^ifrs-full:OperatingExpense$/.test(li.concept) && typeof val(li) === 'number';
  // a real cost-of-revenue total: nothing to estimate
  if (items.some((li) => isCogsLine(li) && /^(us-gaap:)?(CostOfRevenue|CostOfGoodsSold)$|^ifrs-full:CostOfSales$/.test(li.concept))) return null;
  const sec = expenseSection(items);
  if (!sec) return null;
  const { h, end } = sec;
  const values = items.map((li, i) => (i > h && i < end && !li.abstract ? val(li) : undefined));
  const numeric = (i: number) => typeof values[i] === 'number';
  // a partial cost line (CostOfGoodsAndServicesSold covering only part of the
  // business - McDonald's franchised-restaurant costs) plus the other
  // recognisably direct lines next to it (company-operated restaurant
  // expenses); nothing extra found -> the partial line stands on its own
  const partialIdx = items.findIndex((li, i) => i > h && i < end && isCogsLine(li));
  if (partialIdx >= 0) {
    let sum = values[partialIdx]!;
    let n = 0;
    for (let i = h + 1; i < end; i++) {
      if (i === partialIdx || !numeric(i)) continue;
      const name = classifyName(items[i]!.concept);
      if (COGS_TOTALS.test(items[i]!.concept) || NOT_COGS.test(name) || NOISE.test(name) || !DIRECT_COST.test(name)) continue;
      sum += values[i]!;
      n++;
    }
    return n ? sum : null;
  }
  const { whitelist } = sec;
  // pass 1: the recognisable direct-cost lines; pass 2 (only when pass 1
  // found none): an itemised "Operating expenses" line - an oil producer's
  // lease operating costs, listed first and followed by DD&A, G&A and a
  // "Costs and expenses" total - counts as the direct cost
  for (const pass of [1, 2]) {
    let sum = 0;
    let n = 0;
    let running = 0; // every line so far, to spot a subtotal line (its value equals what came before it)
    for (let i = h + 1; i < end; i++) {
      if (!numeric(i)) continue;
      const li = items[i]!;
      const v = values[i]!;
      const name = classifyName(li.concept);
      let followers = 0;
      for (let j = i + 1; j < end; j++) if (numeric(j)) followers++;
      // a named total is one only when nothing follows it in the section
      const namedTotal = COGS_TOTALS.test(li.concept) && followers === 0;
      const isTotal = namedTotal || (running > 0 && Math.abs(v - running) <= Math.abs(running) * 0.005);
      if (isTotal) continue;
      running += v;
      if (NOT_COGS.test(name) || NOISE.test(name)) continue;
      const opexItem = /^(us-gaap:)?(OperatingExpenses|OperatingCostsAndExpenses)$/.test(li.concept);
      if (whitelist && pass === 1 && (opexItem || !DIRECT_COST.test(name))) continue;
      if (whitelist && pass === 2 && !opexItem) continue;
      if (!whitelist && opexItem) continue;
      sum += v;
      n++;
    }
    if (n) return sum;
    if (!whitelist) break;
  }
  return null;
}

// True when the income statement has an expenses section but not one line in
// it is a cost of delivering the revenue: research, administration,
// depreciation, impairments only (a licensing biotech, a SPAC, a franchisor).
// Such a filer has no cost of revenue at all - as opposed to one whose cost
// lines merely could not be told apart, which stays unknown.
export function noCostOfRevenue(stmt: Statement | null, colId: string | null | undefined): boolean {
  if (!stmt || !colId) return false;
  const items = stmt.lineItems;
  const samePeriod = rollupColumns(stmt, colId);
  const val = (li: LineItem) => lineValue(li, colId, samePeriod);
  if (items.some((li) => !li.abstract && COGS_TOTALS.test(li.concept) && !/^(us-gaap:)?(CostsAndExpenses|OperatingCostsAndExpenses|OperatingExpenses|BenefitsLossesAndExpenses)$|^ifrs-full:OperatingExpense$/.test(li.concept) && typeof val(li) === 'number')) return false;
  const sec = expenseSection(items);
  if (!sec) return false;
  let lines = 0;
  for (let i = sec.h + 1; i < sec.end; i++) {
    const li = items[i]!;
    if (li.abstract || typeof val(li) !== 'number') continue;
    if (COGS_TOTALS.test(li.concept)) continue;
    lines++;
    const name = classifyName(li.concept);
    if (NOISE.test(name)) continue; // non-operating noise inside the section
    if (DIRECT_COST.test(name)) return false;
    // anything that is not recognisably overhead could be a direct cost: then we do not know
    if (!NOT_COGS.test(name) && !OVERHEAD_EXACT.test(name)) return false;
  }
  return lines > 0;
}

export function flowsAt(data: ScrapeResult, { end, monthsLen }: { end: IsoDate | null; monthsLen: number }): Facts {
  const out: Facts = {};
  for (const type of FLOW_TYPES) {
    const stmt = statementOf(data, type);
    const col = findColumn(stmt, { dims: '', end, monthsLen });
    factsAt(stmt, col?.id, out);
    if (type === 'income_statement') {
      const est = costOfRevenueFromHeading(stmt, col?.id);
      if (est != null) out['synthetic:CostOfRevenueFromHeading'] = est;
      else if (noCostOfRevenue(stmt, col?.id)) out['synthetic:NoCostOfRevenue'] = 1;
    }
  }
  return out;
}

export function balancesAt(data: ScrapeResult, instant: IsoDate | null): Facts {
  const stmt = statementOf(data, 'balance_sheet');
  const col = findColumn(stmt, { dims: '', instant });
  return factsAt(stmt, col?.id, {});
}

export function yearQuarterPoints(docs: Partial<Record<QuarterKey, ScrapeResult>>, filings: Partial<Record<QuarterKey, FilingRef>>): QuarterPoint[] {
  const points: QuarterPoint[] = [];
  const three: Record<number, Facts> = {};
  const ytd: Record<number, Facts> = {};
  for (const [i, q] of QUARTERS.entries()) {
    if (!docs[q]) continue;
    const end = filings[q]!.reportDate;
    three[i + 1] = flowsAt(docs[q]!, { end, monthsLen: 3 });
    ytd[i + 1] = i === 0 ? three[1]! : flowsAt(docs[q]!, { end, monthsLen: 3 * (i + 1) });
    points.push({
      period: q,
      periodEnd: end,
      flows: {},
      balances: balancesAt(docs[q]!, end),
      sources: [filings[q]!.accession],
      coverShares: (docs[q]!.coverShares || []).map((x) => ({ ...x, accession: filings[q]!.accession, source: x.source || 'cover' })),
    });
  }
  const fyFlows = docs.FY ? flowsAt(docs.FY, { end: filings.FY!.reportDate, monthsLen: 12 }) : null;

  const concepts = new Set<Concept>();
  for (const m of [...Object.values(three), ...Object.values(ytd), fyFlows || {}]) for (const c of Object.keys(m)) concepts.add(c);

  // A filer may rename a line mid-year (Alphabet's dividends paid went from
  // us-gaap:PaymentsOfDividends to us-gaap:PaymentsOfOrdinaryDividends in its
  // 2026 Q2 10-Q). The cumulative of the name that vanished is the previous
  // cumulative of the one that took over, so the quarter still subtracts.
  // Only an unambiguous swap counts: exactly one interchangeable concept
  // (concepts.ts) had a cumulative and stopped being reported this period -
  // a line that is still there is a second line, not a new name for this one.
  const renamed = (upto: number, c: Concept, reportsNow: (s: Concept) => boolean): number | null => {
    let found: number | null = null;
    for (const s of SIBLINGS.get(c) || []) {
      if (cum[upto]?.[s] == null || reportsNow(s)) continue;
      if (found != null) return null;
      found = cum[upto][s];
    }
    return found;
  };

  const cum: Record<number, Record<Concept, number | null>> = { 0: {} };
  for (let n = 1; n <= 3; n++) {
    cum[n] = {};
    const p = points.find((pt) => pt.period === `Q${n}`);
    // every concept of the quarter before is settled, so a rename can look back
    for (const c of concepts) {
      const y = ytd[n]?.[c];
      const t = three[n]?.[c];
      const prev = n === 1 ? 0 : (cum[n - 1]![c] ?? renamed(n - 1, c, (s) => ytd[n]?.[s] != null || three[n]?.[s] != null));
      const cur = y ?? (prev != null && t != null ? prev + t : null);
      cum[n]![c] = cur ?? null;
      if (p) p.flows[c] = t ?? (cur != null && prev != null ? cur - prev : null);
    }
  }

  if (docs.FY) {
    const end = filings.FY!.reportDate;
    const q4: QuarterPoint = {
      period: 'Q4',
      periodEnd: end,
      flows: {},
      balances: balancesAt(docs.FY, end),
      sources: [filings.FY!.accession],
      fy: fyFlows,
      coverShares: (docs.FY.coverShares || []).map((x) => ({ ...x, accession: filings.FY!.accession, source: x.source || 'cover' })),
    };
    for (const c of Object.keys(fyFlows!)) {
      const c3 = cum[3]?.[c] ?? renamed(3, c, (s) => fyFlows![s] != null);
      q4.flows[c] = c3 != null ? fyFlows![c]! - c3 : null;
    }
    if (docs.Q3) {
      q4.sources.push(filings.Q3!.accession);
      q4.coverShares!.push(...(docs.Q3.coverShares || []).map((x) => ({ ...x, accession: filings.Q3!.accession, source: x.source || 'cover' })));
    }
    points.push(q4);
  }
  return points;
}
