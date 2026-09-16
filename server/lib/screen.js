// The screener and the browse lists as pure functions over in-memory rows,
// so the server route and the browser build (which loads the same rows from
// prebuilt JSON) share one implementation.

import { ROWS as INDICATOR_ROWS } from './indicators.js';
import { AMOUNT_FIELDS } from './scoreModel.js';
import { MARKET_FIELDS } from './marketFields.js';
import { FILER_STATUS, SIC, sicInfo } from './sic.js';

// Screener fields: the score, every indicator row, statement amounts (from
// the latest filing), and the market snapshot (price, market cap, multiples).
export const SCREEN_FIELDS = [
  { key: 'score', name: '評分', unit: '分', group: '評分' },
  ...INDICATOR_ROWS.filter((r) => !r.abstract).map((r) => ({ key: r.key, name: r.name, unit: r.unit, group: r.group, annualized: !!r.annualized })),
  ...AMOUNT_FIELDS,
  ...MARKET_FIELDS.map((f) => ({ ...f, market: true })),
];
export const MARKET_KEYS = new Set(MARKET_FIELDS.map((f) => f.key));
const fieldOf = (key) => SCREEN_FIELDS.find((f) => f.key === key);
const pctField = (key) => {
  const f = fieldOf(key);
  return f?.unit === '百萬' || f?.unit === '百萬股' || key === 'score';
};

