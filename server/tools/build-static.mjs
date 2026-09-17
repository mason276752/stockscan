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
//
// The slow parts - copying 900 MB of store, decoding 60,000 filing / score
// files for their headers, zstd-19 of the indexes - are done by the Rust
// helper tools/stockscan-static: the committed binary for this platform
// (bin/stockscan-static-<arch>-<os>; the Linux one is what the Pages
// workflow runs, nothing is compiled there), else a local cargo build
// (made here when missing). STOCKSCAN_STATIC_NATIVE=0 forces the pure-Node
// path, which produces the same output, only slower. What goes into the
// indexes is decided in this file either way.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
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

// ---- the native helper (tools/stockscan-static) ----
const NATIVE = (() => {
  if (/^(0|false|no|off)$/i.test(process.env.STOCKSCAN_STATIC_NATIVE || '')) return null;
  const tool = path.join(REPO, 'tools', 'stockscan-static');
  const bundled = path.join(tool, 'bin', `stockscan-static-${process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch}-${process.platform}`);
  const bin = process.env.STOCKSCAN_STATIC_BIN || (fs.existsSync(bundled) ? bundled : path.join(tool, 'target', 'release', 'stockscan-static'));
  if (!fs.existsSync(bin)) {
    try {
      console.log('build-static: building tools/stockscan-static (cargo build --release) …');
      execFileSync('cargo', ['build', '--release', '--quiet'], { cwd: tool, stdio: 'inherit' });
    } catch (err) {
      console.warn(`build-static: no native helper (${err.message.split('\n')[0]}) - the slower Node path is used`);
      return null;
    }
  }
  return fs.existsSync(bin) ? bin : null;
})();
const native = (...cmd) => execFileSync(NATIVE, cmd, { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 30 });
console.log(`build-static: ${NATIVE ? `native helper ${path.relative(REPO, NATIVE)}` : 'pure Node'}`);

// ---- 1. the app ----
console.log(`build-static: web app -> ${OUT}`);
execFileSync('npx', ['vite', 'build', '--outDir', OUT, '--emptyOutDir'], { cwd: path.join(REPO, 'web'), stdio: 'inherit', env: { ...process.env, VITE_STATIC: '1' } });

// ---- 2. the store ----
const { openStore, store } = await import('../lib/store.js');
openStore();
const { SCRAPE_VERSION } = await import('../lib/scrape.js');
const { SCORE_VERSION, latestScores } = await import('../lib/score.js');
const { screenColumns, screenRows, scoreBadge } = await import('../lib/screen.js');
const { fiscalLabel, DEFAULT_FORMS } = await import('../lib/filings.js');
const { lookupFiler, sicInfo } = await import('../lib/universe.js');
const { POPULAR_ETFS } = await import('../lib/etf.js');

function copyTree(from, to) {
  if (NATIVE) return native('copy', from, to, ...(LINK ? ['--link'] : []));
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true, filter: (src) => !src.endsWith('.tmp'), ...(LINK ? { mode: fs.constants.COPYFILE_FICLONE } : {}) });
}
const dataOut = path.join(OUT, 'data');
fs.mkdirSync(dataOut, { recursive: true });
console.log('build-static: copying data/store …');
copyTree(store.file, path.join(dataOut, 'store'));
copyTree(path.join(REPO, 'server', 'data', 'zdict'), path.join(dataOut, 'zdict'));
// the daily bars (data/bars/<source>/<SYMBOL>/{<year>.zst, head.zst, meta.json}): the
// custom-ETF page computes its index in the browser from them. head.zst (this
// year) is not in git - the workflow fetches it before building (npm run fetch:bars)
const barsDir = process.env.STOCKSCAN_BARS || path.join(REPO, 'data', 'bars');
let bars = { symbols: 0, heads: 0, bytes: 0 };
if (fs.existsSync(barsDir)) {
  console.log('build-static: copying data/bars …');
  copyTree(barsDir, path.join(dataOut, 'bars'));
  for (const src of fs.readdirSync(barsDir, { withFileTypes: true })) {
    if (!src.isDirectory()) continue;
    for (const sym of fs.readdirSync(path.join(barsDir, src.name), { withFileTypes: true })) {
      if (!sym.isDirectory()) continue;
      const d = path.join(barsDir, src.name, sym.name);
      if (!fs.existsSync(path.join(d, 'meta.json'))) continue;
      bars.symbols++;
      if (fs.existsSync(path.join(d, 'head.zst'))) bars.heads++;
      for (const f of fs.readdirSync(d)) bars.bytes += fs.statSync(path.join(d, f)).size;
    }
  }
  console.log(`build-static: bars ${bars.symbols} symbols (${bars.heads} with this year), ${(bars.bytes / 1048576).toFixed(0)} MB`);
}

