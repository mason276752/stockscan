// The screener and the browse lists as pure functions over in-memory rows,
// so the server route and the browser build (which loads the same rows from
// prebuilt JSON) share one implementation.

import { ROWS as INDICATOR_ROWS } from './indicators.ts';
import { AMOUNT_FIELDS } from './scoreModel.ts';
import { MARKET_FIELDS } from './marketFields.ts';
import { FILER_STATUS, SIC, sicInfo } from './sic.ts';
import { collapseAmendments, filingPeriodKey } from './filings.ts';
import type {
  AsOfColumns, AsOfIndex, AsOfRef, BaseColumns, Column, MarketQuote, RatioValues, ScoreBadge, ScoreBrief,
  ScoreWithHistory, ScreenColumnFiles, ScreenColumns, ScreenField, ScreenQueryParams, ScreenRow, ScreenTable,
  UniverseCompany, IsoDate, Score,
} from './types.ts';
import type { SicCode } from './sic.ts';

// Screener fields: the score, every indicator row, statement amounts (from
// the latest filing), and the market snapshot (price, market cap, multiples).
export const SCREEN_FIELDS: ScreenField[] = [
  { key: 'score', name: '評分', unit: '分', group: '評分' },
  ...INDICATOR_ROWS.filter((r) => !r.abstract).map((r) => ({ key: r.key, name: r.name, unit: r.unit, group: r.group, annualized: !!r.annualized })),
  ...AMOUNT_FIELDS,
  ...MARKET_FIELDS.map((f) => ({ ...f, market: true })),
];
export const MARKET_KEYS = new Set(MARKET_FIELDS.map((f) => f.key));
const fieldOf = (key: string) => SCREEN_FIELDS.find((f) => f.key === key);
const pctField = (key: string) => {
  const f = fieldOf(key);
  return f?.unit === '百萬' || f?.unit === '百萬股' || key === 'score';
};

// One screener row: a company's newest score (with prev / yoy), its
// universe record (industry, filer status, float) and market snapshot record.
export function screenRow(s: ScoreWithHistory, c: UniverseCompany, mk: MarketQuote | null): ScreenRow {
  return {
    cik: c.cik,
    ticker: c.ticker,
    tickers: c.tickers,
    name: c.name,
    sic: c.sic,
    sicZh: sicInfo(c.sic)?.zh || null,
    afs: c.afs,
    float: c.float,
    score: { score: s.score, coverage: s.coverage, accession: s.accession, form: s.form, fiscalYear: s.fiscalYear, fiscalPeriod: s.fiscalPeriod, periodEnd: s.periodEnd, filingDate: s.filingDate, categories: s.categories.map((x) => x.score) },
    values: s.values || {},
    prev: s.prev ? { fiscalYear: s.prev.fiscalYear, fiscalPeriod: s.prev.fiscalPeriod, periodEnd: s.prev.periodEnd, score: s.prev.score, values: s.prev.values } : null,
    yoy: s.yoy ? { fiscalYear: s.yoy.fiscalYear, fiscalPeriod: s.yoy.fiscalPeriod, periodEnd: s.yoy.periodEnd, score: s.yoy.score, values: s.yoy.values } : null,
    history: s.history,
    market: mk ? { price: mk.price, currency: mk.currency, change: mk.change, marketCap: mk.marketCap, pe: mk.pe, pb: mk.pb, ps: mk.ps, pfcf: mk.pfcf, evEbitda: mk.evEbitda, divYield: mk.divYield, peg: mk.peg, perfYtd: mk.perfYtd, perfY: mk.perfY, volume: mk.volume, avgVolume: mk.avgVolume, beta: mk.beta, exchange: mk.exchange, tv: mk.tv } : null,
  };
}

// every scored company in the universe as a screener row
export function screenRows(scores: readonly ScoreWithHistory[], companiesByCik: Map<number, UniverseCompany>, marketByTicker: Record<string, MarketQuote> | null = null): ScreenRow[] {
  const rows: ScreenRow[] = [];
  for (const s of scores) {
    const c = companiesByCik.get(s.cik);
    if (!c) continue;
    rows.push(screenRow(s, c, c.ticker ? marketByTicker?.[c.ticker] || null : null));
  }
  return rows;
}