// One screener row: a company's newest score (with prev / yoy), its
// universe record (industry, filer status, float) and market snapshot record.
export function screenRow(s, c, mk) {
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
export function screenRows(scores, companiesByCik, marketByTicker = null) {
  const rows = [];
  for (const s of scores) {
    const c = companiesByCik.get(s.cik);
    if (!c) continue;
    rows.push(screenRow(s, c, c.ticker ? marketByTicker?.[c.ticker] || null : null));
  }
  return rows;
}

// change since the previous filing (chg) or the same period a year earlier
// (yoy): percentage points for ratios, % growth for amounts and the score
function changeOf(r, key, mode) {
  const base = mode === 'chg' ? r.prev : r.yoy;
  const a = key === 'score' ? r.score.score : (r.values[key] ?? null);
  const b = !base ? null : key === 'score' ? base.score : (base.values?.[key] ?? null);
  if (a == null || b == null) return null;
  return pctField(key) ? (b === 0 ? null : ((a - b) / Math.abs(b)) * 100) : a - b;
}
const valueOf = (r, key, mode = 'now') => {
  if (MARKET_KEYS.has(key)) return mode === 'now' ? (r.market?.[key] ?? null) : null;
  if (mode !== 'now') return changeOf(r, key, mode);
  return key === 'score' ? r.score.score : (r.values[key] ?? null);
};

// The query of GET /api/screen applied to rows: sic / division / afs /
// exclusions / text, <key>[_chg|_yoy]_min|max ranges, sort, limit.
export function screenQuery(rows, q) {
  const sic = q.sic ? String(q.sic).padStart(4, '0') : null;
  const sic2 = q.sic2 ? String(q.sic2).padStart(2, '0') : null;
  const division = q.division ? SIC.divisions.find((d) => d.id === String(q.division).toUpperCase()) : null;
  const exDiv = String(q.exdiv || '')
    .split(',')
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean)
    .map((id) => SIC.divisions.find((d) => d.id === id))
    .filter(Boolean);
  const exSic = String(q.exsic || '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => /^\d{2,4}$/.test(x));
  const afs = q.afs ? String(q.afs).toUpperCase() : null;
  const text = String(q.q || '').trim().toUpperCase();
  const listedOnly = q.listed !== '0';
  const ranges = [];
  for (const [k, v] of Object.entries(q)) {
    const m = /^(.+?)(?:_(chg|yoy))?_(min|max)$/.exec(k);
    if (!m || v === '' || !Number.isFinite(Number(v))) continue;
    const f = fieldOf(m[1]);
    if (!f) continue;
    if (m[2] && f.market) continue; // no history for market fields
    ranges.push({ key: m[1], mode: m[2] || 'now', op: m[3], value: Number(v) });
  }
  const out = [];
  for (const r of rows) {
    if (listedOnly && !r.ticker) continue;
    const code = r.sic || '0000';
    if (sic && code !== sic) continue;
    if (sic2 && !code.startsWith(sic2)) continue;
    if (division && !(code.slice(0, 2) >= division.from && code.slice(0, 2) <= division.to)) continue;
    if (exDiv.some((d) => code.slice(0, 2) >= d.from && code.slice(0, 2) <= d.to)) continue;
    if (exSic.some((x) => code.startsWith(x))) continue;
    if (afs && (r.afs || 'UNKNOWN') !== afs) continue;
    if (text && !(r.name.toUpperCase().includes(text) || (r.tickers || []).some((t) => t.startsWith(text)))) continue;
    let ok = true;
    for (const x of ranges) {
      const v = valueOf(r, x.key, x.mode);
      if (v == null || (x.op === 'min' ? v < x.value : v > x.value)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(r);
  }
  const sortKey = String(q.sort || 'score');
  const sortMode = ['chg', 'yoy'].includes(String(q.sortmode || '')) ? String(q.sortmode) : 'now';
  const dir = q.dir === 'asc' ? 1 : -1;
  const sv = (r) => (sortMode !== 'now' ? changeOf(r, sortKey, sortMode) : MARKET_KEYS.has(sortKey) ? (r.market?.[sortKey] ?? null) : sortKey === 'score' ? r.score.score : sortKey === 'float' ? r.float : sortKey === 'name' ? r.name : sortKey === 'ticker' ? r.ticker : (r.values[sortKey] ?? null));
  out.sort((a, b) => {
    const x = sv(a);
    const y = sv(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
  const limit = Math.min(2000, Math.max(1, Number(q.limit) || 300));
  return { total: out.length, count: Math.min(out.length, limit), rows: out.slice(0, limit) };
}

// does a query need the market snapshot (so the server may wait for it)?
export const wantsMarket = (q) => Object.keys(q).some((k) => MARKET_KEYS.has(k.replace(/(?:_(?:chg|yoy))?_(?:min|max)$/, ''))) || MARKET_KEYS.has(String(q.sort || ''));

// ---- browse lists ----

export const companyRow = (c) => ({
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
export function sicCounts(companies) {
  const counts = new Map();
  for (const c of companies) {
    const k = c.sic || '0000';
    const n = counts.get(k) || { total: 0, listed: 0 };
    n.total++;
    if (c.ticker) n.listed++;
    counts.set(k, n);
  }
  const codes = SIC.codes.map((s) => ({ ...s, ...(counts.get(s.code) || { total: 0, listed: 0 }) }));
  // codes that appear in filings but not on SEC's list
  for (const [code, n] of counts) if (!SIC.codes.some((s) => s.code === code)) codes.push({ code, title: null, zh: code === '0000' ? '未指定' : null, division: 'J', office: null, ...n });
  return { divisions: SIC.divisions, codes };
}

// filer-status categories with counts
export function filerCounts(companies) {
  const counts = {};
  for (const c of companies) {
    const k = c.afs || 'UNKNOWN';
    counts[k] ??= { total: 0, listed: 0, wksi: 0 };
    counts[k].total++;
    if (c.ticker) counts[k].listed++;
    if (c.wksi) counts[k].wksi++;
  }
  return [...Object.keys(FILER_STATUS), 'UNKNOWN'].map((k) => ({
    key: k,
    ...(FILER_STATUS[k] || { label: 'Not stated', zh: '未標示', note: '申報書未標示身分' }),
    ...(counts[k] || { total: 0, listed: 0, wksi: 0 }),
  }));
}

// companies of a SIC code / filer status, largest public float first (the universe is already sorted so)
export function browseCompanies(companies, query) {
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
    filer: afs ? { key: afs, ...(FILER_STATUS[afs] || { label: 'Not stated', zh: '未標示' }) } : null,
    count: rows.length,
    companies: rows.slice(0, Number(query.limit) || 2000).map(companyRow),
  };
}

// ticker / company-name suggestions (ticker prefix first, then names)
export function searchRows(rows, q, limit = 10) {
  const needle = String(q).trim().toUpperCase().replace(/\./g, '-');
  if (!needle) return [];
  const starts = rows.filter((r) => r.ticker.startsWith(needle));
  const names = rows.filter((r) => !r.ticker.startsWith(needle) && r.name.toUpperCase().includes(needle));
  return [...starts, ...names].slice(0, limit);
}

// the score summary every list shows next to a company
export const scoreBadge = (s) => (s ? { score: s.score, coverage: s.coverage, accession: s.accession, form: s.form, fiscalYear: s.fiscalYear, fiscalPeriod: s.fiscalPeriod, periodEnd: s.periodEnd, filingDate: s.filingDate, categories: s.categories.map((c) => c.score) } : null);
