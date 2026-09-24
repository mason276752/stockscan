// The shapes the rest of the code passes around: an Inline XBRL document as
// the parser leaves it, the statements built from it, what a saved filing
// file holds, and the score of one filing. Types only - nothing here runs,
// so the browser build drops the import entirely.

// ---- small helpers ----------------------------------------------------

/** An ISO date, 'YYYY-MM-DD'. Dates are strings everywhere in the store. */
export type IsoDate = string;
/** A qualified XBRL concept, 'us-gaap:Assets'. */
export type Concept = string;
/** A JSON value, for the places that really do hold arbitrary JSON. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

// ---- Inline XBRL (ixbrl.ts) -------------------------------------------

/** One xbrli:context: the period, the filer, and the dimensions on it. */
export interface XbrlContext {
  id: string;
  entity: string | null;
  instant: IsoDate | null;
  start: IsoDate | null;
  end: IsoDate | null;
  dimensions: Record<Concept, Concept>;
}

/**
 * One tagged fact. `numeric` ones (ix:nonFraction) carry the display
 * attributes as the document wrote them - `scale`, `decimals` and `sign`
 * are attribute strings, not numbers.
 */
export interface XbrlFact {
  id: string | null;
  name: Concept;
  contextRef: string;
  unitRef: string | null;
  raw: string;
  value: string | number | null;
  numeric: boolean;
  decimals: string | null;
  scale: string | null;
  sign: string | null;
  format: string | null;
  nil: boolean;
}

/** Shares outstanding read off a cover page while the contexts are still there. */
export interface CoverShareFact {
  end: IsoDate;
  entity: string;
  value: number;
  concept: Concept;
  /** one whole-entity fact, or the sum over a single share-class axis */
  basis: 'aggregate' | 'class-sum';
  classes: number;
  /** absent on a freshly parsed fact; set once it goes into the index */
  source?: string;
}

/** A parsed iXBRL document (or a merged document set). */
export interface XbrlDoc {
  contexts: Record<string, XbrlContext>;
  units: Record<string, string>;
  facts: XbrlFact[];
  schemaRef: string | null;
  /** dei:* non-numeric facts, keyed without the prefix */
  dei: Record<string, string>;
  coverShares: CoverShareFact[];
}

// ---- cover shares (coverShares.ts) ------------------------------------

/** A cover-share record on the way into the index: parsed, or from the API. */
export interface CoverShareRecord {
  accession?: string | null;
  end: IsoDate;
  value: number;
  source?: string;
  concept?: Concept | null;
  basis?: string | null;
}

/** A record the index accepted: every source of its rank agreed on the value. */
export interface CoverShareItem {
  accession: string | null;
  end: IsoDate;
  value: number;
  source: string;
  concept: Concept | null;
  basis: string | null;
}

export interface CoverShareIndex {
  version: number;
  byAccn: Record<string, CoverShareItem>;
  list: CoverShareItem[];
}

// ---- taxonomy (taxonomy.ts) -------------------------------------------

/** A node of a presentation tree. */
export interface TaxonomyNode {
  concept: Concept;
  order: number;
  preferredLabel: string | null;
  children: TaxonomyNode[];
}

/** One extended link role: a statement, a disclosure, a document section. */
export interface TaxonomyRole {
  uri: string;
  definition: string;
  title: string;
  kind: string;
  sortKey: string;
  roots: TaxonomyNode[];
}

/** concept -> label role -> text. */
export type LabelIndex = Record<Concept, Record<string, string>>;

/** Which files of the filing the taxonomy was read out of. */
export interface TaxonomyFiles {
  xsd: string;
  pre?: string;
  lab?: string | null;
}

export interface Taxonomy {
  labels: LabelIndex;
  roles: Record<string, TaxonomyRole>;
  files: TaxonomyFiles;
}

/** What the filing's MetaLinks.json contributes about a concept. */
export interface ConceptMeta {
  label: string | null;
  documentation: string | null;
}

// ---- built statements (statements.ts, statementTypes.ts) --------------

/** The four primary statements, plus every other kind a filing may present. */
export type StatementType =
  | 'balance_sheet'
  | 'income_statement'
  | 'cash_flow'
  | 'equity'
  | 'comprehensive_income'
  | 'other';