// ---- the screener table ----
// screenQuery reads the rows through a small accessor object, so the two
// layouts share one implementation: the server hands it the row objects
// screenRows builds per request (rowTable: nothing to convert), the static
// build ships the same rows as columns (screenColumns: one array per field
// - a quarter of the JSON of the rows, parsed in a third of the time) and
// the browser's worker reads those (columnTable: the value columns as
// Float64Array, NaN for null). The columns come in two files so the page
// can show its first results before the bigger half has arrived: the
// company / score / values / market columns (index/screen.json) and the
// prev / yoy columns for the change filters (screen-history.json, loaded
// when a query needs them - wantsHistory). Only the rows a query returns
// are materialised as objects.
const SCORE_KEYS = ['score', 'coverage', 'accession', 'form', 'fiscalYear', 'fiscalPeriod', 'periodEnd', 'filingDate', 'categories'];
const BASE_KEYS = ['fiscalYear', 'fiscalPeriod', 'periodEnd', 'score']; // prev / yoy, plus values
const ROW_KEYS = ['cik', 'ticker', 'tickers', 'name', 'sic', 'sicZh', 'afs', 'float', 'history'];

// rows -> columns (what index/screen.json holds)
export function screenColumns(rows: readonly ScreenRow[]): ScreenColumnFiles {
  const n = rows.length;
  const col = <T,>(get: (r: ScreenRow) => T | null | undefined): Column<T> => {
    const a = new Array<T | null>(n);
    for (let i = 0; i < n; i++) a[i] = get(rows[i]!) ?? null;
    return a;
  };
  const cols = (keys: readonly string[], sel: (r: ScreenRow) => Record<string, unknown> | null | undefined) =>
    Object.fromEntries(keys.map((k) => [k, col((r) => sel(r)?.[k])]));
  const union = (sel: (r: ScreenRow) => Record<string, unknown> | null | undefined): string[] => {
    const keys = new Set<string>();
    for (const r of rows) for (const k of Object.keys(sel(r) || {})) keys.add(k);
    return [...keys];
  };
  const valueKeys = [...new Set([...union((r) => r.values), ...union((r) => r.prev?.values), ...union((r) => r.yoy?.values)])];
  const base = (sel: (r: ScreenRow) => ScoreBrief | null) =>
    ({ has: col((r) => (sel(r) ? 1 : 0)), ...cols(BASE_KEYS, sel as never), values: cols(valueKeys, (r) => sel(r)?.values) }) as unknown as BaseColumns;
  return {
    screen: {
      n,
      ...cols(ROW_KEYS, (r) => r as unknown as Record<string, unknown>),
      score: cols(SCORE_KEYS, (r) => r.score as unknown as Record<string, unknown>),
      values: cols(valueKeys, (r) => r.values),
      market: { has: col((r) => (r.market ? 1 : 0)), ...cols(union((r) => r.market as Record<string, unknown> | null), (r) => r.market as Record<string, unknown> | null) },
    } as unknown as ScreenColumns,
    history: { n, prev: base((r) => r.prev), yoy: base((r) => r.yoy) },
  };
}

// does a query need the prev / yoy columns (a change filter or sort, or the
// page saying it shows change columns: history=1)?
export const wantsHistory = (q: ScreenQueryParams): boolean => Object.keys(q).some((k) => /_(chg|yoy)_(min|max)$/.test(k)) || ['chg', 'yoy'].includes(String(q.sortmode || '')) || String(q.history || '') === '1';

const rowTable = (rows: readonly ScreenRow[]): ScreenTable => ({
  length: rows.length,
  cik: (i) => rows[i]!.cik,
  ticker: (i) => rows[i]!.ticker,
  tickers: (i) => rows[i]!.tickers,
  name: (i) => rows[i]!.name,
  sic: (i) => rows[i]!.sic,
  afs: (i) => rows[i]!.afs,
  float: (i) => rows[i]!.float ?? null,
  score: (i) => rows[i]!.score.score,
  value: (i, key) => rows[i]!.values[key] ?? null,
  baseScore: (i, mode) => (mode === 'chg' ? rows[i]!.prev : rows[i]!.yoy)?.score ?? null,
  baseValue: (i, key, mode) => (mode === 'chg' ? rows[i]!.prev : rows[i]!.yoy)?.values?.[key] ?? null,
  market: (i, key) => (rows[i]!.market as Record<string, number | string | null> | null)?.[key] ?? null,
  row: (i) => rows[i]!,
});

