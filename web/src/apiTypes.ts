// The data layer's shape, so the two implementations cannot drift apart:
// api.http.ts talks to the Node server, api.static.ts reads the published
// files and computes the same answers in the browser. Types only.

import type {
  BasketRequest, Bar, Company, CompanyMeta, Indicators, IsoDate, QuarterlyResult, Score, ScoreBadge,
  EdgarFiling, ScreenField, ScreenQueryParams, ScreenRow, ScrapeResult, UniverseCompany,
} from '../../server/lib/types.ts';
import type { Etf, MappedHolding, NportFiling } from '../../server/lib/etf.ts';
import type { TickerRow } from '../../server/lib/edgar.ts';
import type { SicCode, SicDivision, FilerStatus } from '../../server/lib/sic.ts';
import type { FilerCount } from '../../server/lib/screen.ts';
import type { FilerInfo } from '../../server/lib/universe.ts';

/** A query as a page builds it: plain strings on their way into a URL. */
export type Params = Record<string, string | number | undefined>;

/** A company with its filings, as the report page reads it. */
export interface CompanyResponse extends Omit<Company, 'filings'> {
  filings: EdgarFiling[];
  sicZh?: string | null;
  filer?: FilerInfo | null;
  /** when the filing list was last read from EDGAR */
  filingsUpdatedAt?: string;
  filingsStale?: boolean;
}

/** GET /api/screen. */
export interface ScreenResponse {
  total: number;
  count: number;
  rows: ScreenRow[];
  scored: number;
  asof: IsoDate | null;
  market?: MarketStatus;
}

/** How fresh the market snapshot behind the screener is. */
export interface MarketStatus {
  count?: number;
  updatedAt?: string | null;
  refreshing?: boolean;
  /** the static build ships the snapshot itself */
  builtAt?: string;
}

/** GET /api/screen/fields. */
export interface ScreenFieldsResponse {
  fields: ScreenField[];
  divisions: SicDivision[];
  filer: Record<string, FilerStatus>;
  market?: MarketStatus;
  asof?: { min: IsoDate | null };
}

/** GET /api/score?ciks=… */
export interface ScoresResponse {
  version: number;
  items: unknown[];
  scores: Record<string, ScoreBadge | null>;
}

/** GET /api/browse/sic. */
export interface BrowseSicResponse {
  updatedAt: string | null;
  datasets: string[];
  divisions: SicDivision[];
  codes: (SicCode & { total: number; listed: number })[];
}

/** GET /api/browse/filer. */
export interface BrowseFilerResponse {
  updatedAt: string | null;
  datasets: string[];
  categories: FilerCount[];
}

/** GET /api/browse/companies. */
export interface BrowseCompaniesResponse {
  updatedAt: string | null;
  sic: SicCode | null;
  filer: (FilerStatus & { key: string }) | null;
  count: number;
  companies: UniverseCompany[];
}

/** GET /api/browse/etf. */
export interface BrowseEtfsResponse {
  updatedAt: string | null;
  total: number;
  count: number;
  popular: readonly string[];
  etfs: Etf[];
}

/** GET /api/browse/etf/:ticker. */
export interface EtfHoldingsResponse {
  etf: Etf;
  filing: NportFiling & { reportDate: IsoDate | null; seriesName: string; netAssets: number | null; totAssets: number | null; viewerUrl: string };
  holdings: MappedHolding[];
  stats: { total: number; mapped: number; equities: number };
  sources: { cusipFiles: string[]; cusipUpdatedAt: string };
}

/** A search suggestion, with the score of the company's newest filing. */
export interface SearchHit extends TickerRow {
  score: ScoreBadge | null;
}

/** One warm-up job: its key, the work, and how early it should run. */
export type WarmupTask = [key: string, run: () => Promise<unknown>, priority: number];

/** One NDJSON line of a streamed basket / rule-ETF run. */
export interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

/** What every page calls. Both implementations answer all of it. */
export interface Api {
  /** true in the pure-frontend build, where there is no server behind this */
  isStatic: boolean;
  search(q: string): Promise<SearchHit[]>;
  company(id: string | number, opts?: { refresh?: boolean }): Promise<CompanyResponse>;
  filing(cik: number | string, accession: string, view?: string): Promise<ScrapeResult>;
  /** the URL the same call would be at, or null in the static build */
  filingUrl(cik: number | string, accession: string, view?: string): string | null;
  quarters(id: string | number, year: number | string): Promise<QuarterlyResult>;
  quartersUrl(id: string | number, year: number | string): string | null;
  indicators(id: string | number, params: Params): Promise<Indicators>;
  indicatorsUrl(id: string | number, params: Params): string | null;
  valuation(id: string | number, params: Params): Promise<unknown>;
  valuationUrl(id: string | number, params: Params): string | null;
  /** the static build fetches its indexes ahead of time; the server build has nothing to do */
  warmup(): WarmupTask[];
  status(): Promise<unknown>;
  screenFields(): Promise<ScreenFieldsResponse>;
  screen(params: ScreenQueryParams): Promise<ScreenResponse>;
  screenUrl(params: ScreenQueryParams): string | null;
  scores(ciks: readonly (number | string | null | undefined)[]): Promise<ScoresResponse>;
  score(cik: number | string, accession: string): Promise<Score>;
  browseSic(): Promise<BrowseSicResponse>;
  browseFiler(): Promise<BrowseFilerResponse>;
  browseCompanies(params: Params): Promise<BrowseCompaniesResponse>;
  browseEtfs(q?: string): Promise<BrowseEtfsResponse>;
  etfHoldings(ticker: string): Promise<EtfHoldingsResponse>;
  etfHoldingsUrl(ticker: string): string | null;
  etfLive(ticker: string): Promise<unknown>;
  quotesStatus(): Promise<unknown>;
  tvSymbol(ticker: string): Promise<{ ticker: string; symbol: string; exchange: string | null; known: boolean }>;
  ibConnect(): Promise<unknown>;
  bars(symbol: string): Promise<{ symbol: string; source?: string | null; currency?: string | null; days: Bar[] }>;
  basket(body: Record<string, unknown>): Promise<unknown>;
  basketStream(body: Record<string, unknown>, onEvent: (e: StreamEvent) => void, signal?: AbortSignal): Promise<void>;
  ruleEtf(body: Record<string, unknown>): Promise<unknown>;
  ruleEtfStream(body: Record<string, unknown>, onEvent: (e: StreamEvent) => void, signal?: AbortSignal): Promise<void>;
  /** the static build's own extras, absent on the server one */
  company0?: (id: string | number) => Promise<CompanyResponse>;
  [key: string]: unknown;
}

export type { BasketRequest, CompanyMeta };
