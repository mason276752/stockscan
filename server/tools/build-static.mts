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
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
import type { Universe } from '../lib/universe.ts';
import type { MarketSnapshot } from '../lib/market.ts';
import type { TickerRow } from '../lib/edgar.ts';
import type { AsOfRef, Company, FilingHeader, IsoDate, Score, ScoreRow } from '../lib/types.ts';
import type { Etf } from '../lib/etf.ts';

/** index/etfs.json: the ETF list plus which holdings files were written. */
interface EtfIndex {
  updatedAt: string | null;
  popular: readonly string[];
  etfs: Etf[];
  holdings: string[];
}

/** A filing as the static site's companies.json lists it. */
interface StaticFiling {
  accession: string;
  form: string;
  filingDate: IsoDate | null;
  reportDate: IsoDate | null;
  primaryDocument: string | null;
  fiscalYear: number | null;
  fiscalPeriod: string | null;
  /** an amendment with no statements in it: the original still stands */
  thin?: 1;
  /** not carried by this site (over the budget): read it from the data ref */
  off?: 1;
  /** spelled out only when the store's naming does not derive it */
  file?: string;
  scoreFile?: string | true;
}

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1]! : dflt;
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
      console.warn(`build-static: no native helper (${(err as Error).message.split('\n')[0]}) - the slower Node path is used`);
      return null;
    }
  }
  return fs.existsSync(bin) ? bin : null;
})();
const native = (...cmd: string[]) => execFileSync(NATIVE!, cmd, { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 30 });

/**
 * The helper's `decode-lines`, read a record at a time.
 *
 * This cannot go through execFileSync like the other two commands: the decoded
 * headers and scores are around half a gigabyte, which is past both
 * execFileSync's buffer and - the wall with no way around it - the 512 MB a
 * Node string tops out at (buffer.constants.MAX_STRING_LENGTH), so there is no
 * moment at which the whole answer exists as one string to hand to JSON.parse.
 * The helper prints one record per line instead and each is parsed on its own,
 * so nothing here grows with the size of the store.
 */
async function decodeStore(): Promise<{ filings: Map<string, FilingHeader>; scores: Map<string, ScoreRow> }> {
  const filings = new Map<string, FilingHeader>();
  const scores = new Map<string, ScoreRow>();
  const child = spawn(NATIVE!, ['decode-lines', store.file!, path.join(REPO, 'server', 'data', 'zdict')], { stdio: ['ignore', 'pipe', 'inherit'] });
  const take = (line: string) => {
    if (!line) return;
    const tab = line.indexOf('\t');
    const end = line.indexOf('\t', tab + 1);
    if (line.length < 3 || tab !== 1 || end < 0) throw new Error(`decode-lines: malformed record: ${line.slice(0, 80)}`);
    const accession = line.slice(2, end);
    const value = JSON.parse(line.slice(end + 1));
    if (line[0] === 'f') filings.set(accession, value as FilingHeader);
    else scores.set(accession, value as ScoreRow);
  };
  let rest = '';
  child.stdout.setEncoding('utf8');
  for await (const chunk of child.stdout) {
    rest += chunk;
    for (let nl = rest.indexOf('\n'); nl >= 0; nl = rest.indexOf('\n')) {
      take(rest.slice(0, nl));
      rest = rest.slice(nl + 1);
    }
  }
  take(rest.trim());
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  if (code !== 0) throw new Error(`decode-lines: the helper exited ${code}`);
  return { filings, scores };
}
console.log(`build-static: ${NATIVE ? `native helper ${path.relative(REPO, NATIVE)}` : 'pure Node'}`);

// ---- 1. the app ----
console.log(`build-static: web app -> ${OUT}`);
execFileSync('npx', ['vite', 'build', '--outDir', OUT, '--emptyOutDir'], { cwd: path.join(REPO, 'web'), stdio: 'inherit', env: { ...process.env, VITE_STATIC: '1' } });