/** The four that get their own slot. */
export type PrimaryType = 'balance_sheet' | 'income_statement' | 'cash_flow' | 'equity';

/** One fact as it is written into a line item's `values`. */
export interface FactValue {
  value: string | number | null;
  raw: string | null;
  unit: string | null;
  decimals?: string | null;
  scale?: string | null;
  sign?: string | null;
  format?: string | null;
  nil?: true;
  factId?: string;
}

/** A column of a statement: one context, reduced to what the page needs. */
export interface StatementColumn {
  id: string;
  period: { instant: IsoDate; start?: undefined; end?: undefined } | { instant?: undefined; start: IsoDate; end: IsoDate };
  dimensions: Record<Concept, Concept>;
}

/**
 * One row: a concept, its labels, and its value in each column.
 * `documentation` is optional because a saved filing has it stripped out
 * into the store's shared dictionary (storeFormat.ts).
 */
export interface LineItem {
  concept: Concept;
  label: string | null;
  labelStandard: string | null;
  documentation?: string | null;
  labelZh?: string | null;
  descriptionZh?: string | null;
  preferredLabel: string | null;
  negated: boolean;
  depth: number;
  abstract: boolean;
  values: Record<string, FactValue>;
}

export interface Statement {
  type: StatementType;
  title: string;
  role: string;
  parenthetical: boolean;
  axes: Record<Concept, Concept[]>;
  columns: StatementColumn[];
  lineItems: LineItem[];
}

/** The primary slots; a filing need not present all four. */
export type PrimaryStatements = Record<PrimaryType, Statement | null>;

// ---- a saved filing (scrape.ts, store.ts) -----------------------------

/** The `filing` header of a parsed result: who filed what, and for when. */
export interface FilingHeader {
  cik: number;
  // a derived header (the Q4 view) copies these straight off the filing list,
  // which need not carry them at all
  companyName?: string | null;
  form: string | null;
  filingDate?: IsoDate | null;
  periodEnd: IsoDate | null;
  /** DocumentFiscalYearFocus: the filer's own label, so a string */
  fiscalYear: string | null;
  fiscalPeriod: string | null;
  accession: string;
  primaryDocument?: string | null;
  documentUrl?: string | null;
  viewerUrl?: string | null;
  folderUrl?: string | null;
  indexUrl?: string | null;
  taxonomyFiles?: TaxonomyFiles;
  reportDate?: IsoDate | null;
  /** filled in by the server / static build from the saved score's coverage */
  thin?: boolean;
  /** the safe cover-share record chosen for this filing, when there is one */
  coverShares?: CoverShareItem | null;
  /** 'dera' marks a filing rebuilt from SEC's quarterly datasets, not parsed */
  source?: string;
  /** which quarterly dataset a rebuilt filing came out of */
  dataset?: string | null;
}

/** What the parser produces for one filing, and what a filing file holds. */
export interface ScrapeResult {
  fetchedAt: string;
  /** how many Inline XBRL files the parse read; absent on a DERA rebuild */
  documents?: number;
  filing: FilingHeader;
  dei: Record<string, string>;
  coverShares: CoverShareFact[];
  units: Record<string, string>;
  statements: PrimaryStatements;
  allStatements: Statement[];
  stats: { facts: number; contexts: number; statementRoles: number };
  /** true when the document carried no statements at all */
  thin?: boolean;
  /** the Q4 view is derived from the other filings, not one of its own */
  derived?: boolean;
  /** the current-period view: what it had to work out, for the reader */
  view?: string;
  notes?: CurrentNote[];
  /** the 10-Q a year-to-date column was subtracted from */
  previous?: { accession: string; form: string | null; fiscalYear?: number | string | null; fiscalPeriod?: string | null; reportDate?: IsoDate | null } | null;
  /** the Q4 view: which filing each period came from */
  sources?: Record<string, { form: string; accession: string; reportDate: IsoDate | null; filingDate?: IsoDate | null; viewerUrl?: string }>;
}

