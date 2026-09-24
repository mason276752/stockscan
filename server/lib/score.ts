// Scores backed by the store: score a saved filing, the newest score of
// every company (for the screener). The scoring itself is in scoreModel.ts
// (no I/O, shared with the browser build).

import zlib from 'node:zlib';

import { store } from './store.ts';
import { reclassify } from './statementTypes.ts';
import { fiscalLabel } from './filings.ts';
import { SCORE_VERSION, CATEGORIES, ITEMS, scoreValues, singleFilingInputs, BALANCE_AMOUNTS, FLOW_AMOUNTS, AMOUNT_FIELDS, scoreFiling, scoreFilingOf } from './scoreModel.ts';
import { SCORE_HISTORY, asOfKept, asOfReader, asOfSubset, pickAsOf, screenAsOfColumns, screenAsOfIndex } from './screen.ts';
import { collapseAmendments } from './filings.ts';
import type { AsOfColumns, AsOfIndex, Company, FilingHeader, FilingRef, IsoDate, Score, ScoreRow, ScoreWithHistory, ScrapeResult } from './types.ts';

export { SCORE_VERSION, CATEGORIES, ITEMS, scoreValues, singleFilingInputs, BALANCE_AMOUNTS, FLOW_AMOUNTS, AMOUNT_FIELDS, scoreFiling, scoreFilingOf, SCORE_HISTORY };