// ---- 3. indexes ----
const idx = path.join(OUT, 'index');
fs.mkdirSync(idx, { recursive: true });
// Index files go out zstd'd and content-addressed (<name>.<hash>.json.zst,
// the hash of the JSON): a static host may not compress what it serves and
// the browser has zstd-wasm anyway (the filings need it); the name changing
// only with the content lets the browser keep an index across builds until
// it really changes (the SIC universe, the statement documentation and the
// ETF lists rarely do). meta.json (plain, always revalidated) maps each
// index to its current file. With the native helper the raw JSON is written
// now and all of them are compressed together (in parallel) at the end.
const toCompress = [];
const files = {}; // index -> file name of this build
const write = (name, obj, { compress = true } = {}) => {
  const json = Buffer.from(JSON.stringify(obj));
  if (!compress) {
    fs.writeFileSync(path.join(idx, name), json);
    console.log(`build-static: ${name} ${(json.length / 1024).toFixed(1)} KB`);
    return;
  }
  const base = name.replace(/\.json$/, '');
  const hashed = `${base}.${createHash('sha1').update(json).digest('hex').slice(0, 10)}.json`;
  files[base] = `${hashed}.zst`;
  if (NATIVE) {
    const raw = path.join(idx, hashed);
    fs.writeFileSync(raw, json);
    toCompress.push(raw);
    return;
  }
  const file = path.join(idx, `${hashed}.zst`);
  fs.writeFileSync(file, zlib.zstdCompressSync(json, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } }));
  console.log(`build-static: ${path.basename(file)} ${(fs.statSync(file).size / 1048576).toFixed(1)} MB (${(json.length / 1048576).toFixed(1)} MB raw)`);
};

// the headers of every filing and every score, decoded once by the helper;
// the store then answers filingHeader / scoreJson from these instead of
// reading and inflating each file on demand
if (NATIVE) {
  const t = Date.now();
  const decoded = JSON.parse(native('decode', store.file, path.join(REPO, 'server', 'data', 'zdict')).toString('utf8'));
  const headers = decoded.filings;
  const scoreJson = decoded.scores;
  store.filingHeader = (accession) => (store.hasFiling(accession) ? headers[accession] ?? null : null);
  const scoreVersion = new Map(store.allScores().map((s) => [s.accession, s.version]));
  store.scoreJson = (accession) => (scoreVersion.has(accession) ? scoreJson[accession] ?? null : null);
  console.log(`build-static: decoded ${Object.keys(headers).length} headers, ${Object.keys(scoreJson).length} scores in ${((Date.now() - t) / 1000).toFixed(1)} s`);
}

// the ticker table, the SIC / filer universe and the market snapshot: from
// the caches when fresh, else fetched (SEC needs SEC_USER_AGENT; a CI runner
// starts with no cache at all)
let client = null;
try {
  const { SecClient } = await import('../lib/secClient.js');
  client = new SecClient();
} catch (err) {
  console.warn(`build-static: ${err.message} - using cached data only`);
}
const { tickerTable, savedTickers } = await import('../lib/edgar.js');
const { getUniverse } = await import('../lib/universe.js');
const { marketSnapshot } = await import('../lib/market.js');
let tickers = savedTickers()?.value || []; // the cache, else data/store/tickers.json (in git)
let universe = store.getDoc('universe.json')?.value || { updatedAt: null, datasets: [], companies: [] };
let market = store.getKV('market:snapshot')?.value || null;
if (client) {
  try {
    tickers = await tickerTable(client);
    console.log(`build-static: ticker table ${tickers.length}`);
    universe = await getUniverse(client);
    console.log(`build-static: universe ${universe.companies.length} filers`);
  } catch (err) {
    console.warn(`build-static: SEC data: ${err.message}`);
  }
}
try {
  market = (await marketSnapshot({ wait: true })) || market;
  console.log(`build-static: market snapshot ${market?.count ?? 0} tickers`);
} catch (err) {
  console.warn(`build-static: market snapshot: ${err.message}`);
}
// without these the site is broken (no search, no filing by ticker, empty
// browse / screener): fail the build rather than publish it over a good one
if (!tickers.length || !universe.companies.length) {
  console.error(`build-static: ERROR ${!tickers.length ? 'no ticker table' : 'no universe'} - neither cached (data/cache.sqlite), in the store (data/store/${!tickers.length ? 'tickers' : 'universe'}.json) nor fetched from SEC (set SEC_USER_AGENT)`);
  process.exit(1);
}
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