// ---- 2. the store ----
const { openStore, store } = await import('../lib/store.ts');
openStore();
const { SCRAPE_VERSION } = await import('../lib/scrape.ts');
const { SCORE_VERSION, asOfIndex, latestScores } = await import('../lib/score.ts');
const { filerCounts, asOfShardOf, asOfSubset, screenColumns, screenRows, scoreBadge, sicCounts } = await import('../lib/screen.ts');
const { fiscalLabel, filingFile, scoreFile, DEFAULT_FORMS } = await import('../lib/filings.ts');
const { PAGES_LIMIT_MB, publishBudget, publishMb } = await import('../lib/publish.ts');
const { lookupFiler, sicInfo } = await import('../lib/universe.ts');
const { POPULAR_ETFS } = await import('../lib/etf.ts');

function copyTree(from: string, to: string) {
  if (NATIVE) return native('copy', from, to, ...(LINK ? ['--link'] : []));
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true, filter: (src) => !src.endsWith('.tmp'), ...(LINK ? { mode: fs.constants.COPYFILE_FICLONE } : {}) });
}
const dataOut = path.join(OUT, 'data');
fs.mkdirSync(dataOut, { recursive: true });
// Where a filing this site does not carry can still be read: the data ref
// itself, served by raw.githubusercontent.com (it answers with
// access-control-allow-origin: *, so the browser may fetch it). The store
// is the same tree there, so the path below a filing is identical - only
// the base changes. STOCKSCAN_DATA_URL overrides it; a checkout with no
// GitHub remote gets none, and then the site simply has what it has.
const DATA_REF = process.env.STOCKSCAN_DATA_REF || 'refs/data/main';
const DATA_URL = (() => {
  if (process.env.STOCKSCAN_DATA_URL) return process.env.STOCKSCAN_DATA_URL.replace(/\/*$/, '/');
  let slug = process.env.GITHUB_REPOSITORY || '';
  if (!slug) {
    try {
      slug = /github\.com[:/]+([^/]+\/[^/]+?)(?:\.git)?\/*$/.exec(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: REPO }).toString().trim())?.[1] || '';
    } catch {
      /* not a git checkout, or no origin */
    }
  }
  return slug ? `https://raw.githubusercontent.com/${slug}/${DATA_REF}/data/store/` : null;
})();
console.log(`build-static: older filings will be read from ${DATA_URL || '(nowhere - no GitHub remote, so only what this site carries)'}`);
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

const barsMb = bars.bytes / 1048576;

