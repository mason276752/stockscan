// Scores backed by the store: score a saved filing, the newest score of
// every company (for the screener). The scoring itself is in scoreModel.js
// (no I/O, shared with the browser build).

import { store } from './store.js';
import { reclassify } from './statementTypes.js';
import { SCORE_VERSION, CATEGORIES, ITEMS, scoreValues, singleFilingInputs, BALANCE_AMOUNTS, FLOW_AMOUNTS, AMOUNT_FIELDS, scoreFiling } from './scoreModel.js';

export { SCORE_VERSION, CATEGORIES, ITEMS, scoreValues, singleFilingInputs, BALANCE_AMOUNTS, FLOW_AMOUNTS, AMOUNT_FIELDS, scoreFiling };

// Score of a saved filing, cached in SQLite by accession.
export function scoreAccession(accession) {
  const hit = store.getScore(accession, SCORE_VERSION);
  if (hit) return hit;
  const data = store.getFiling(accession);
  if (!data) return null;
  const s = scoreFiling(reclassify(data));
  if (s) store.putScore(accession, data.filing.cik, data.filing.periodEnd, SCORE_VERSION, s);
  return s;
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
export function latestScore(cik) {
  const rows = store.filingIndex(cik).filter((r) => r.report_date && !/\/A$/i.test(r.form || ''));
  if (!rows.length) return null;
  rows.sort((a, b) => (a.report_date < b.report_date ? 1 : a.report_date > b.report_date ? -1 : 0));
  return scoreAccession(rows[0].accession);
}
