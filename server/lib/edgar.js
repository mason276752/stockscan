// Company lookup and filing lists from EDGAR's JSON APIs.

import { store } from './store.js';
import { barStore } from './barStore.js';
import { POPULAR_ETFS } from './etf.js';
import { DEFAULT_FORMS, filingUrls, fiscalLabel, pickFiling } from './filings.js';

export { DEFAULT_FORMS, filingUrls, fiscalLabel, pickFiling };

const TICKERS_URL = 'https://www.sec.gov/files/company_tickers_exchange.json';
const SUBMISSIONS = 'https://data.sec.gov/submissions/';


const TICKERS_TTL = 24 * 3600 * 1000;
const SUBMISSIONS_TTL = 10 * 60 * 1000; // filing lists refresh every 10 minutes

// Ticker table: served from the cache (SQLite) or, without one, the copy in
// the store (data/store/tickers.json, in git - so a fresh clone or a CI runner
// without a cache and without SEC can still resolve tickers); refreshed from
// SEC in the background at startup (and daily) so the first search after a
// restart is instant.
let tickersMemo = null;
const TICKERS_DOC = 'tickers.json';

// Only what trades on a real exchange is covered here. EDGAR names the
// venue in company_tickers_exchange.json, and everything quoted over the
// counter is left out: an OTC quote is not a price anyone could have
// traded on - the tick below a cent is a 100% move, sub-penny shells print
// quotes that never clear - so a chart built from them shows quote noise,
// not a return. (Of the saved series, one OTC name in four had a one-day
// step of 4x that came straight back the next day; on NYSE it was one in
// two hundred.) A blank venue is EDGAR not having filled it in yet - a
// fresh IPO, a SPAC - so the company's own submissions record decides, and
// silence there keeps the company.
const MAJOR_EXCHANGE = /^(nasdaq|nyse|amex|cboe|bats|iex|arca)/i;
export const isMajorExchange = (x) => MAJOR_EXCHANGE.test(String(x || '').trim());
// `venuesOf(cik)` answers for a row EDGAR left the venue blank on (a couple
// of hundred of them: fresh listings, SPACs, shells on their way out) - the
// exchanges of the company's own submissions record. With nothing to go on
// the company is not covered, which is an answer that survives the purge:
// "keep whatever is unknown" would re-admit an OTC shell the moment its
// record was deleted, crawl it, and delete it again the next day.
export const onMajorExchange = (row, venuesOf) => (row.exchange ? isMajorExchange(row.exchange) : (venuesOf(row.cik) || []).some(isMajorExchange));
const savedVenues = (cik) => store.getDoc(`companies/${String(cik).padStart(10, '0')}.json`)?.value?.exchanges;

// company_tickers_exchange.json is { fields: [...], data: [[...], ...] }.
export const tickerRows = (data) => {
  const col = Object.fromEntries((data.fields || []).map((f, i) => [f, i]));
  return (data.data || []).map((r) => ({ cik: Number(r[col.cik]), ticker: r[col.ticker], name: r[col.name], exchange: r[col.exchange] || null })).filter((r) => r.cik && r.ticker);
};

export async function refreshTickers(client) {
  // SEC's file lists every filer that has a ticker, OTC included; those rows
  // are dropped here, on every refresh, so nothing downstream ever sees them
  const rows = tickerRows(await client.json(TICKERS_URL)).filter((r) => onMajorExchange(r, savedVenues));
  store.putKV('tickers', rows);
  store.putDoc(TICKERS_DOC, { updatedAt: new Date().toISOString(), tickers: rows });
  tickersMemo = rows;
  return rows;
}

// The saved table without going to SEC: the cache first, else the store's
// copy (its age from the updatedAt inside - a git checkout resets mtimes).
export function savedTickers() {
  const kv = store.getKV('tickers');
  if (kv) return kv;
  const doc = store.getDoc(TICKERS_DOC)?.value;
  const rows = Array.isArray(doc?.tickers) ? doc.tickers : null;
  if (!rows?.length) return null;
  const at = Date.parse(doc.updatedAt || '') || 0;
  return { value: rows, ageMs: Date.now() - at };
}