// A company's saved filings around `reportDate` as scoreFilingOf wants them
// (the fiscal labels come from the saved headers, relabelled from the
// company's fiscal year end when its submissions record is on disk - as the
// static build does), from the store alone so scoring never waits on SEC.
// Scoring one filing needs at most the year's 10-Qs and the quarter before.
const WINDOW_DAYS = 480;
function savedCompany(cik: number, reportDate: IsoDate): Company {
  const fye = store.getDoc<{ fiscalYearEnd?: string | null }>(`companies/${String(cik).padStart(10, '0')}.json`)?.value?.fiscalYearEnd || null;
  const from = new Date(new Date(reportDate).getTime() - WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  const filings: FilingRef[] = [];
  for (const r of store.filingIndex(cik)) {
    if (!r.report_date || r.report_date < from || r.report_date > reportDate) continue;
    const h = store.filingHeader(r.accession);
    if (!h) continue;
    const form = h.form || r.form || '';
    const end = h.periodEnd || r.report_date;
    const label = fye ? fiscalLabel(form, end, fye) : { fiscalYear: h.fiscalYear ? Number(h.fiscalYear) : null, fiscalPeriod: h.fiscalPeriod || null };
    filings.push({ accession: r.accession, cik: Number(cik), form, filingDate: h.filingDate || null, reportDate: end, ...label });
  }
  filings.sort((a, b) => (a.filingDate! < b.filingDate! ? 1 : a.filingDate! > b.filingDate! ? -1 : 0));
  return { cik: Number(cik), filings };
}

const loadSaved = (f: { accession: string }): ScrapeResult => {
  const data = store.getFiling(f.accession);
  if (!data) throw new Error(`${f.accession} not saved`);
  return reclassify(data);
};

// The score of a saved filing, computed from the store alone (no cache).
async function computeScore(accession: string, header?: FilingHeader | null): Promise<Score | null> {
  const h = header || store.filingHeader(accession);
  if (!h) return null;
  const company = savedCompany(h.cik, h.periodEnd!);
  const filing = company.filings.find((f) => f.accession === accession);
  return filing ? await scoreFilingOf(loadSaved as never, company, filing) : scoreFiling(loadSaved({ accession }));
}

// Score of a saved filing, cached by accession. A score that had to do
// without a neighbouring filing (`basis.partial`: typically the oldest one
// saved of a company) is cached like any other - the screener still wants
// it as the year-earlier comparison - and recomputed when the crawler asks
// (`redoPartial`) after saving more of the company's filings.
export async function scoreAccession(accession: string, { redoPartial = false, force = false }: { redoPartial?: boolean; force?: boolean } = {}): Promise<Score | null> {
  const hit = store.getScore(accession, SCORE_VERSION);
  // `force`: the filing itself changed under it (a stand-in rebuilt from the
  // quarterly datasets replaced by the parse of the document, scrape.ts)
  if (hit && !force && !(redoPartial && hit.basis?.partial)) return hit;
  const h = store.filingHeader(accession);
  if (!h) return null;
  const s = await computeScore(accession, h);
  if (s) {
    store.putScore(accession, h.cik, h.periodEnd, SCORE_VERSION, s);
    forgetScore(accession);
  }
  return s;
}

// Score every saved filing without a current score (a new version, or
// filings saved before scoring existed), `budgetMs` at a time between yields
// so a server stays responsive.
export async function scoreUnscored({ budgetMs = 50, log = (_m: string) => {} }: { budgetMs?: number; log?: (m: string) => void } = {}): Promise<number> {
  const todo = store.unscoredAccessions(SCORE_VERSION);
  if (!todo.length) return 0;
  log(`scoring ${todo.length} saved filings`);
  let t0 = Date.now();
  let partial = 0;
  for (const acc of todo) {
    try {
      const s = await scoreAccession(acc);
      if (s?.basis.partial) partial++;
    } catch (err) {
      console.warn(`score ${acc}: ${(err as Error).message}`);
    }
    if (Date.now() - t0 > budgetMs) {
      await new Promise<void>((r) => setTimeout(r, 20));
      t0 = Date.now();
    }
  }
  log(`scoring done${partial ? ` (${partial} scored alone: a neighbouring filing is not saved)` : ''}`);
  return todo.length;
}

// Recompute every saved filing's score at the current SCORE_VERSION and
// write back only the ones that really changed (`node server/tools/rescore.mjs
// --all`). This is how a scoring change that touches few filings reaches the
// data ref without a version bump: a bump renames all 30,000 score files and
// the ref has to carry every one of them again, while an in-place rewrite of
// the handful that moved is a commit of a few kilobytes. Same numbers either
// way - what the version buys is that a store nobody ran this over is
// recomputed lazily, so bump it when the change is broad.
/** How far a rescore got. */
export interface RescoreProgress {
  scanned: number;
  changed: number;
  failed: number;
}

export interface RescoreOptions {
  budgetMs?: number;
  log?: (m: string) => void;
  cik?: number | string | null;
  limit?: number;
  dryRun?: boolean;
  onProgress?: ((p: RescoreProgress) => void) | null;
}

export async function rescoreAll({ budgetMs = 50, log = (_m: string) => {}, cik = null, limit = 0, dryRun = false, onProgress = null }: RescoreOptions = {}): Promise<RescoreProgress> {
  let todo = store.allFilings();
  if (cik) todo = todo.filter((f) => Number(f.cik) === Number(cik));
  if (limit) todo = todo.slice(0, limit);
  log(`rescoring ${todo.length} saved filings (${dryRun ? 'dry run: nothing is written' : 'writing only what changes'})`);
  const out: RescoreProgress = { scanned: 0, changed: 0, failed: 0 };
  let t0 = Date.now();
  for (const f of todo) {
    out.scanned++;
    try {
      const h = store.filingHeader(f.accession);
      const s = h && (await computeScore(f.accession, h));
      if (s) {
        const prev = store.getScore(f.accession, SCORE_VERSION);
        if (!prev || JSON.stringify(prev) !== JSON.stringify(s)) {
          if (!dryRun) {
            store.putScore(f.accession, h!.cik, h!.periodEnd, SCORE_VERSION, s);
            forgetScore(f.accession);
          }
          out.changed++;
        }
      }
    } catch (err) {
      out.failed++;
      console.warn(`rescore ${f.accession}: ${(err as Error).message}`);
    }
    if (onProgress && out.scanned % 500 === 0) onProgress(out);
    if (Date.now() - t0 > budgetMs) {
      await new Promise<void>((r) => setTimeout(r, 5));
      t0 = Date.now();
    }
  }
  log(`rescored ${out.scanned}: ${out.changed} changed${out.failed ? `, ${out.failed} failed` : ''}`);
  return out;
}

// ---- the decoded scores ----
// Both readers below want the same thing off a score - the ratios, the
// category scores and which filing it is of - and neither looks at `items`,
// the seventeen benchmark rows with their names and thresholds that make up
// three quarters of its bytes. So a score is read without them (ScoreRow);
// holding them whole was well over a gigabyte for the sake of a field
// nothing in this file touches.
function readScoreRow(accession: string): ScoreRow | null {
  const s = store.scoreJson(accession);
  if (!s) return null;
  // rest-destructured rather than deleted: `items` is by far the biggest
  // field, and dropping it by hand would leave the object in dictionary mode
  const { items, ...row } = s;
  return row;
}
// The current score of each company, which the screener asks for again on
// every refresh - a few thousand rows, kept for the life of the process.
// The bulk reads below do not go through it: what they produce is the as-of
// columns, and those are the cache.
const decoded = new Map<string, ScoreRow | null>(); // accession -> the score without its items
function scoreOf(accession: string): ScoreRow | null {
  let row = decoded.get(accession);
  if (row === undefined) decoded.set(accession, (row = readScoreRow(accession)));
  return row;
}

// Every company's current score as of a date (null = now), for the
// screener. Which filing that is, and the two the change filters compare it
// against, are read off the as-of index below - columns already in memory -
// so the only score files opened are the current ones: one per company,
// where this used to decode the newest six periods of every one of them.
// One row set per date is memoised, a few dates at a time.
const latestMemo = new Map<string, { n: number; at: number; rows: ScoreWithHistory[] }>(); // asof ('' = now) -> { n, at, rows }
export function latestScores(asof: IsoDate | null = null): ScoreWithHistory[] {
  const key = asof || '';
  const n = store.scoreCount(SCORE_VERSION);
  const hit = latestMemo.get(key);
  if (hit && hit.n === n && Date.now() - hit.at < 60_000) return hit.rows;
  const index = asOfIndex();
  const read = asOfReader(index);
  const rows: ScoreWithHistory[] = [];
  for (const filings of index.byCik.values()) {
    const { cur, prev, yoy, history } = pickAsOf(filings, asof);
    const s = cur && scoreOf(read.field(cur, 'accession') as string);
    if (!s) continue;
    rows.push({ ...s, prev: read.brief(prev), yoy: read.brief(yoy), history });
  }
  if (decoded.size > 60_000) decoded.clear(); // a date of its own reaches every filing there is
  if (latestMemo.size > 4) latestMemo.clear();
  latestMemo.set(key, { n, at: Date.now(), rows });
  return rows;
}

// ---- the as-of index ----
// Every saved score as the as-of index the screener's time machine reads
// (screen.ts): each company's filings newest first, the values addressed by
// (shard, row). This is what a rule ETF replays (ruleEtf.ts) - it asks for
// every filing at once, not for one date.
//
// Reading all ~200,000 score files takes fifteen seconds and a rule ETF
// cannot start until it is done, so the columns are also written out as one
// file beside the kv cache - 35 MB, read back in well under a second - and
// only the scores saved since it was written are read from the store.
// Those go in as a *second shard*, which is how an as-of index addresses
// its rows anyway (the static build ships one shard per filing year), so
// there is nothing to merge.
const ASOF_FILE = `asof-v${SCORE_VERSION}.json.zst`;
// how much may pile up beside the file before it is written afresh: past
// this, reading the leftover from the store on every start costs more than
// the occasional rewrite it takes to fold it in
const ASOF_REWRITE = 20_000;

/** The saved shard and the accessions it holds; null = there is no usable file. */
let asOfSaved: { cols: AsOfColumns; have: Set<string> } | null | undefined; // undefined: not looked for yet

function savedAsOfShard(): { cols: AsOfColumns; have: Set<string> } | null {
  if (asOfSaved !== undefined) return asOfSaved;
  const buf = store.readCache(ASOF_FILE);
  try {
    const cols = buf ? (JSON.parse(zlib.zstdDecompressSync(buf).toString('utf8')) as AsOfColumns) : null;
    asOfSaved = cols?.n ? { cols, have: new Set(cols.accession as string[]) } : null;
  } catch (err) {
    console.warn(`score: 讀取 ${ASOF_FILE} 失敗，改為重建：${(err as Error).message}`);
    asOfSaved = null;
  }
  return asOfSaved;
}

// Every score the store has been given since this process started. A new
// one only adds a row to what is on disk; one written *over* an accession
// the saved shard already holds leaves a row in the file that is no longer
// what the store says - which the count the memos hang on cannot notice,
// since it does not move for a write in place.
const written = new Set<string>();
function forgetScore(accession: string): void {
  written.add(accession);
  decoded.delete(accession);
  asOfMemo = null;
  latestMemo.clear();
}

const rowsOf = (accessions: readonly string[]): ScoreRow[] => accessions.map(readScoreRow).filter((s): s is ScoreRow => !!s);

// The saved shard, minus anything it no longer agrees with, plus a shard of
// the scores it does not have. `rewrite` says the file is worth writing out
// again: it has rows in it that are gone, or it never existed.
function asOfShards(): { shards: AsOfColumns[]; rewrite: boolean } {
  const saved = savedAsOfShard();
  const scored = new Set<string>();
  const missing: string[] = [];
  for (const r of store.scoreIndex(SCORE_VERSION)) {
    if (!r.report_date) continue;
    scored.add(r.accession);
    // covered by the file, unless it has been written over since
    if (!saved?.have.has(r.accession) || written.has(r.accession)) missing.push(r.accession);
  }
  if (!saved) return { shards: [screenAsOfColumns(rowsOf([...scored]))], rewrite: true };
  // A row the file holds that the store has dropped, or one written over
  // since, is not what the store says any more. It is cut out of the shard -
  // columns trimmed in memory, with not one score file opened for it - and
  // read again below along with everything the file never had.
  const base = asOfKept(saved.cols, (a) => scored.has(a) && !written.has(a));
  return { shards: [base, screenAsOfColumns(rowsOf(missing))], rewrite: base !== saved.cols };
}

// the index as one shard again, written out for the next start
function saveAsOfShard(index: AsOfIndex): void {
  const cols = asOfSubset(index, [...index.byCik.values()].flat());
  // level 3: a cache of numbers rewritten now and then, so the time it takes
  // to compress matters more than the last few MB of it
  store.writeCache(ASOF_FILE, zlib.zstdCompressSync(Buffer.from(JSON.stringify(cols)), { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } }));
  asOfSaved = { cols, have: new Set(cols.accession as string[]) };
  written.clear(); // the file now says what the store says
}

