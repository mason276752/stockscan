// Company lookup and filing lists from EDGAR's JSON APIs.

import { store } from './store.js';

const ARCHIVES = 'https://www.sec.gov/Archives/edgar/data';
const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const SUBMISSIONS = 'https://data.sec.gov/submissions/';

export const DEFAULT_FORMS = ['10-K', '10-Q', '20-F', '40-F', '10-K/A', '10-Q/A', '20-F/A'];

const TICKERS_TTL = 24 * 3600 * 1000;
const SUBMISSIONS_TTL = 10 * 60 * 1000; // filing lists refresh every 10 minutes

export function filingUrls(cik, accession, primaryDocument) {
  const nodash = accession.replace(/-/g, '');
  const folderUrl = `${ARCHIVES}/${cik}/${nodash}`;
  return {
    folderUrl,
    documentUrl: `${folderUrl}/${primaryDocument}`,
    viewerUrl: `https://www.sec.gov/ix?doc=/Archives/edgar/data/${cik}/${nodash}/${primaryDocument}`,
    indexUrl: `${folderUrl}/${accession}-index.html`,
  };
}

// Ticker table: served from SQLite, refreshed from SEC in the background at
// startup (and daily) so the first search after a restart is instant.
let tickersMemo = null;

export async function refreshTickers(client) {
  const data = await client.json(TICKERS_URL);
  const rows = Object.values(data).map((r) => ({ cik: Number(r.cik_str), ticker: r.ticker, name: r.title }));
  store.putKV('tickers', rows);
  tickersMemo = rows;
  return rows;
}

export async function tickerTable(client) {
  if (tickersMemo) return tickersMemo;
  const saved = store.getKV('tickers');
  if (saved) {
    tickersMemo = saved.value;
    if (saved.ageMs > TICKERS_TTL) refreshTickers(client).catch(() => {});
    return tickersMemo;
  }
  return refreshTickers(client);
}

// Only these forms are kept from a submissions list: the full list (every
// 8-K, Form 4, …) is 1 MB+ for a large company and is never needed here.
const KEEP_FORMS = /^(10-|20-F|40-F|6-K)/;
function trimSubmissions(sub) {
  const trimTable = (t) => {
    const keep = [];
    for (let i = 0; i < (t.accessionNumber || []).length; i++) if (KEEP_FORMS.test(t.form[i])) keep.push(i);
    const pick = (arr) => (arr ? keep.map((i) => arr[i]) : undefined);
    return { accessionNumber: pick(t.accessionNumber), form: pick(t.form), filingDate: pick(t.filingDate), reportDate: pick(t.reportDate), primaryDocument: pick(t.primaryDocument), isInlineXBRL: pick(t.isInlineXBRL) };
  };
  if (sub.filings?.recent) {
    const { cik, name, tickers, exchanges, fiscalYearEnd, sic, sicDescription, filings } = sub;
    return { cik, name, tickers, exchanges, fiscalYearEnd, sic, sicDescription, filings: { recent: trimTable(filings.recent), files: filings.files || [] }, trimmed: true };
  }
  return { ...trimTable(sub), trimmed: true }; // an older page
}

// Per-company submissions (the filing list): SQLite copy if fresh enough,
// otherwise SEC - falling back to the stale copy when SEC is unreachable.
async function cachedJson(client, key, url, ttlMs) {
  const saved = store.getKV(key);
  if (saved && saved.ageMs < ttlMs) return { value: saved.value, updatedAt: Date.now() - saved.ageMs, fromCache: true };
  try {
    const value = trimSubmissions(await client.json(url));
    store.putKV(key, value);
    return { value, updatedAt: Date.now(), fromCache: false };
  } catch (err) {
    if (saved) return { value: saved.value, updatedAt: Date.now() - saved.ageMs, fromCache: true, stale: true };
    throw err;
  }
}

export async function searchCompanies(client, q, limit = 10) {
  const needle = q.trim().toUpperCase().replace(/\./g, '-');
  if (!needle) return [];
  const rows = await tickerTable(client);
  const starts = rows.filter((r) => r.ticker.startsWith(needle));
  const names = rows.filter((r) => !r.ticker.startsWith(needle) && r.name.toUpperCase().includes(needle));
  return [...starts, ...names].slice(0, limit);
}

export async function resolveCik(client, tickerOrCik) {
  const s = String(tickerOrCik).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const wanted = s.toUpperCase().replace(/\./g, '-');
  const row = (await tickerTable(client)).find((r) => r.ticker === wanted);
  if (!row) throw Object.assign(new Error(`Ticker not found on EDGAR: ${tickerOrCik}`), { status: 404 });
  return row.cik;
}

