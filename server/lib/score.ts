// Scores backed by the store: score a saved filing, the newest score of
// every company (for the screener). The scoring itself is in scoreModel.js
// (no I/O, shared with the browser build).

import { store } from './store.ts';
import { reclassify } from './statementTypes.ts';
import { fiscalLabel } from './filings.ts';
import { SCORE_VERSION, CATEGORIES, ITEMS, scoreValues, singleFilingInputs, BALANCE_AMOUNTS, FLOW_AMOUNTS, AMOUNT_FIELDS, scoreFiling, scoreFilingOf } from './scoreModel.ts';
import { SCORE_HISTORY, pickAsOf, screenAsOfColumns, screenAsOfIndex } from './screen.ts';
import { collapseAmendments } from './filings.ts';

export { SCORE_VERSION, CATEGORIES, ITEMS, scoreValues, singleFilingInputs, BALANCE_AMOUNTS, FLOW_AMOUNTS, AMOUNT_FIELDS, scoreFiling, scoreFilingOf, SCORE_HISTORY };

// A company's saved filings around `reportDate` as scoreFilingOf wants them
// (the fiscal labels come from the saved headers, relabelled from the
// company's fiscal year end when its submissions record is on disk - as the
// static build does), from the store alone so scoring never waits on SEC.
// Scoring one filing needs at most the year's 10-Qs and the quarter before.
const WINDOW_DAYS = 480;
function savedCompany(cik, reportDate) {
  const fye = store.getDoc(`companies/${String(cik).padStart(10, '0')}.json`)?.value?.fiscalYearEnd || null;
  const from = new Date(new Date(reportDate).getTime() - WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  const filings = [];
  for (const r of store.filingIndex(cik)) {
    if (!r.report_date || r.report_date < from || r.report_date > reportDate) continue;
    const h = store.filingHeader(r.accession);
    if (!h) continue;
    const form = h.form || r.form || '';
    const end = h.periodEnd || r.report_date;
    const label = fye ? fiscalLabel(form, end, fye) : { fiscalYear: h.fiscalYear ? Number(h.fiscalYear) : null, fiscalPeriod: h.fiscalPeriod || null };
    filings.push({ accession: r.accession, cik: Number(cik), form, filingDate: h.filingDate || null, reportDate: end, ...label });
  }
  filings.sort((a, b) => (a.filingDate < b.filingDate ? 1 : a.filingDate > b.filingDate ? -1 : 0));
  return { cik: Number(cik), filings };
}

const loadSaved = (f) => {
  const data = store.getFiling(f.accession);
  if (!data) throw new Error(`${f.accession} not saved`);
  return reclassify(data);
};

// The score of a saved filing, computed from the store alone (no cache).
async function computeScore(accession, header) {
  const h = header || store.filingHeader(accession);
  if (!h) return null;
  const company = savedCompany(h.cik, h.periodEnd);
  const filing = company.filings.find((f) => f.accession === accession);
  return filing ? await scoreFilingOf(loadSaved, company, filing) : scoreFiling(loadSaved({ accession }));
}

// Score of a saved filing, cached by accession. A score that had to do
// without a neighbouring filing (`basis.partial`: typically the oldest one
// saved of a company) is cached like any other - the screener still wants
// it as the year-earlier comparison - and recomputed when the crawler asks
// (`redoPartial`) after saving more of the company's filings.
export async function scoreAccession(accession, { redoPartial = false, force = false } = {}) {
  const hit = store.getScore(accession, SCORE_VERSION);
  // `force`: the filing itself changed under it (a stand-in rebuilt from the
  // quarterly datasets replaced by the parse of the document, scrape.js)
  if (hit && !force && !(redoPartial && hit.basis?.partial)) return hit;
  const h = store.filingHeader(accession);
  if (!h) return null;
  const s = await computeScore(accession, h);
  if (s) store.putScore(accession, h.cik, h.periodEnd, SCORE_VERSION, s);
  return s;
}

// Score every saved filing without a current score (a new version, or
// filings saved before scoring existed), `budgetMs` at a time between yields
// so a server stays responsive.
export async function scoreUnscored({ budgetMs = 50, log = () => {} } = {}) {
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
      console.warn(`score ${acc}: ${err.message}`);
    }
    if (Date.now() - t0 > budgetMs) {
      await new Promise((r) => setTimeout(r, 20));
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
export async function rescoreAll({ budgetMs = 50, log = () => {}, cik = null, limit = 0, dryRun = false, onProgress = null } = {}) {
  let todo = store.allFilings();
  if (cik) todo = todo.filter((f) => Number(f.cik) === Number(cik));
  if (limit) todo = todo.slice(0, limit);
  log(`rescoring ${todo.length} saved filings (${dryRun ? 'dry run: nothing is written' : 'writing only what changes'})`);
  const out = { scanned: 0, changed: 0, failed: 0 };
  let t0 = Date.now();
  for (const f of todo) {
    out.scanned++;
    try {
      const h = store.filingHeader(f.accession);
      const s = h && (await computeScore(f.accession, h));
      if (s) {
        const prev = store.getScore(f.accession, SCORE_VERSION);
        if (!prev || JSON.stringify(prev) !== JSON.stringify(s)) {
          if (!dryRun) store.putScore(f.accession, h.cik, h.periodEnd, SCORE_VERSION, s);
          out.changed++;
        }
      }
    } catch (err) {
      out.failed++;
      console.warn(`rescore ${f.accession}: ${err.message}`);
    }
    if (onProgress && out.scanned % 500 === 0) onProgress(out);
    if (Date.now() - t0 > budgetMs) {
      await new Promise((r) => setTimeout(r, 5));
      t0 = Date.now();
    }
  }
  log(`rescored ${out.scanned}: ${out.changed} changed${out.failed ? `, ${out.failed} failed` : ''}`);
  return out;
}

// Latest score of every company (for the screener), each with the previous
// filing's values (`prev`) and the same period a year earlier (`yoy`) for
// change filters. Cached for a minute; decoded score JSON is kept per
// accession so a refresh only decodes what is new.
// a company's scores newest first -> the one current at `asof` (null = the
// newest of all) with `prev` / `yoy` attached
export function withHistory(scores, asof = null) {
  const { cur, prev, yoy, history } = pickAsOf(scores, asof);
  if (!cur) return null;
  const brief = (x) => ({ accession: x.accession, fiscalYear: x.fiscalYear, fiscalPeriod: x.fiscalPeriod, periodEnd: x.periodEnd, score: x.score, values: x.values });
  return { ...cur, prev: prev ? brief(prev) : null, yoy: yoy ? brief(yoy) : null, history };
}
const decoded = new Map(); // accession -> score
function scoreOf(accession) {
  if (!decoded.has(accession)) decoded.set(accession, store.scoreJson(accession));
  return decoded.get(accession);
}
// Every company's current score as of a date (null = now), for the
// screener. Without a date only the newest SCORE_HISTORY filings of a
// company are decoded; with one every saved filing may be the current one,
// so all of them are (the decoded cache above makes the next date cheap).
// One row set per date is memoised, a few dates at a time.
const latestMemo = new Map(); // asof ('' = now) -> { n, at, rows }
export function latestScores(asof = null) {
  const key = asof || '';
  const n = store.scoreCount(SCORE_VERSION);
  const hit = latestMemo.get(key);
  if (hit && hit.n === n && Date.now() - hit.at < 60_000) return hit.rows;
  // the index comes sorted by company, newest period first. Without a date
  // only the newest SCORE_HISTORY *periods* are decoded - every version of
  // them, since an amendment shares its original's period end and pickAsOf
  // has to see both to choose.
  const byCik = new Map();
  for (const r of store.scoreIndex(SCORE_VERSION)) {
    if (!r.report_date) continue;
    const rec = byCik.get(r.cik) || byCik.set(r.cik, { accs: [], periods: new Set() }).get(r.cik);
    if (!asof && rec.periods.size >= SCORE_HISTORY && !rec.periods.has(r.report_date)) continue;
    rec.periods.add(r.report_date);
    rec.accs.push(r.accession);
  }
  const rows = [];
  for (const [, rec] of byCik) {
    const row = withHistory(rec.accs.map(scoreOf), asof);
    if (row) rows.push(row);
  }
  if (decoded.size > 60_000) decoded.clear();
  if (latestMemo.size > 4) latestMemo.clear();
  latestMemo.set(key, { n, at: Date.now(), rows });
  return rows;
}

// Every saved score as the as-of index the screener's time machine reads
// (screen.js): each company's filings newest first, the values addressed by
// (shard, row). The static build ships the same thing as one file per
// filing year; here it is one shard over the whole store, rebuilt only when
// the store has grown. This is what a rule ETF replays (ruleEtf.js) - it
// asks for every filing at once, not for one date.
let asOfMemo = null;
export function asOfIndex() {
  const n = store.scoreCount(SCORE_VERSION);
  if (asOfMemo?.n === n) return asOfMemo.index;
  const all = [];
  for (const r of store.scoreIndex(SCORE_VERSION)) {
    if (!r.report_date) continue;
    const s = scoreOf(r.accession);
    if (s) all.push(s);
  }
  asOfMemo = { n, index: screenAsOfIndex([screenAsOfColumns(all)]) };
  return asOfMemo.index;
}

// Latest saved filing of a company and its score (null when nothing is
// saved yet). A period that was amended is read as its amendment, unless
// that one has no statements in it (filings.js collapseAmendments).
const thinSaved = (r) => {
  const s = store.getScore(r.accession, SCORE_VERSION);
  return s ? !(Number(s.coverage) > 0) : false; // not scored yet: nothing says it is empty
};
export async function latestScore(cik) {
  const rows = store
    .filingIndex(cik)
    .filter((r) => r.report_date)
    .map((r) => ({ ...r, periodEnd: r.report_date }));
  if (!rows.length) return null;
  rows.sort((a, b) => (a.report_date < b.report_date ? 1 : a.report_date > b.report_date ? -1 : 0));
  const pick = collapseAmendments(rows, thinSaved)[0];
  return pick ? scoreAccession(pick.accession) : null;
}
