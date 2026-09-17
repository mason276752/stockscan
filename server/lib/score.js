// Scores backed by the store: score a saved filing, the newest score of
// every company (for the screener). The scoring itself is in scoreModel.js
// (no I/O, shared with the browser build).

import { store } from './store.js';
import { reclassify } from './statementTypes.js';
import { fiscalLabel } from './filings.js';
import { SCORE_VERSION, CATEGORIES, ITEMS, scoreValues, singleFilingInputs, BALANCE_AMOUNTS, FLOW_AMOUNTS, AMOUNT_FIELDS, scoreFiling, scoreFilingOf } from './scoreModel.js';

export { SCORE_VERSION, CATEGORIES, ITEMS, scoreValues, singleFilingInputs, BALANCE_AMOUNTS, FLOW_AMOUNTS, AMOUNT_FIELDS, scoreFiling, scoreFilingOf };

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

// Score of a saved filing, cached by accession. A score that had to do
// without a neighbouring filing (`basis.partial`: typically the oldest one
// saved of a company) is cached like any other - the screener still wants
// it as the year-earlier comparison - and recomputed when the crawler asks
// (`redoPartial`) after saving more of the company's filings.
export async function scoreAccession(accession, { redoPartial = false } = {}) {
  const hit = store.getScore(accession, SCORE_VERSION);
  if (hit && !(redoPartial && hit.basis?.partial)) return hit;
  const h = store.filingHeader(accession);
  if (!h) return null;
  const company = savedCompany(h.cik, h.periodEnd);
  const filing = company.filings.find((f) => f.accession === accession);
  const s = filing ? await scoreFilingOf(loadSaved, company, filing) : scoreFiling(loadSaved({ accession }));
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

// Latest score of every company (for the screener), each with the previous
// filing's values (`prev`) and the same period a year earlier (`yoy`) for
// change filters. Cached for a minute; decoded score JSON is kept per
// accession so a refresh only decodes what is new.
// a company's scores newest first -> the newest with `prev` / `yoy` attached
export function withHistory(scores) {
  const hist = scores.filter((x) => x && !/\/A$/i.test(x.form || ''));
  if (!hist.length) return null;
  const cur = hist[0];
  const prev = hist[1] || null;
  const yoy = hist.find((x, i) => i > 0 && x.fiscalPeriod === cur.fiscalPeriod && String(Number(x.fiscalYear) + 1) === String(cur.fiscalYear)) || null;
  const brief = (x) => ({ accession: x.accession, fiscalYear: x.fiscalYear, fiscalPeriod: x.fiscalPeriod, periodEnd: x.periodEnd, score: x.score, values: x.values });
  return { ...cur, prev: prev ? brief(prev) : null, yoy: yoy ? brief(yoy) : null, history: hist.length };
}
export const SCORE_HISTORY = 6; // filings per company to look at for prev / yoy
let latestAllMemo = null;
const decoded = new Map(); // accession -> score
function scoreOf(accession) {
  if (!decoded.has(accession)) decoded.set(accession, store.scoreJson(accession));
  return decoded.get(accession);
}
export function latestScores() {
  const n = store.scoreCount(SCORE_VERSION);
  if (latestAllMemo && latestAllMemo.n === n && Date.now() - latestAllMemo.at < 60_000) return latestAllMemo.rows;
  const byCik = new Map();
  for (const r of store.scoreIndex(SCORE_VERSION)) {
    if (!r.report_date) continue;
    const list = byCik.get(r.cik) || [];
    if (list.length < SCORE_HISTORY) list.push(r.accession);
    byCik.set(r.cik, list);
  }
  const rows = [];
  for (const [, accs] of byCik) {
    const row = withHistory(accs.map(scoreOf));
    if (row) rows.push(row);
  }
  if (decoded.size > 60_000) decoded.clear();
  latestAllMemo = { n, at: Date.now(), rows };
  return rows;
}

// Latest saved filing of a company and its score (null when nothing is saved yet).
export async function latestScore(cik) {
  const rows = store.filingIndex(cik).filter((r) => r.report_date && !/\/A$/i.test(r.form || ''));
  if (!rows.length) return null;
  rows.sort((a, b) => (a.report_date < b.report_date ? 1 : a.report_date > b.report_date ? -1 : 0));
  return scoreAccession(rows[0].accession);
}