/** A base (prev / yoy) with its value columns already turned into Float64Array. */
type TypedBase = Omit<BaseColumns, 'values'> & { values: Record<string, Float64Array> };

function columnTable(c: ScreenColumns): ScreenTable {
  const typed = (cols: Record<string, Column<number>>): Record<string, Float64Array> =>
    Object.fromEntries(
      Object.entries(cols).map(([k, a]) => {
        const f = new Float64Array(a.length);
        for (let i = 0; i < a.length; i++) f[i] = a[i] == null ? NaN : a[i]!;
        return [k, f];
      }),
    );
  const values = typed(c.values);
  // prev / yoy: absent until the history file is loaded (then every base is null)
  const bases: Record<string, TypedBase | undefined> = { chg: c.prev && { ...c.prev, values: typed(c.prev.values) }, yoy: c.yoy && { ...c.yoy, values: typed(c.yoy.values) } };
  const num = (a: Float64Array | undefined, i: number) => (a && !Number.isNaN(a[i]!) ? a[i]! : null);
  const pick = (cols: Record<string, Column<unknown>>, keys: readonly string[], i: number) => {
    const o: Record<string, unknown> = {};
    for (const k of keys) o[k] = cols[k]?.[i] ?? null;
    return o;
  };
  const valueKeys = Object.keys(c.values);
  const valuesAt = (cols: Record<string, Float64Array>, i: number) => {
    const o: RatioValues = {};
    for (const k of valueKeys) o[k] = num(cols[k], i);
    return o;
  };
  const baseAt = (mode: string, i: number): ScoreBrief | null =>
    bases[mode]?.has[i] ? ({ ...pick(bases[mode] as unknown as Record<string, Column<unknown>>, BASE_KEYS, i), values: valuesAt(bases[mode]!.values, i) } as unknown as ScoreBrief) : null;
  const marketKeys = Object.keys(c.market).filter((k) => k !== 'has');
  return {
    length: c.n,
    cik: (i) => c.cik[i]!,
    ticker: (i) => c.ticker[i]!,
    tickers: (i) => c.tickers[i]!,
    name: (i) => c.name[i]!,
    sic: (i) => c.sic[i]!,
    afs: (i) => c.afs[i]!,
    float: (i) => c.float[i]!,
    score: (i) => c.score.score![i] as number | null,
    value: (i, key) => num(values[key], i),
    baseScore: (i, mode) => (bases[mode]?.has[i] ? bases[mode]!.score[i]! : null),
    baseValue: (i, key, mode) => (bases[mode]?.has[i] ? num(bases[mode]!.values[key], i) : null),
    market: (i, key) => (c.market.has[i] ? ((c.market[key]?.[i] ?? null) as number | string | null) : null),
    // the row object screenRow would have built
    row: (i) => ({
      ...pick(c as unknown as Record<string, Column<unknown>>, ROW_KEYS.slice(0, -1), i),
      score: pick(c.score, SCORE_KEYS, i),
      values: valuesAt(values, i),
      prev: baseAt('chg', i),
      yoy: baseAt('yoy', i),
      history: c.history[i],
      market: c.market.has[i] ? pick(c.market, marketKeys, i) : null,
    }) as unknown as ScreenRow,
  };
}

// rows (screenRows) or columns (screenColumns' screen, with or without its
// history spread in) -> the table screenQuery reads
export const screenTable = (x: readonly ScreenRow[] | ScreenColumns | ScreenTable): ScreenTable =>
  Array.isArray(x) ? rowTable(x) : typeof (x as ScreenTable).length === 'number' && typeof (x as ScreenTable).row === 'function' ? (x as ScreenTable) : columnTable(x as ScreenColumns);

