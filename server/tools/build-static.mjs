// Build the pure-frontend site: the Vue app compiled with VITE_STATIC=1, the
// saved filings / scores as they are in data/store, and the indexes the
// browser needs because a static host cannot list directories or run the
// screener (company lists, latest scores, market snapshot, ETF holdings).
//
//   node server/tools/build-static.mjs [--out web/dist-static] [--link]
//
// Output is a directory to put on any static host (GitHub Pages, S3, nginx).
// --link hard-links the store files instead of copying them (same disk).
// Everything comes from the local store and caches; with SEC_USER_AGENT set
// the ETF list / holdings that are not cached yet are fetched from EDGAR.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const OUT = path.resolve(REPO, opt('--out', path.join('web', 'dist-static')));
const LINK = args.includes('--link');
const t0 = Date.now();

// ---- 1. the app ----
console.log(`build-static: web app -> ${OUT}`);
execFileSync('npx', ['vite', 'build', '--outDir', OUT, '--emptyOutDir'], { cwd: path.join(REPO, 'web'), stdio: 'inherit', env: { ...process.env, VITE_STATIC: '1' } });

// ---- 2. the store ----
const { openStore, store } = await import('../lib/store.js');
openStore();
const { SCRAPE_VERSION } = await import('../lib/scrape.js');
const { SCORE_VERSION, latestScores } = await import('../lib/score.js');
const { screenRows, scoreBadge } = await import('../lib/screen.js');
const { fiscalLabel, DEFAULT_FORMS } = await import('../lib/filings.js');
const { lookupFiler, sicInfo } = await import('../lib/universe.js');
const { marketStatus } = await import('../lib/market.js');
const { POPULAR_ETFS } = await import('../lib/etf.js');

function copyTree(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true, filter: (src) => !src.endsWith('.tmp'), ...(LINK ? { mode: fs.constants.COPYFILE_FICLONE } : {}) });
}
const dataOut = path.join(OUT, 'data');
fs.mkdirSync(dataOut, { recursive: true });
console.log('build-static: copying data/store …');
copyTree(store.file, path.join(dataOut, 'store'));
copyTree(path.join(REPO, 'server', 'data', 'zdict'), path.join(dataOut, 'zdict'));

// ---- 3. indexes ----
const idx = path.join(OUT, 'index');
fs.mkdirSync(idx, { recursive: true });
const write = (name, obj) => {
  const file = path.join(idx, name);
  fs.writeFileSync(file, JSON.stringify(obj));
  console.log(`build-static: ${name} ${(fs.statSync(file).size / 1048576).toFixed(1)} MB`);
};

const tickers = store.getKV('tickers')?.value || [];
const universe = store.getKV('universe')?.value || { updatedAt: null, datasets: [], companies: [] };
const market = store.getKV('market:snapshot')?.value || null;
const byCik = new Map(universe.companies.map((c) => [c.cik, c]));
const tickersByCik = new Map();
for (const t of tickers) (tickersByCik.get(t.cik) || tickersByCik.set(t.cik, []).get(t.cik)).push(t.ticker);