/** A filing as the filing list (EDGAR submissions, trimmed) carries it. */
export interface FilingRef {
  accession: string;
  form: string;
  /** set where the list is assembled per company rather than read off one */
  cik?: number;
  reportDate: IsoDate | null;
  periodEnd?: IsoDate | null;
  filingDate?: IsoDate | null;
  /** from fiscalLabel(), so a number here */
  fiscalYear?: number | null;
  fiscalPeriod?: string | null;
  primaryDocument?: string;
  folderUrl?: string;
  documentUrl?: string;
  viewerUrl?: string;
  indexUrl?: string;
  /** the server stamps 1, the static build a boolean - both read as truthy */
  thin?: boolean | number;
  saved?: boolean;
  score?: number | null;
  /** EDGAR's flag: the document itself can be parsed */
  isInlineXBRL?: boolean;
}

/**
 * A filing as getCompany() hands it over: the list entry with the CIK and
 * the document URLs resolved, which is all the scraper needs.
 */
export type EdgarFiling = FilingRef & Required<Pick<FilingRef, 'cik' | 'primaryDocument' | 'folderUrl' | 'documentUrl' | 'viewerUrl' | 'indexUrl'>>;

/** A company and its filing list. */
export interface Company {
  cik: number;
  name?: string | null;
  tickers?: string[];
  exchanges?: (string | null)[];
  fiscalYearEnd?: string | null;
  sic?: string | null;
  sicDescription?: string | null;
  filings: FilingRef[];
}

// ---- the quarterly view (quarters.ts) ---------------------------------

/** The periods a fiscal year is assembled from. */
export type QuarterKey = 'Q1' | 'Q2' | 'Q3' | 'FY';

/** concept -> the amount reported for it in one column. */
export type Facts = Record<Concept, number>;

/** A column of the quarterly view: a real quarter, the derived Q4, or FY. */
export interface QuarterColumn {
  id: string;
  label: string;
  period: { instant: IsoDate | null } | { start: IsoDate | null; end: IsoDate | null };
  dimensions: Record<Concept, Concept>;
  /** computed from other columns rather than reported outright */
  derived: boolean;
  source: string;
}

/** One cell of the quarterly view. */
export interface QuarterCell {
  value: number;
  unit: string | null | undefined;
  raw?: string | null;
  factId?: string;
  derived?: boolean;
  /** a per-share amount subtracted between periods: only approximately right */
  approx?: true;
}

export interface QuarterLineItem {
  concept: Concept;
  label: string | null;
  labelStandard: string | null;
  labelZh?: string | null;
  descriptionZh?: string | null;
  documentation?: string | null;
  preferredLabel: string | null;
  negated: boolean;
  depth: number;
  abstract: boolean;
  values: Record<string, QuarterCell>;
}

export interface QuarterStatement {
  type: StatementType;
  title: string;
  role: string;
  parenthetical: false;
  axes: Record<Concept, Concept[]>;
  quarterly: true;
  columns: QuarterColumn[];
  lineItems: QuarterLineItem[];
}

/** What buildQuarterly() returns: a derived filing standing in for Q4. */
export interface QuarterlyResult {
  fetchedAt: string;
  derived: true;
  filing: FilingHeader;
  sources: Record<string, { form: string; accession: string; reportDate: IsoDate | null; filingDate?: IsoDate | null; viewerUrl?: string }>;
  statements: Record<PrimaryType, QuarterStatement | null>;
  allStatements: QuarterStatement[];
  stats: { facts: number; contexts: number; statementRoles: number };
}

/** One quarter of the indicator series: its flows, its closing balances. */
export interface QuarterPoint {
  period: string;
  periodEnd: IsoDate | null;
  flows: Record<Concept, number | null>;
  balances: Facts;
  sources: string[];
  /** the full-year flows, on the Q4 point only */
  fy?: Facts | null;
  coverShares?: CoverShareRecord[];
  /** set on a point no filing was found for */
  missing?: true;
}

// ---- the current-period view (current.ts) -----------------------------

/** A column of the current-period view: one period, one dimension group. */
export interface CurrentColumn extends StatementColumn {
  label?: string;
  /** computed from other columns (YTD minus the previous quarter's YTD) */
  derived?: boolean;
  /** 期初 / 本期 / 期末 collapsed into one */
  merged?: boolean;
  opening?: IsoDate | null;
  closing?: IsoDate | null;
  source?: string | string[];
}

/** A cell of the current-period view; a derived one says so. */
export interface CurrentCell extends FactValue {
  derived?: boolean;
  approx?: true;
  rolled?: boolean;
  source?: string;
}