// Of the store, the site only serves what the browser fetches by path: the
// saved filings and their scores. (The company records, the ticker table,
// the SIC universe and the statement documentation are all in index/*.json.zst
// by the time the app asks for them - copying the originals too would put
// ~90 MB on the site that nothing ever reads.)
//
// And not even all the filings: a GitHub Pages site may hold 1 GB in total
// and the crawler keeps digging backwards, so the newest ones that fit in
// the budget go and the oldest stay behind (server/lib/publish.js). The
// screener's as-of index is built further down from *every* score the store
// has, so the time machine still reaches back past the statements here.
const PUBLISH_MB = publishMb(barsMb);
const budget = publishBudget(store.allFilings(), PUBLISH_MB);
const PUBLISH_FROM = budget.from;
const storeOut = path.join(dataOut, 'store');
console.log(`build-static: copying data/store (the newest ${(budget.bytes / 1048576).toFixed(0)} MB of filings, ${PUBLISH_MB} MB budget: ${PUBLISH_FROM} onwards) …`);
fs.rmSync(storeOut, { recursive: true, force: true });
fs.mkdirSync(storeOut, { recursive: true });
const madeDirs = new Set();
const copyOne = (rel: string) => {
  const to = path.join(storeOut, rel);
  const dir = path.dirname(to);
  if (!madeDirs.has(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    madeDirs.add(dir);
  }
  if (LINK) fs.linkSync(path.join(store.file!, rel), to);
  else fs.copyFileSync(path.join(store.file!, rel), to, fs.constants.COPYFILE_FICLONE);
};
const published = budget.accessions; // accessions whose statements are on the site
const publishCount = { filings: 0, scores: 0 };
for (const f of store.allFilings()) {
  if (!published.has(f.accession)) continue;
  copyOne(f.file);
  publishCount.filings++;
}
for (const sc of store.allScores()) {
  // a score is only reachable through its filing's page, so it travels with it
  if (!published.has(sc.accession)) continue;
  copyOne(sc.file);
  publishCount.scores++;
}
console.log(`build-static: ${publishCount.filings.toLocaleString()} filings + ${publishCount.scores.toLocaleString()} scores published${budget.left ? `, ${budget.left.toLocaleString()} older filings left out (over the ${PUBLISH_MB} MB budget; they stay in the store)` : ''}`);
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
const toCompress: string[] = [];
const files: Record<string, string> = {}; // index -> file name of this build
const write = (name: string, obj: unknown, { compress = true }: { compress?: boolean } = {}) => {
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
  const { filings: headers, scores: scoreJson } = await decodeStore();
  store.filingHeader = (accession: string) => (store.hasFiling(accession) ? (headers.get(accession) ?? null) : null);
  const scoreVersion = new Map(store.allScores().map((s) => [s.accession, s.version]));
  // The scores here have no `items` (the helper leaves them out: 59% of the
  // bytes, and nothing in this build reads them - score.ts readScoreRow drops
  // them at once, and the two places that reach for a whole score only want
  // `coverage`). The site's own copies are the published score files, which go
  // over verbatim, so what a reader sees there is unaffected.
  store.scoreJson = (accession) => (scoreVersion.has(accession) ? ((scoreJson.get(accession) ?? null) as Score | null) : null);
  console.log(`build-static: decoded ${headers.size} headers, ${scoreJson.size} scores in ${((Date.now() - t) / 1000).toFixed(1)} s`);
}

// the ticker table, the SIC / filer universe and the market snapshot: from
// the caches when fresh, else fetched (SEC needs SEC_USER_AGENT; a CI runner
// starts with no cache at all)
let client = null;
try {
  const { SecClient } = await import('../lib/secClient.ts');
  client = new SecClient();
} catch (err) {
  console.warn(`build-static: ${(err as Error).message} - using cached data only`);
}
const { tickerTable, savedTickers } = await import('../lib/edgar.ts');
const { getUniverse } = await import('../lib/universe.ts');
const { marketSnapshot } = await import('../lib/market.ts');
let tickers: TickerRow[] = savedTickers()?.value || []; // the cache, else data/store/tickers.json (in git)
let universe: Universe = store.getDoc<Universe>('universe.json')?.value || { updatedAt: null as unknown as string, datasets: [], companies: [] };
let market: MarketSnapshot | null = store.getKV<MarketSnapshot>('market:snapshot')?.value || null;
if (client) {
  try {
    tickers = await tickerTable(client);
    console.log(`build-static: ticker table ${tickers.length}`);
    universe = await getUniverse(client);
    console.log(`build-static: universe ${universe.companies.length} filers`);
  } catch (err) {
    console.warn(`build-static: SEC data: ${(err as Error).message}`);
  }
}
try {
  market = (await marketSnapshot({ wait: true })) || market;
  console.log(`build-static: market snapshot ${market?.count ?? 0} tickers`);
} catch (err) {
  console.warn(`build-static: market snapshot: ${(err as Error).message}`);
}
// without these the site is broken (no search, no filing by ticker, empty
// browse / screener): fail the build rather than publish it over a good one
if (!tickers.length || !universe.companies.length) {
  console.error(`build-static: ERROR ${!tickers.length ? 'no ticker table' : 'no universe'} - neither cached (data/cache.sqlite), in the store (data/store/${!tickers.length ? 'tickers' : 'universe'}.json) nor fetched from SEC (set SEC_USER_AGENT)`);
  process.exit(1);
}
const byCik = new Map(universe.companies.map((c) => [c.cik, c]));
const tickersByCik = new Map<number, string[]>();
for (const t of tickers) (tickersByCik.get(t.cik) || tickersByCik.set(t.cik, []).get(t.cik)!).push(t.ticker);

// companies: every company with a saved filing, with its saved filings (the
// list the filing picker shows) - header from the cached EDGAR submissions
// when we have them, else from the ticker table / universe
console.log('build-static: reading filing headers …');
const filingsByCik = new Map<number, ReturnType<typeof store.allFilings>>();
for (const f of store.allFilings()) (filingsByCik.get(f.cik) || filingsByCik.set(f.cik, []).get(f.cik)!).push(f);
const scoreFiles = new Map(store.allScores().filter((s) => s.version === SCORE_VERSION).map((s) => [s.accession, s.file]));
const allowed = new Set(DEFAULT_FORMS.map((f) => f.toUpperCase()));
const companies: Record<number, unknown> = {};
let headers = 0;
for (const [cik, list] of filingsByCik) {
  const sub = store.getDoc<Company>(`companies/${String(cik).padStart(10, '0')}.json`)?.value || null;
  if (sub) headers++;
  const u = byCik.get(cik);
  const fye = sub?.fiscalYearEnd || null;
  const filings: StaticFiling[] = [];
  for (const rec of list) {
    const h = store.filingHeader(rec.accession);
    if (!h) continue;
    const form = h.form || rec.form || '';
    if (!allowed.has(form.toUpperCase())) continue;
    const reportDate = h.periodEnd || rec.reportDate || null;
    const label = fye ? fiscalLabel(form, reportDate, fye) : { fiscalYear: h.fiscalYear ? Number(h.fiscalYear) : null, fiscalPeriod: h.fiscalPeriod || null };
    // (document / viewer URLs are derived in the browser from primaryDocument;
    // so are the store paths when they follow the naming - file / scoreFile
    // are only spelled out when they do not, scoreFile: true when they do)
    const f: StaticFiling = { accession: rec.accession, form, filingDate: h.filingDate || null, reportDate, primaryDocument: h.primaryDocument || null, ...label };
    // an amendment the parser found nothing to score in is the Part III-only
    // kind: it corrects nothing, so the browser keeps the original for that
    // period (filings.ts collapseAmendments)
    if (/\/A$/i.test(form) && !(Number(store.getScore(rec.accession, SCORE_VERSION)?.coverage) > 0)) f.thin = 1;
    // not on this site (over the size budget): read it from the data ref instead
    if (!published.has(rec.accession)) f.off = 1;
    if (rec.file !== filingFile(cik, f, SCRAPE_VERSION)) f.file = rec.file;
    const sf = scoreFiles.get(rec.accession);
    if (sf) f.scoreFile = sf === scoreFile(cik, f, SCORE_VERSION) ? true : sf;
    filings.push(f);
  }
  if (!filings.length) continue;
  filings.sort((a, b) => (a.filingDate! < b.filingDate! ? 1 : a.filingDate! > b.filingDate! ? -1 : 0));
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
const screenerRows = screenRows(scores, byCik, market?.byTicker || null);
const screenCols = screenColumns(screenerRows);
write('screen.json', screenCols.screen);
write('screen-history.json', screenCols.history);
// and every scored filing of those companies, one file per year of filing
// date (screen-asof-2026.json …): with these the browser picks each
// company's filing itself, so the screener can be run as of an earlier
// date. A year is megabytes and the store keeps growing backwards, so the
// page only fetches the years a date can reach (asOfShardYears), and only
// once a date is set. STOCKSCAN_ASOF_YEARS caps how many years are
// published at all - beyond that the screener's dates stop. The default
// covers everything there is to cover: SEC's quarterly datasets start at
// 2009q1 (ingest-dera.mts), and a year of them is a couple of MB zstd'd
// against the 1 GB the site may take.
const ASOF_YEARS = Math.max(1, Number(process.env.STOCKSCAN_ASOF_YEARS) || 20);
const screened = new Set(screenerRows.map((r) => r.cik));
// The scores themselves are not read here: latestScores above has already
// put every one of them into the as-of index as columns (score.ts), so a
// year file is a slice of that rather than another walk of the store's
// ~200,000 score files.
const index = asOfIndex();
const asOfByYear = new Map<number, AsOfRef[]>();
for (const [cik, filings] of index.byCik) {
  if (!screened.has(cik)) continue;
  for (const r of filings) {
    const year = asOfShardOf(r);
    if (year) (asOfByYear.get(year) || asOfByYear.set(year, []).get(year)!).push(r);
  }
}
const asOfYears = [...asOfByYear.keys()].sort((a, b) => b - a).slice(0, ASOF_YEARS);
for (const year of asOfYears) write(`screen-asof-${year}.json`, asOfSubset(index, asOfByYear.get(year)!));
console.log(`build-static: screener as-of years ${asOfYears.at(-1)}–${asOfYears[0]} (${asOfYears.map((y) => `${y}: ${asOfByYear.get(y)!.length}`).join(', ')} filings)`);
write('universe.json', { updatedAt: universe.updatedAt, datasets: universe.datasets, companies: universe.companies });
// the SIC / filer-status counts of the browse pages and the screener's
// pickers, so those need not load the 2 MB universe
write('browse.json', { updatedAt: universe.updatedAt, datasets: universe.datasets, sic: sicCounts(universe.companies), filer: filerCounts(universe.companies) });
write('tvsymbols.json', Object.fromEntries(Object.entries(market?.byTicker || {}).map(([t, r]) => [t, { symbol: r.tv, exchange: r.exchange || null }])));

// ETF list and the popular ETFs' holdings (from the caches; fetched when
// SEC_USER_AGENT allows - a new N-PORT quarter means one big XML per ETF
// from EDGAR, which is where a build spends minutes when it does). The
// list is one index, each ETF's holdings its own (etf-VOO.json): the browse
// page loads the one it shows
const etfs: EtfIndex = { updatedAt: null, popular: POPULAR_ETFS, etfs: [], holdings: [] };
try {
  if (!client) throw new Error('no SEC client');
  const { etfList, etfHoldings } = await import('../lib/etf.ts');
  console.log('build-static: ETF list …');
  const list = await etfList(client);
  etfs.updatedAt = list.updatedAt;
  etfs.etfs = list.etfs;
  for (const t of POPULAR_ETFS) {
    const t0 = Date.now();
    try {
      write(`etf-${t}.json`, await etfHoldings(client, t));
      etfs.holdings.push(t);
      const ms = Date.now() - t0;
      if (ms > 1000) console.log(`build-static: ETF ${t} holdings (N-PORT from EDGAR) ${(ms / 1000).toFixed(1)} s`);
    } catch (err) {
      console.warn(`build-static: ETF ${t}: ${(err as Error).message}`);
    }
  }
} catch (err) {
  console.warn(`build-static: ETF lists skipped (${(err as Error).message})`);
}
write('etfs.json', etfs);

write('documentation.json', JSON.parse(fs.readFileSync(path.join(store.file!, 'documentation.json'), 'utf8')));
write(
  'meta.json',
  {
    builtAt: new Date().toISOString(),
    filings: store.filingCount(), // every filing the app can open, here or from the data ref
    filingsOnSite: publishCount.filings, // the ones this site carries itself
    store: DATA_URL, // where the rest come from
    scores: scores.length,
    asOfFrom: asOfYears.length ? `${asOfYears.at(-1)}-01-01` : null,
    filingsFrom: PUBLISH_FROM,
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

// What the site weighs, against the 1 GB a GitHub Pages site may take. The
// filings are the part that grows (the crawler digs backwards for ever), so
// that is the one to cut - STOCKSCAN_PUBLISH_YEARS, fewer years.
const PAGES_LIMIT = PAGES_LIMIT_MB;
const mbOf = (dir: string) => {
  let n = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else n += fs.statSync(path.join(d, e.name)).size;
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return n / 1048576;
};
const parts: [string, number][] = [
  ['財報 filings', mbOf(path.join(storeOut, 'filings'))],
  ['評分 scores', mbOf(path.join(storeOut, 'scores'))],
  ['日線 bars', mbOf(path.join(dataOut, 'bars'))],
  ['索引 index', mbOf(path.join(OUT, 'index'))],
];
const total = mbOf(OUT);
console.log(`build-static: site ${total.toFixed(0)} MB / ${PAGES_LIMIT} MB (${parts.map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', ')}, 其他 ${(total - parts.reduce((n, [, v]) => n + v, 0)).toFixed(0)} MB)`);
if (total > PAGES_LIMIT * 0.85) console.warn(`build-static: WARNING 接近 GitHub Pages 的 1 GB 上限——把 STOCKSCAN_PUBLISH_MB 調小（目前 ${PUBLISH_MB} MB）`);
console.log(`build-static: done in ${((Date.now() - t0) / 1000).toFixed(0)} s -> ${OUT}`);
process.exit(0);