// ---- as of a date ----
// The screener normally reads each company's newest filing. With a date it
// reads the newest one that was *already filed* then (`filingDate <= asof`),
// so a search can be run as it would have come out at an earlier point in
// time - a filing counts from the day it reached EDGAR, not from the day
// its quarter ended. Only the figures of the filings move: the industry /
// filer data and the market snapshot (price, market cap, multiples) are
// always the current ones.
export const SCORE_HISTORY = 6; // filings per company to look back at for prev / yoy

// A company's filings newest first -> the one current at `asof` (null = the
// newest of all), the one before it and the same fiscal period a year
// earlier, for the change filters. A filing with no filing date is kept
// (nothing says it was not out yet).
//
// A period that was amended counts once, as the amended version: that is
// the number the company now stands behind, so it is what gets screened and
// scored (filings.ts collapseAmendments). An amendment that carries no
// statements - `coverage` 0, the Part III-only kind - corrects nothing, so
// its original stands. And an amendment only counts from the day it was
// filed: screening 2026-01-01 reads what was on the table then, not the
// correction that arrived in March.
const thinScore = (f: { coverage?: number | null }) => !(Number(f.coverage) > 0);

/** What a company's filings look like as of a date. */
export interface AsOfPick<T> {
  cur: T | null;
  prev: T | null;
  yoy: T | null;
  history: number;
}

export function pickAsOf<T extends { coverage?: number | null; filingDate?: IsoDate | null; fiscalYear?: string | null; fiscalPeriod?: string | null; form?: string | null; periodEnd?: IsoDate | null; reportDate?: IsoDate | null }>(
  filings: readonly (T | null | undefined)[],
  asof: IsoDate | null = null,
  limit = SCORE_HISTORY,
): AsOfPick<T> {
  const versions: T[] = [];
  const periods = new Set<string>();
  for (const f of filings) {
    if (!f) continue;
    if (asof && f.filingDate && f.filingDate > asof) continue;
    const key = filingPeriodKey(f);
    if (!periods.has(key)) {
      if (periods.size >= limit) break; // the newest `limit` periods, every version of them
      periods.add(key);
    }
    versions.push(f);
  }
  const hist = collapseAmendments(versions, thinScore);
  const cur = hist[0] || null;
  const yoy = cur ? hist.find((x, i) => i > 0 && x.fiscalPeriod === cur.fiscalPeriod && String(Number(x.fiscalYear) + 1) === String(cur.fiscalYear)) : null;
  return { cur, prev: hist[1] || null, yoy: yoy || null, history: hist.length };
}