export interface CurrentLineItem extends Omit<LineItem, 'values'> {
  values: Record<string, CurrentCell>;
}

/** Does opening + movements come to the closing balance? */
export interface Reconciliation {
  opening: number;
  movements: number;
  computed: number;
  closing: number;
  diff: number;
  ok: boolean;
  method: string;
  unit: string | null;
}

export interface CurrentStatement extends Omit<Statement, 'columns' | 'lineItems'> {
  columns: CurrentColumn[];
  lineItems: CurrentLineItem[];
  currentOnly?: true;
  derivedFromYtd?: true;
  ytdOnly?: true;
  sources?: string[];
  reconciliation?: Record<string, Reconciliation>;
}

/** Something the view had to derive; the UI words it. */
export interface CurrentNote {
  code: string;
  title?: string;
  form?: string | null;
  fiscalYear?: number | string | null;
  fiscalPeriod?: string | null;
  start?: IsoDate | null;
  end?: IsoDate | null;
}

// ---- the indicator table (indicators.ts) ------------------------------

/** One row of the indicator catalogue. */
export interface IndicatorRow {
  key: string;
  group: string;
  name: string;
  unit: string;
  kind: 'ratio' | 'flow';
  formula: string;
  /** the row is computed from annualised flows */
  annualized?: boolean;
  /** a heading row rather than a figure */
  abstract?: boolean;
  benchmark?: Benchmark;
}

/** Every ratio of one column, keyed by row. */
export type RatioValues = Record<string, number | null>;

/** The cash-flow-adequacy sums over a run of periods. */
export interface Adequacy {
  ocf: number;
  out: number;
  periods: number;
}

/** Reads one figure by its concept key (concepts.ts `C`). */
export type FigureLookup = (key: string) => number | null;

/**
 * What ratios() reads. The caller decides what a "period" is - one quarter,
 * four of them, or a full year - and answers accordingly.
 */
export interface RatioInputs {
  /** the flow over the column's own period */
  flow: FigureLookup;
  /** the same, annualised */
  flowA: FigureLookup;
  /** closing balance */
  bal: FigureLookup;
  /** opening balance */
  balPrev: FigureLookup;
  adequacy: () => Adequacy | null;
}

/** One column of the indicator table. */
export interface IndicatorColumn {
  label: string;
  sublabel?: string | null;
  year: number;
  period: string;
  periodEnd: IsoDate | null;
  missing: boolean;
  sources: string[];
  values: RatioValues;
  flowsAnnualized: RatioValues;
}

/** The company header the indicator page shows. */
export interface CompanyMeta {
  cik: number;
  name?: string | null;
  tickers?: string[];
  fiscalYearEnd?: string | null;
}

export interface Indicators {
  fetchedAt: string;
  company: CompanyMeta;
  quarterly: boolean;
  mode: string;
  basis: string;
  end: { year: number; period: string };
  rows: IndicatorRow[];
  columns: IndicatorColumn[];
}

// ---- scores (scoreModel.ts, score.ts) ---------------------------------

/** A benchmark row: the value to beat and how to compare against it. */
export interface Benchmark {
  op: '>' | '>=' | '<' | '<=';
  value: number;
  text?: string;
}

/** One scored item of the 0-100 model. */
export interface ScoreItem {
  key: string;
  name: string;
  unit: string;
  category: string;
  value: number | null;
  benchmark: Benchmark;
  grade: number | null;
  points: number | null;
  weight: number;
}

export interface ScoreCategory {
  name: string;
  earned: number;
  applicable: number;
  score: number | null;
}

/** What scoreValues() returns: the score and its breakdown. */
export interface ScoreBreakdown {
  score: number | null;
  earned: number;
  applicable: number;
  coverage: number;
  categories: ScoreCategory[];
  items: ScoreItem[];
}

/** What the flows of a scored filing cover. */
export interface ScoreBasis {
  kind: 'quarter' | 'annual' | 'ytd';
  monthsLen: number;
  quarter?: string;
  partial?: boolean;
  annualized?: boolean;
  note?: string;
}

/** A saved score: the breakdown, every rounded ratio, and the filing it is of. */
export interface Score extends ScoreBreakdown {
  values: Record<string, number | null>;
  version: number;
  accession: string;
  cik: number;
  form: string | null;
  fiscalYear: string | null;
  // copied straight off the filing, which need not carry them
  fiscalPeriod?: string | null;
  periodEnd: IsoDate | null;
  filingDate?: IsoDate | null;
  basis: ScoreBasis;
}