// Companies the table no longer carries - delisted, or moved to the OTC
// market - are nothing this site covers any more: throw their saved
// filings, scores, company records and daily bars away. Only after a fresh,
// plausible ticker table - a truncated download must not empty the store.
const MIN_TICKERS = 5000;
export function purgeDelisted(rows) {
  if (!Array.isArray(rows) || rows.length < MIN_TICKERS) return null;
  const r = store.purgeExcept(rows.map((t) => t.cik));
  if (r.companies) console.log(`store: 移除 ${r.companies} 家已下市或轉上櫃（OTC）公司的 ${r.filings} 份財報`);
  // the bars are keyed by ticker, not CIK; the benchmark ETFs are not
  // companies and file nothing, so they are named here to be kept
  const bars = barStore.purgeExcept([...rows.map((t) => t.ticker), ...POPULAR_ETFS]);
  if (bars?.symbols) console.log(`bars: 移除 ${bars.symbols} 檔已不在代號表的日線`);
  return { ...r, bars: bars?.symbols || 0 };
}

// Listing status of a ticker from the saved table (no network): listed, or
// delisted, or renamed when the same company now trades under another ticker.
export function listingOf(ticker, cik = null) {
  const rows = tickersMemo || savedTickers()?.value;
  if (!rows) return null; // not known yet
  if (!tickersMemo) tickersMemo = rows;
  const wanted = String(ticker).toUpperCase().replace(/\./g, '-');
  if (rows.some((r) => r.ticker === wanted)) return { listed: true };
  const same = cik ? rows.find((r) => r.cik === Number(cik)) : null;
  return same ? { listed: false, renamed: same.ticker } : { listed: false };
}

export async function tickerTable(client) {
  if (tickersMemo) return tickersMemo;
  const saved = savedTickers();
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

// Per-company submissions (the filing list): the store's copy
// (data/store/companies/<name>.json) if fresh enough, otherwise SEC -
// falling back to the stale copy when SEC is unreachable.
async function cachedJson(client, name, url, ttlMs) {
  const doc = `companies/${name}.json`;
  const saved = store.getDoc(doc);
  if (saved && saved.ageMs < ttlMs) return { value: saved.value, updatedAt: Date.now() - saved.ageMs, fromCache: true };
  try {
    const value = trimSubmissions(await client.json(url));
    store.putDoc(doc, value);
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
// the day a new 10-Q/10-K is filed); maxAge lengthens it (the crawler's
// weekly sweep is happy with a list a few days old - the daily-index watch
// catches new filings anyway).
// `inlineOnly` (the default) leaves out the filings nothing here can read:
// before 2019 a filer tagged its numbers in a separate instance document,
// not in the HTML, and ixbrl.js only reads Inline XBRL. Such a filing is
// still offered once its numbers are in the store - that is what
// ingest-dera.mjs puts there, from SEC's quarterly datasets. Pass false to
// see every filing EDGAR lists (the ingester, deciding what to fill in).
export async function getCompany(client, tickerOrCik, { forms = DEFAULT_FORMS, includeOlder = true, refresh = false, maxAge = SUBMISSIONS_TTL, inlineOnly = true } = {}) {
  const cik = await resolveCik(client, tickerOrCik);
  const padded = String(cik).padStart(10, '0');
  const main = await cachedJson(client, padded, `${SUBMISSIONS}CIK${padded}.json`, refresh ? 0 : maxAge);
  const sub = main.value;
  let rows = rowsOf(sub.filings.recent);
  if (includeOlder) {
    for (const f of sub.filings.files || []) {
      // older pages only ever gain nothing new; refresh them daily
      const older = await cachedJson(client, f.name.replace(/\.json$/, ''), `${SUBMISSIONS}${f.name}`, Math.max(TICKERS_TTL, maxAge));
      rows = rows.concat(rowsOf(older.value));
    }
  }
  const allowed = new Set(forms.map((f) => f.toUpperCase()));
  const filings = rows
    .filter((r) => allowed.has(r.form.toUpperCase()) && r.primaryDocument && (!inlineOnly || r.isInlineXBRL || store.hasFiling(r.accession)))
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