// `asof` as the query carries it -> a YYYY-MM-DD date in the past, or null
// for "now" (today or later, or anything unparseable: the newest filings)
export function asOfDate(v: unknown): IsoDate | null {
  const s = String(v ?? '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && s < new Date().toISOString().slice(0, 10) ? s : null;
}

// Every scored filing as columns (index/screen-asof-<year>.json, one file
// per year of filing date): what the browser needs to pick each company's
// filing itself, for any date in that stretch. A filing record is ~150
// compressed bytes, so a year of them runs to megabytes and the whole store
// would only get bigger as the crawler fills in history - hence one file a
// year, fetched only when a date is set and only for the years that date
// can reach (ASOF_SHARD_YEARS). The company and market columns still come
// from index/screen.json.

// Which years a date needs: its own and the two before it. A company's
// current filing at `asof` is at most a year old (an annual filer), and the
// previous / year-earlier ones it is compared with are a year behind that.
export const ASOF_SHARD_YEARS = 3;
export const asOfShardYears = (asof: IsoDate | null, available: readonly number[] | null = null): number[] => {
  const y = Number(String(asof || new Date().toISOString()).slice(0, 4)); // no date = now
  const want = Number.isFinite(y) ? Array.from({ length: ASOF_SHARD_YEARS }, (_, i) => y - i) : [];
  return available ? want.filter((x) => available.includes(x)) : want;
};
// the filing year a record belongs to (by filing date - the day it became
// public - so a date never needs a shard it cannot know about)
export const asOfShardOf = (score: { filingDate?: IsoDate | null; periodEnd?: IsoDate | null }): number | null => Number(String(score.filingDate || score.periodEnd || '').slice(0, 4)) || null;

const ASOF_KEYS = ['cik', 'accession', 'form', 'filingDate', 'periodEnd', 'fiscalYear', 'fiscalPeriod', 'score', 'coverage'];
export function screenAsOfColumns(scores: readonly Score[]): AsOfColumns {
  const n = scores.length;
  const col = <T,>(get: (s: Score) => T | null | undefined): Column<T> => {
    const a = new Array<T | null>(n);
    for (let i = 0; i < n; i++) a[i] = get(scores[i]!) ?? null;
    return a;
  };
  const valueKeys = new Set<string>();
  for (const s of scores) for (const k of Object.keys(s.values || {})) valueKeys.add(k);
  return {
    n,
    ...Object.fromEntries(ASOF_KEYS.map((k) => [k, col((s) => (s as unknown as Record<string, unknown>)[k])])),
    categories: col((s) => s.categories?.map((c) => c.score)),
    values: Object.fromEntries([...valueKeys].map((k) => [k, col((s) => s.values?.[k])])),
  } as unknown as AsOfColumns;
}

// The loaded year files with each company's filings listed newest first
// (the light fields pickAsOf reads, and which shard row each one is): built
// once per set of loaded years, then reused for every date the page asks
// for. The shards are not merged - a filing is addressed by (shard, row),
// so loading another year copies nothing.
export function screenAsOfIndex(shards: AsOfColumns[] | AsOfColumns): AsOfIndex {
  const list = Array.isArray(shards) ? shards : [shards];
  const byCik = new Map<number, AsOfRef[]>();
  list.forEach((cols, s) => {
    for (let j = 0; j < cols.n; j++) {
      const cik = cols.cik[j]!;
      const of = byCik.get(cik) || byCik.set(cik, []).get(cik)!;
      of.push({ s, j, form: cols.form[j]!, filingDate: cols.filingDate[j]!, periodEnd: cols.periodEnd[j]!, fiscalYear: cols.fiscalYear[j]!, fiscalPeriod: cols.fiscalPeriod[j]!, coverage: cols.coverage[j]! });
    }
  });
  // newest first, as the store hands a company's scores over: by the period
  // the filing covers, the filing date breaking a tie
  for (const of of byCik.values()) of.sort((a, b) => (a.periodEnd! < b.periodEnd! ? 1 : a.periodEnd! > b.periodEnd! ? -1 : a.filingDate! < b.filingDate! ? 1 : a.filingDate! > b.filingDate! ? -1 : 0));
  return { shards: list, byCik };
}

// company / market columns (index/screen.json, or any screenTable) + the
// per-filing columns -> the table screenQuery reads, as of `asof`. Only the
// companies that had a filing out by then are in it.
export function screenAsOfTable(core: readonly ScreenRow[] | ScreenColumns | ScreenTable, index: AsOfIndex, asof: IsoDate | null): ScreenTable {
  const t = screenTable(core);
  const { shards, byCik } = index;
  const picks: { i: number; cur: AsOfRef; prev: AsOfRef | null; yoy: AsOfRef | null; history: number }[] = [];
  for (let i = 0; i < t.length; i++) {
    const p = pickAsOf(byCik.get(t.cik(i)) || [], asof);
    if (p.cur) picks.push({ i, cur: p.cur, prev: p.prev, yoy: p.yoy, history: p.history });
  }
  const at = (k: number, mode: string) => (mode === 'now' ? picks[k]!.cur : picks[k]![mode === 'chg' ? 'prev' : 'yoy']);
  const field = (r: AsOfRef | null, key: string) => (r ? (((shards[r.s] as unknown as Record<string, Column<unknown>>)[key]?.[r.j] ?? null) as number | string | null) : null); // one column of one filing
  const value = (r: AsOfRef | null, key: string) => (r ? (shards[r.s]!.values[key]?.[r.j] ?? null) : null);
  const valueKeys = [...new Set(shards.flatMap((c) => Object.keys(c.values)))];
  const valuesAt = (r: AsOfRef | null) => {
    const o: RatioValues = {};
    for (const key of valueKeys) o[key] = value(r, key);
    return o;
  };
  const baseAt = (r: AsOfRef | null): ScoreBrief | null =>
    !r ? null : ({ fiscalYear: field(r, 'fiscalYear'), fiscalPeriod: field(r, 'fiscalPeriod'), periodEnd: field(r, 'periodEnd'), score: field(r, 'score'), values: valuesAt(r) } as unknown as ScoreBrief);
  return {
    length: picks.length,
    cik: (k) => t.cik(picks[k]!.i),
    ticker: (k) => t.ticker(picks[k]!.i),
    tickers: (k) => t.tickers(picks[k]!.i),
    name: (k) => t.name(picks[k]!.i),
    sic: (k) => t.sic(picks[k]!.i),
    afs: (k) => t.afs(picks[k]!.i),
    float: (k) => t.float(picks[k]!.i),
    market: (k, key) => t.market(picks[k]!.i, key),
    score: (k) => field(picks[k]!.cur, 'score') as number | null,
    value: (k, key) => value(picks[k]!.cur, key),
    baseScore: (k, mode) => field(at(k, mode), 'score') as number | null,
    baseValue: (k, key, mode) => value(at(k, mode), key),
    // the company half of the row as it always is, the filing half as of the date
    row: (k) => {
      const p = picks[k]!;
      return {
        ...t.row(p.i),
        score: Object.fromEntries(SCORE_KEYS.map((key) => [key, field(p.cur, key)])),
        values: valuesAt(p.cur),
        prev: baseAt(p.prev),
        yoy: baseAt(p.yoy),
        history: p.history,
      } as unknown as ScreenRow;
    },
  };
}

// change since the previous filing (chg) or the same period a year earlier
// (yoy): percentage points for ratios, % growth for amounts and the score
function changeOf(t: ScreenTable, i: number, key: string, mode: string): number | null {
  const a = key === 'score' ? t.score(i) : t.value(i, key);
  const b = key === 'score' ? t.baseScore(i, mode) : t.baseValue(i, key, mode);
  if (a == null || b == null) return null;
  return pctField(key) ? (b === 0 ? null : ((a - b) / Math.abs(b)) * 100) : a - b;
}
const valueOf = (t: ScreenTable, i: number, key: string, mode = 'now'): number | string | null => {
  if (MARKET_KEYS.has(key)) return mode === 'now' ? t.market(i, key) : null;
  if (mode !== 'now') return changeOf(t, i, key, mode);
  return key === 'score' ? t.score(i) : t.value(i, key);
};

// The row half of a query - sic / division / afs / exclusions / text and
// the <key>[_chg|_yoy]_min|max ranges - as a predicate over a screenTable,
// so that whoever needs to ask "does this row pass?" outside screenQuery
// (the rule ETF replays it at every filing date, ruleEtf.ts) asks the one
// implementation. `market: false` leaves the market-snapshot conditions out
// and lists them in `skipped`: the snapshot is today's, so it cannot answer
// for a past date.
/** A row predicate plus what it could not answer. */
export interface ScreenFilter {
  test: (t: ScreenTable, i: number) => boolean;
  ranges: { key: string; mode: string; op: string; value: number }[];
  skipped: string[];
}

export function screenFilter(q: ScreenQueryParams, { market = true }: { market?: boolean } = {}): ScreenFilter {
  const sic = q.sic ? String(q.sic).padStart(4, '0') : null;
  const sic2 = q.sic2 ? String(q.sic2).padStart(2, '0') : null;
  const division = q.division ? SIC.divisions.find((d) => d.id === String(q.division).toUpperCase()) : null;
  const exDiv = String(q.exdiv || '')
    .split(',')
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean)
    .map((id) => SIC.divisions.find((d) => d.id === id))
    .filter((d): d is (typeof SIC.divisions)[number] => !!d);
  const exSic = String(q.exsic || '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => /^\d{2,4}$/.test(x));
  const afs = q.afs ? String(q.afs).toUpperCase() : null;
  const text = String(q.q || '').trim().toUpperCase();
  const listedOnly = q.listed !== '0';
  const ranges: { key: string; mode: string; op: string; value: number }[] = [];
  const skipped: string[] = [];
  for (const [k, v] of Object.entries(q)) {
    const m = /^(.+?)(?:_(chg|yoy))?_(min|max)$/.exec(k);
    if (!m || v === '' || !Number.isFinite(Number(v))) continue;
    const f = fieldOf(m[1]!);
    if (!f) continue;
    if (m[2] && f.market) continue; // no history for market fields
    if (f.market && !market) {
      if (!skipped.includes(m[1]!)) skipped.push(m[1]!);
      continue;
    }
    ranges.push({ key: m[1]!, mode: m[2] || 'now', op: m[3]!, value: Number(v) });
  }
  const test = (t: ScreenTable, i: number) => {
    if (listedOnly && !t.ticker(i)) return false;
    const code = t.sic(i) || '0000';
    if (sic && code !== sic) return false;
    if (sic2 && !code.startsWith(sic2)) return false;
    if (division && !(code.slice(0, 2) >= division.from && code.slice(0, 2) <= division.to)) return false;
    if (exDiv.some((d) => code.slice(0, 2) >= d.from && code.slice(0, 2) <= d.to)) return false;
    if (exSic.some((x) => code.startsWith(x))) return false;
    if (afs && (t.afs(i) || 'UNKNOWN') !== afs) return false;
    if (text && !(t.name(i).toUpperCase().includes(text) || (t.tickers(i) || []).some((x) => x.startsWith(text)))) return false;
    for (const x of ranges) {
      const v = valueOf(t, i, x.key, x.mode) as number | null;
      if (v == null || (x.op === 'min' ? v < x.value : v > x.value)) return false;
    }
    return true;
  };
  return { test, ranges, skipped };
}

// The query of GET /api/screen applied to the rows (an array of screenRow
// objects, the columns of screenColumns, or a screenTable of either):
// screenFilter's conditions, then sort and limit. (history=1 is the page's
// hint that it shows change columns: no effect here, see wantsHistory. asof
// picks which filing every row is, which the caller has already done in
// building the table: see pickAsOf.)
/** What screenQuery answers with. */
export interface ScreenResult {
  total: number;
  count: number;
  rows: ScreenRow[];
}

export function screenQuery(rows: readonly ScreenRow[] | ScreenColumns | ScreenTable, q: ScreenQueryParams): ScreenResult {
  const t = screenTable(rows);
  const { test } = screenFilter(q);
  const out: number[] = [];
  for (let i = 0; i < t.length; i++) if (test(t, i)) out.push(i);
  const sortKey = String(q.sort || 'score');
  const sortMode = ['chg', 'yoy'].includes(String(q.sortmode || '')) ? String(q.sortmode) : 'now';
  const dir = q.dir === 'asc' ? 1 : -1;
  const sv = (i: number) => (sortMode !== 'now' ? changeOf(t, i, sortKey, sortMode) : MARKET_KEYS.has(sortKey) ? t.market(i, sortKey) : sortKey === 'score' ? t.score(i) : sortKey === 'float' ? t.float(i) : sortKey === 'name' ? t.name(i) : sortKey === 'ticker' ? t.ticker(i) : t.value(i, sortKey));
  const keys = out.map(sv);
  const order = out.map((_, k) => k);
  order.sort((a, b) => {
    const x = keys[a]!;
    const y = keys[b]!;
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
  const limit = Math.min(2000, Math.max(1, Number(q.limit) || 300));
  return { total: out.length, count: Math.min(out.length, limit), rows: order.slice(0, limit).map((k) => t.row(out[k]!)) };
}

// does a query need the market snapshot (so the server may wait for it)?
export const wantsMarket = (q: ScreenQueryParams): boolean => Object.keys(q).some((k) => MARKET_KEYS.has(k.replace(/(?:_(?:chg|yoy))?_(?:min|max)$/, ''))) || MARKET_KEYS.has(String(q.sort || ''));

// ---- browse lists ----

export const companyRow = (c: UniverseCompany) => ({
  cik: c.cik,
  name: c.name,
  ticker: c.ticker,
  tickers: c.tickers,
  sic: c.sic,
  sicZh: sicInfo(c.sic)?.zh || null,
  sicTitle: sicInfo(c.sic)?.title || null,
  afs: c.afs,
  wksi: c.wksi,
  float: c.float,
  floatDate: c.floatDate,
  floatAdjusted: c.floatAdjusted,
  form: c.form,
  period: c.period,
  filed: c.filed,
  state: c.state,
  country: c.country,
});

// SIC divisions and 4-digit codes with company counts
export function sicCounts(companies: readonly UniverseCompany[]) {
  const counts = new Map<string, { total: number; listed: number }>();
  for (const c of companies) {
    const k = c.sic || '0000';
    const n = counts.get(k) || { total: 0, listed: 0 };
    n.total++;
    if (c.ticker) n.listed++;
    counts.set(k, n);
  }
  const codes: (SicCode & { total: number; listed: number })[] = SIC.codes.map((s) => ({ ...s, ...(counts.get(s.code) || { total: 0, listed: 0 }) }));
  // codes that appear in filings but not on SEC's list
  for (const [code, n] of counts) if (!SIC.codes.some((s) => s.code === code)) codes.push({ code, title: null, zh: code === '0000' ? '未指定' : null, division: 'J', office: null, ...n });
  return { divisions: SIC.divisions, codes };
}

// filer-status categories with counts
/** One filer-status category with its company counts. */
export interface FilerCount {
  key: string;
  label: string;
  zh: string;
  note?: string;
  total: number;
  listed: number;
  wksi: number;
}

export function filerCounts(companies: readonly UniverseCompany[]): FilerCount[] {
  const counts: Record<string, { total: number; listed: number; wksi: number }> = {};
  for (const c of companies) {
    const k = c.afs || 'UNKNOWN';
    counts[k] ??= { total: 0, listed: 0, wksi: 0 };
    counts[k]!.total++;
    if (c.ticker) counts[k]!.listed++;
    if (c.wksi) counts[k]!.wksi++;
  }
  return [...Object.keys(FILER_STATUS), 'UNKNOWN'].map((k) => ({
    key: k,
    ...(FILER_STATUS[k as keyof typeof FILER_STATUS] || { label: 'Not stated', zh: '未標示', note: '申報書未標示身分' }),
    ...(counts[k] || { total: 0, listed: 0, wksi: 0 }),
  }));
}

// companies of a SIC code / filer status, largest public float first (the universe is already sorted so)
export function browseCompanies(companies: readonly UniverseCompany[], query: ScreenQueryParams) {
  const sic = query.sic ? String(query.sic).padStart(4, '0') : null;
  const afs = query.afs ? String(query.afs).toUpperCase() : null;
  const listedOnly = query.listed !== '0';
  const q = String(query.q || '').trim().toUpperCase();
  let rows = companies;
  if (sic) rows = rows.filter((c) => (c.sic || '0000') === sic);
  if (afs) rows = rows.filter((c) => (c.afs || 'UNKNOWN') === afs);
  if (listedOnly) rows = rows.filter((c) => c.ticker);
  if (q) rows = rows.filter((c) => c.name.toUpperCase().includes(q) || c.tickers.some((t) => t.startsWith(q)));
  return {
    sic: sic ? sicInfo(sic) : null,
    filer: afs ? { key: afs, ...(FILER_STATUS[afs as keyof typeof FILER_STATUS] || { label: 'Not stated', zh: '未標示' }) } : null,
    count: rows.length,
    companies: rows.slice(0, Number(query.limit) || 2000).map(companyRow),
  };
}

// ticker / company-name suggestions (ticker prefix first, then names)
export function searchRows<T extends { ticker: string; name: string }>(rows: readonly T[], q: string, limit = 10): T[] {
  const needle = String(q).trim().toUpperCase().replace(/\./g, '-');
  if (!needle) return [];
  const starts = rows.filter((r) => r.ticker.startsWith(needle));
  const names = rows.filter((r) => !r.ticker.startsWith(needle) && r.name.toUpperCase().includes(needle));
  return [...starts, ...names].slice(0, limit);
}

// the score summary every list shows next to a company
export const scoreBadge = (s: Score | null | undefined): ScoreBadge | null => (s ? { score: s.score, coverage: s.coverage, accession: s.accession, form: s.form, fiscalYear: s.fiscalYear, fiscalPeriod: s.fiscalPeriod, periodEnd: s.periodEnd, filingDate: s.filingDate, categories: s.categories.map((c) => c.score) } : null);