let asOfMemo: { n: number; index: AsOfIndex } | null = null;
export function asOfIndex(): AsOfIndex {
  const n = store.scoreCount(SCORE_VERSION);
  if (asOfMemo?.n === n) return asOfMemo.index;
  const { shards, rewrite } = asOfShards();
  const index = screenAsOfIndex(shards);
  // the leftover shard is folded into the file once enough has piled up
  // beside it: reading it from the store on every start eventually costs
  // more than the one rewrite it takes to be rid of it
  if (rewrite || (shards[1]?.n ?? 0) > ASOF_REWRITE) saveAsOfShard(index);
  asOfMemo = { n, index };
  return index;
}

// Latest saved filing of a company and its score (null when nothing is
// saved yet). A period that was amended is read as its amendment, unless
// that one has no statements in it (filings.ts collapseAmendments).
const thinSaved = (r: { accession: string }) => {
  const s = store.getScore(r.accession, SCORE_VERSION);
  return s ? !(Number(s.coverage) > 0) : false; // not scored yet: nothing says it is empty
};
export async function latestScore(cik: number | string): Promise<Score | null> {
  const rows = store
    .filingIndex(cik)
    .filter((r) => r.report_date)
    .map((r) => ({ ...r, periodEnd: r.report_date }));
  if (!rows.length) return null;
  rows.sort((a, b) => (a.report_date! < b.report_date! ? 1 : a.report_date! > b.report_date! ? -1 : 0));
  const pick = collapseAmendments(rows, thinSaved)[0];
  return pick ? scoreAccession(pick.accession) : null;
}