// Fiscal year / period label derived from the period end date and the
// company's fiscal-year-end (MMDD). Report dates are month ends give or take
// a few days (52/53-week years), so only the month is used.
export function fiscalLabel(form, reportDate, fiscalYearEnd) {
  if (!reportDate) return { fiscalYear: null, fiscalPeriod: null };
  const [y, m, d] = reportDate.split('-').map(Number);
  let month = d <= 7 ? m - 1 : m; // Jan 2 is really a December period end
  let year = y;
  if (month === 0) {
    month = 12;
    year -= 1;
  }
  const fyeMonth = fiscalYearEnd && /^\d{4}$/.test(fiscalYearEnd) ? Number(fiscalYearEnd.slice(0, 2)) : 12;
  const fiscalYear = month <= fyeMonth ? year : year + 1;
  const base = form.toUpperCase().replace(/\/A$/, '');
  if (base !== '10-Q') return { fiscalYear, fiscalPeriod: 'FY' };
  const monthsIntoYear = ((((month - fyeMonth - 1) % 12) + 12) % 12) + 1;
  return { fiscalYear, fiscalPeriod: `Q${Math.ceil(monthsIntoYear / 3)}` };
}

function rowsOf(table) {
  const n = table.accessionNumber.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      accession: table.accessionNumber[i],
      form: table.form[i],
      filingDate: table.filingDate[i],
      reportDate: table.reportDate[i] || null,
      primaryDocument: table.primaryDocument[i],
      isInlineXBRL: !!table.isInlineXBRL?.[i],
    });
  }
  return out;
}

// refresh=true bypasses the 10-minute cache (the UI's refresh button, for
// the day a new 10-Q/10-K is filed).
export async function getCompany(client, tickerOrCik, { forms = DEFAULT_FORMS, includeOlder = true, refresh = false } = {}) {
  const cik = await resolveCik(client, tickerOrCik);
  const padded = String(cik).padStart(10, '0');
  const main = await cachedJson(client, `submissions:${padded}`, `${SUBMISSIONS}CIK${padded}.json`, refresh ? 0 : SUBMISSIONS_TTL);
  const sub = main.value;
  let rows = rowsOf(sub.filings.recent);
  if (includeOlder) {
    for (const f of sub.filings.files || []) {
      // older pages only ever gain nothing new; refresh them daily
      const older = await cachedJson(client, `submissions:${f.name}`, `${SUBMISSIONS}${f.name}`, TICKERS_TTL);
      rows = rows.concat(rowsOf(older.value));
    }
  }
  const allowed = new Set(forms.map((f) => f.toUpperCase()));
  const filings = rows
    .filter((r) => allowed.has(r.form.toUpperCase()) && r.isInlineXBRL && r.primaryDocument)
    .map((r) => ({
      cik,
      ...r,
      ...fiscalLabel(r.form, r.reportDate, sub.fiscalYearEnd),
      ...filingUrls(cik, r.accession, r.primaryDocument),
    }))
    .sort((a, b) => (a.filingDate < b.filingDate ? 1 : a.filingDate > b.filingDate ? -1 : 0));
  return {
    cik,
    name: sub.name,
    tickers: sub.tickers || [],
    exchanges: sub.exchanges || [],
    fiscalYearEnd: sub.fiscalYearEnd || null,
    sic: sub.sic || null,
    sicDescription: sub.sicDescription || null,
    filingsUpdatedAt: new Date(main.updatedAt).toISOString(),
    filingsStale: !!main.stale,
    filings,
  };
}

export function pickFiling(filings, { year, period, form } = {}) {
  let list = filings;
  if (form) list = list.filter((f) => f.form.toUpperCase() === form.toUpperCase());
  if (year) list = list.filter((f) => f.fiscalYear === Number(year));
  if (period) list = list.filter((f) => f.fiscalPeriod === period.toUpperCase());
  return list[0] || null;
}

const ARCHIVE_RE = /\/Archives\/edgar\/data\/(\d+)\/(\d{18})\/([^/?#]+)/;

export function filingFromUrl(url) {
  const u = new URL(url);
  let path = u.pathname;
  if (path.replace(/\/$/, '').endsWith('/ix')) path = u.searchParams.get('doc') || '';
  const m = ARCHIVE_RE.exec(path);
  if (!m) throw Object.assign(new Error(`Cannot recognise EDGAR document URL: ${url}`), { status: 400 });
  const [, cik, acc, doc] = m;
  const accession = `${acc.slice(0, 10)}-${acc.slice(10, 12)}-${acc.slice(12)}`;
  return { cik: Number(cik), accession, primaryDocument: doc, ...filingUrls(Number(cik), accession, doc) };
}