// ---- custom-ETF baskets (basket.ts) -----------------------------------

/** One constituent of a basket, with the bars fetched for it. */
export interface BasketMember {
  symbol: string;
  ticker?: string;
  cik?: number | null;
  weight: number;
  days: Bar[];
  source?: string | null;
  currency?: string | null;
  /** the benchmark line rather than a constituent */
  bench?: boolean;
  error?: string | null;
}

/** A bar of the index itself (lightweight-charts' shape). */
export interface BasketBar {
  time: IsoDate;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Something worth telling the reader; the UI words it in its language. */
export interface BasketNote {
  code: string;
  symbol?: string;
  date?: IsoDate;
  start?: IsoDate;
  error?: string | null;
  n?: number;
  first?: IsoDate;
  last?: IsoDate;
  /** sessions the index held nothing, or names it names */
  days?: number;
  price?: number;
  list?: string;
}

/** How one name fared inside the window. */
export interface BasketConstituent {
  symbol: string;
  weight: number;
  source?: string | null;
  first: IsoDate;
  last: IsoDate;
  joined: IsoDate | null;
  left: IsoDate | null;
  delisted: boolean;
  startClose: number | null;
  endClose: number | null;
  return: number | null;
  contribution: number | null;
  illiquid: boolean;
  listed?: boolean;
  renamed?: string;
}

export interface BasketStats {
  total: number;
  cagr: number | null;
  years: number;
  vol: number;
  maxDrawdown: number;
  drawdownFrom: IsoDate;
  drawdownTo: IsoDate;
  best: { r: number; date: IsoDate } | null;
  worst: { r: number; date: IsoDate } | null;
  days: number;
}

/** The index itself. */
export interface BasketSeries {
  bars: BasketBar[];
  start: IsoDate | null;
  end: IsoDate | null;
  notes: BasketNote[];
  constituents?: BasketConstituent[];
  stats?: BasketStats | null;
}

/** One line of a streamed run: progress, a member, or the finished index. */
export interface EmitEvent {
  type: string;
  [key: string]: unknown;
}

/** POST /api/basket's body, parsed. */
export interface BasketRequest {
  wanted: { ticker: string; cik: number | null; weight: number }[];
  range: string;
  from: IsoDate | null;
  to: IsoDate | null;
  rebalance: 'none' | 'daily';
  benchmark: string | null;
}

/** What the ticker table says about a symbol. */
export interface Listing {
  listed: boolean;
  renamed?: string;
}

// ---- rule ETFs (ruleEtf.ts) -------------------------------------------

/** A stretch a company was held for; `to` null = still in. */
export interface HoldSpan {
  from: IsoDate;
  to: IsoDate | null;
}

/** A company the filters ever held, and what it was worth on the day. */
export interface RuleMember {
  cik: number;
  ticker: string;
  name: string;
  sic: string | null;
  spans: HoldSpan[];
  /** the diluted share count whenever it changed (millions of shares) */
  shares: { date: IsoDate; value: number }[];
}

/** One day the membership changed. */
export interface RuleEvent {
  date: IsoDate;
  add: string[];
  drop: string[];
  n: number;
  /** the synthetic event that opens a window with what was already held */
  opening?: boolean;
}

/** The whole replay: who was in, and when it changed. */
export interface RuleSchedule {
  members: RuleMember[];
  events: RuleEvent[];
  /** conditions the replay could not answer (the market snapshot is today's) */
  skipped: string[];
  tested: number;
  first: IsoDate | null;
  last: IsoDate | null;
}

/** One stage of a modified market-capitalisation weighting. */
export interface WeightConstraint {
  over: number;
  to: number;
  /** what the special rebalance watches, when it is not the trigger itself */
  watch?: number;
  above?: number;
  n?: number;
  cap?: number;
}

/** The stages, as Nasdaq-100 states them. */
export interface WeightConstraints {
  single?: WeightConstraint;
  cohort?: WeightConstraint & { above: number };
  top?: WeightConstraint & { n: number; cap: number };
}

/** A name the index bought bars for. */
export interface RuleBarsMember {
  symbol: string;
  days: Bar[];
  shares?: { date: IsoDate; value: number }[];
  source?: string | null;
  currency?: string | null;
  error?: string | null;
}

/** How one name fared while the index held it. */
export interface RuleConstituent {
  symbol: string;
  source?: string | null;
  days: number;
  spells: number;
  first: IsoDate | null;
  last: IsoDate | null;
  return: number | null;
  in: boolean;
  cheap: number;
  wild: { date: IsoDate; factor: number } | null;
  delisted: boolean;
}

/** POST /api/basket/rule's body, parsed. */
export interface RuleRequest {
  params: ScreenQueryParams;
  from: IsoDate | null;
  to: IsoDate | null;
  range: string;
  benchmark: string | null;
  minPrice: number;
  rebalance: string;
  weighting: string;
  maxWeight: number;
  special: boolean;
}

// ---- the Chinese dictionary (zh.ts and its batches) -------------------

/** A dictionary entry: [name] or [name, explanation]. */
export type ZhEntry = readonly [string] | readonly [string, string];
/** Concept (or bare local name) -> its Chinese name. */
export type ZhTable = Record<string, ZhEntry>;

/** The Chinese name and note of one concept, as the line items carry them. */
export interface ZhLabel {
  labelZh: string | null;
  descriptionZh: string | null;
}

// ---- the screener (screen.ts) -----------------------------------------

/** One column the screener offers to filter and sort on. */
export interface ScreenField {
  key: string;
  name: string;
  unit: string;
  group: string;
  annualized?: boolean;
  /** filled in from the market snapshot rather than from a filing */
  market?: boolean;
}

/** A company as the SIC / filer universe carries it. */
export interface UniverseCompany {
  cik: number;
  name: string;
  ticker: string | null;
  tickers: string[];
  sic: string | null;
  /** filled in by companyRow() for the browse lists */
  sicZh?: string | null;
  sicTitle?: string | null;
  afs: string | null;
  wksi?: boolean;
  float?: number | null;
  floatDate?: IsoDate | null;
  floatAdjusted?: boolean;
  form?: string | null;
  period?: IsoDate | null;
  filed?: IsoDate | null;
  state?: string | null;
  country?: string | null;
}

/** One symbol's line of the market snapshot. */
export interface MarketQuote {
  price?: number | null;
  currency?: string | null;
  change?: number | null;
  marketCap?: number | null;
  pe?: number | null;
  pb?: number | null;
  ps?: number | null;
  pfcf?: number | null;
  evEbitda?: number | null;
  divYield?: number | null;
  peg?: number | null;
  perfYtd?: number | null;
  perfY?: number | null;
  volume?: number | null;
  avgVolume?: number | null;
  beta?: number | null;
  exchange?: string | null;
  tv?: string | null;
}

/**
 * A saved score without its `items` breakdown - the seventeen benchmark
 * rows, with their names and thresholds, which is three quarters of a
 * score's bytes. Everything that reads scores in bulk (the screener, the
 * as-of index, the static build's shards) reads this much and no more, so
 * this is the shape they are kept in; `items` is re-read from the file on
 * the one page that shows it.
 */
export type ScoreRow = Omit<Score, 'items'>;

/** A score with the two earlier filings the change filters compare against. */
export interface ScoreWithHistory extends ScoreRow {
  prev: ScoreBrief | null;
  yoy: ScoreBrief | null;
  history: number;
}

/** The little of an earlier filing the change filters need. */
export interface ScoreBrief {
  fiscalYear: string | null;
  fiscalPeriod?: string | null;
  periodEnd: IsoDate | null;
  score: number | null;
  values: RatioValues;
}

/** The score summary every list shows beside a company. */
export interface ScoreBadge {
  score: number | null;
  coverage: number;
  accession: string;
  form: string | null;
  fiscalYear: string | null;
  fiscalPeriod?: string | null;
  periodEnd: IsoDate | null;
  filingDate?: IsoDate | null;
  categories: (number | null)[];
}

/** One row of the screener table. */
export interface ScreenRow {
  cik: number;
  ticker: string | null;
  tickers: string[];
  name: string;
  sic: string | null;
  sicZh: string | null;
  afs: string | null;
  float?: number | null;
  score: ScoreBadge;
  values: RatioValues;
  prev: ScoreBrief | null;
  yoy: ScoreBrief | null;
  history: number;
  market: MarketQuote | null;
}

/**
 * How screenQuery reads whatever layout the caller holds: row objects on the
 * server, typed columns in the browser, or a view of them as of a date.
 */
export interface ScreenTable {
  length: number;
  cik(i: number): number;
  ticker(i: number): string | null;
  tickers(i: number): string[] | null;
  name(i: number): string;
  sic(i: number): string | null;
  afs(i: number): string | null;
  float(i: number): number | null;
  score(i: number): number | null;
  value(i: number, key: string): number | null;
  baseScore(i: number, mode: string): number | null;
  baseValue(i: number, key: string, mode: string): number | null;
  market(i: number, key: string): number | string | null;
  row(i: number): ScreenRow;
}

/** A column of values, null where the row has none. */
export type Column<T> = (T | null)[];

/** The prev / yoy half of the column layout. */
export interface BaseColumns {
  has: Column<number>;
  fiscalYear: Column<string>;
  fiscalPeriod: Column<string>;
  periodEnd: Column<IsoDate>;
  score: Column<number>;
  values: Record<string, Column<number>>;
}

/** index/screen.json: the screener rows turned on their side. */
export interface ScreenColumns {
  n: number;
  cik: Column<number>;
  ticker: Column<string>;
  tickers: Column<string[]>;
  name: Column<string>;
  sic: Column<string>;
  sicZh: Column<string>;
  afs: Column<string>;
  float: Column<number>;
  history: Column<number>;
  score: Record<string, Column<unknown>>;
  values: Record<string, Column<number>>;
  market: { has: Column<number> } & Record<string, Column<unknown>>;
  /** spread in from index/screen-history.json when a query needs them */
  prev?: BaseColumns;
  yoy?: BaseColumns;
}

/** What screenColumns() produces: the two files the static build ships. */
export interface ScreenColumnFiles {
  screen: ScreenColumns;
  history: { n: number; prev: BaseColumns; yoy: BaseColumns };
}

/** index/screen-asof-<year>.json: every scored filing of one filing year. */
export interface AsOfColumns {
  n: number;
  cik: Column<number>;
  accession: Column<string>;
  form: Column<string>;
  filingDate: Column<IsoDate>;
  periodEnd: Column<IsoDate>;
  fiscalYear: Column<string>;
  fiscalPeriod: Column<string>;
  score: Column<number>;
  coverage: Column<number>;
  categories: Column<(number | null)[]>;
  values: Record<string, Column<number>>;
}

/** Where one filing sits: shard `s`, row `j`, plus what pickAsOf reads. */
export interface AsOfRef {
  s: number;
  j: number;
  form: string | null;
  filingDate: IsoDate | null;
  periodEnd: IsoDate | null;
  fiscalYear: string | null;
  fiscalPeriod: string | null;
  coverage: number | null;
}

/** The loaded year files, with each company's filings newest first. */
export interface AsOfIndex {
  shards: AsOfColumns[];
  byCik: Map<number, AsOfRef[]>;
}

/** A screener query as it arrives on the URL. */
export type ScreenQueryParams = Record<string, string | number | undefined>;

// ---- daily bars (barFormat.ts, barStore.ts) ---------------------------

export interface Bar {
  date: IsoDate;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

/** A split (or dividend) factor applied to every bar before `date`. */
export interface AdjustEvent {
  date: IsoDate;
  price: number;
  volume: number | null;
}

/** What a saved series knows about itself, beside the bars. */
export interface BarMeta {
  symbol: string;
  source: string;
  currency?: string | null;
  /** the symbol the source actually resolved the ticker to */
  resolved?: string | null;
  years?: string[];
  adjust: AdjustEvent[];
  fetchedAt?: string | null;
}

/** A series as the callers see it: the meta plus the bars, current basis. */
export interface BarSeries {
  symbol: string;
  source: string;
  currency?: string | null;
  resolved?: string | null;
  adjust?: AdjustEvent[];
  days: Bar[];
  fetchedAt?: string | null;
  /** how many bars the last refresh actually fetched (absent: the whole series) */
  incremental?: number;
}

/** One year of bars, columnar: deltas against the previous close. */
export interface BarFile {
  d: number;
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: (number | null)[];
}