console.log('build-static: latest scores, screener columns …');
const scores = latestScores();
write('scores-min.json', Object.fromEntries(scores.map((s) => [s.cik, scoreBadge(s)])));
// the screener rows as columns (one array per field): a quarter of the
// JSON of the rows, parsed by the browser's worker in a third of the time;
// the prev / yoy columns apart, so the first results need not wait for them
const screenCols = screenColumns(screenRows(scores, byCik, market?.byTicker || null));
write('screen.json', screenCols.screen);
write('screen-history.json', screenCols.history);
write('universe.json', { updatedAt: universe.updatedAt, datasets: universe.datasets, companies: universe.companies });
write('tvsymbols.json', Object.fromEntries(Object.entries(market?.byTicker || {}).map(([t, r]) => [t, { symbol: r.tv, exchange: r.exchange || null }])));

// ETF list and the popular ETFs' holdings (from the caches; fetched when
// SEC_USER_AGENT allows - a new N-PORT quarter means one big XML per ETF
// from EDGAR, which is where a build spends minutes when it does)
let etfs = { updatedAt: null, popular: POPULAR_ETFS, etfs: [], holdings: {} };
try {
  if (!client) throw new Error('no SEC client');
  const { etfList, etfHoldings } = await import('../lib/etf.js');
  console.log('build-static: ETF list …');
  const list = await etfList(client);
  etfs.updatedAt = list.updatedAt;
  etfs.etfs = list.etfs;
  for (const t of POPULAR_ETFS) {
    const t0 = Date.now();
    try {
      etfs.holdings[t] = await etfHoldings(client, t);
      const ms = Date.now() - t0;
      if (ms > 1000) console.log(`build-static: ETF ${t} holdings (N-PORT from EDGAR) ${(ms / 1000).toFixed(1)} s`);
    } catch (err) {
      console.warn(`build-static: ETF ${t}: ${err.message}`);
    }
  }
} catch (err) {
  console.warn(`build-static: ETF lists skipped (${err.message})`);
}
write('etfs.json', etfs);

write('documentation.json', JSON.parse(fs.readFileSync(path.join(store.file, 'documentation.json'), 'utf8')));
write(
  'meta.json',
  {
    builtAt: new Date().toISOString(),
    filings: store.filingCount(),
    scores: scores.length,
    companies: Object.keys(companies).length,
    scrapeVersion: SCRAPE_VERSION,
    scoreVersion: SCORE_VERSION,
    market: { count: market?.count ?? 0, updatedAt: market?.updatedAt ?? null, refreshing: false },
    bars: bars.symbols ? { symbols: bars.symbols, heads: bars.heads, sources: ['tv2'] } : null,
    files,
  },
  { compress: false },
);

if (toCompress.length) {
  console.log(`build-static: compressing ${toCompress.length} index files (zstd -19, ${(toCompress.reduce((n, f) => n + fs.statSync(f).size, 0) / 1048576).toFixed(0)} MB raw) …`);
  native('compress', '19', ...toCompress);
}

// GitHub Pages: no Jekyll processing (paths with __ would otherwise be skipped)
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
console.log(`build-static: done in ${((Date.now() - t0) / 1000).toFixed(0)} s -> ${OUT}`);
process.exit(0);