// companies: every company with a saved filing, with its saved filings (the
// list the filing picker shows) - header from the cached EDGAR submissions
// when we have them, else from the ticker table / universe
console.log('build-static: reading filing headers …');
const filingsByCik = new Map();
for (const f of store.allFilings()) (filingsByCik.get(f.cik) || filingsByCik.set(f.cik, []).get(f.cik)).push(f);
const scoreFile = new Map(store.allScores().filter((s) => s.version === SCORE_VERSION).map((s) => [s.accession, s.file]));
const allowed = new Set(DEFAULT_FORMS.map((f) => f.toUpperCase()));
const companies = {};
let headers = 0;
for (const [cik, list] of filingsByCik) {
  const sub = store.getDoc(`companies/${String(cik).padStart(10, '0')}.json`)?.value || null;
  if (sub) headers++;
  const u = byCik.get(cik);
  const fye = sub?.fiscalYearEnd || null;
  const filings = [];
  for (const rec of list) {
    const h = store.filingHeader(rec.accession);
    if (!h) continue;
    const form = h.form || rec.form || '';
    if (!allowed.has(form.toUpperCase())) continue;
    const reportDate = h.periodEnd || rec.reportDate || null;
    const label = fye ? fiscalLabel(form, reportDate, fye) : { fiscalYear: h.fiscalYear ? Number(h.fiscalYear) : null, fiscalPeriod: h.fiscalPeriod || null };
    // (document / viewer URLs are derived in the browser from primaryDocument)
    filings.push({ accession: rec.accession, form, filingDate: h.filingDate || null, reportDate, primaryDocument: h.primaryDocument || null, ...label, file: rec.file, scoreFile: scoreFile.get(rec.accession) || null });
  }
  if (!filings.length) continue;
  filings.sort((a, b) => (a.filingDate < b.filingDate ? 1 : a.filingDate > b.filingDate ? -1 : 0));
  companies[cik] = {
    cik,
    name: sub?.name || u?.name || tickers.find((t) => t.cik === cik)?.name || String(cik),
    tickers: sub?.tickers || tickersByCik.get(cik) || u?.tickers || [],
    exchanges: sub?.exchanges || [],
    fiscalYearEnd: fye,
    sic: sub?.sic || u?.sic || null,
    sicDescription: sub?.sicDescription || sicInfo(u?.sic)?.title || null,
    filer: (() => {
      const f = lookupFiler(cik);
      return f ? { afs: f.afs, filerStatus: f.filerStatus, wksi: f.wksi, publicFloat: f.publicFloat, publicFloatDate: f.publicFloatDate, publicFloatAdjusted: f.publicFloatAdjusted } : null;
    })(),
    filings,
  };
}
write('companies.json', companies);
console.log(`build-static: ${Object.keys(companies).length} companies (${headers} with EDGAR headers)`);

write('tickers.json', tickers.map((t) => ({ cik: t.cik, ticker: t.ticker, name: t.name })));

const scores = latestScores();
write('scores-min.json', Object.fromEntries(scores.map((s) => [s.cik, scoreBadge(s)])));
write('screen.json', screenRows(scores, byCik, market?.byTicker || null));
write('universe.json', { updatedAt: universe.updatedAt, datasets: universe.datasets, companies: universe.companies });
write('tvsymbols.json', Object.fromEntries(Object.entries(market?.byTicker || {}).map(([t, r]) => [t, { symbol: r.tv, exchange: r.exchange || null }])));

// ETF list and the popular ETFs' holdings (from the caches; fetched when SEC_USER_AGENT allows)
let etfs = { updatedAt: null, popular: POPULAR_ETFS, etfs: [], holdings: {} };
try {
  const { SecClient } = await import('../lib/secClient.js');
  const { etfList, etfHoldings } = await import('../lib/etf.js');
  const client = new SecClient();
  const list = await etfList(client);
  etfs.updatedAt = list.updatedAt;
  etfs.etfs = list.etfs;
  for (const t of POPULAR_ETFS) {
    try {
      etfs.holdings[t] = await etfHoldings(client, t);
    } catch (err) {
      console.warn(`build-static: ETF ${t}: ${err.message}`);
    }
  }
} catch (err) {
  console.warn(`build-static: ETF lists skipped (${err.message})`);
}
write('etfs.json', etfs);

write('meta.json', {
  builtAt: new Date().toISOString(),
  filings: store.filingCount(),
  scores: scores.length,
  companies: Object.keys(companies).length,
  scrapeVersion: SCRAPE_VERSION,
  scoreVersion: SCORE_VERSION,
  market: { count: market?.count ?? 0, updatedAt: market?.updatedAt ?? null, refreshing: false },
});

// GitHub Pages: no Jekyll processing (paths with __ would otherwise be skipped)
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
console.log(`build-static: done in ${((Date.now() - t0) / 1000).toFixed(0)} s -> ${OUT}`);
process.exit(0);
