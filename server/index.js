import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SecClient } from './lib/secClient.js';
import { openStore, requireVersion, store } from './lib/store.js';
import { createPrefetcher } from './lib/prefetch.js';
import { createCrawler } from './lib/crawler.js';
import { DEFAULT_FORMS, filingFromUrl, filingUrls, getCompany, listingOf, pickFiling, purgeDelisted, refreshTickers, searchCompanies } from './lib/edgar.js';
import { scrapeFiling, SCRAPE_VERSION } from './lib/scrape.js';
import { buildQuarterly } from './lib/quarters.js';
import { buildIndicators } from './lib/indicators.js';
import { currentView } from './lib/current.js';
import { buildValuation } from './lib/valuation.js';
import { ITEMS as SCORE_ITEMS, SCORE_VERSION, latestScore, latestScores, scoreAccession } from './lib/score.js';
import { SCREEN_FIELDS, browseCompanies, filerCounts, scoreBadge, screenQuery, screenRows, sicCounts, wantsMarket } from './lib/screen.js';
import { marketSnapshot, marketStatus } from './lib/market.js';
import { FILER_STATUS, SIC, getUniverse, lookupFiler, refreshUniverse, sicInfo, universeStale } from './lib/universe.js';
import { POPULAR_ETFS, etfHoldings, etfList } from './lib/etf.js';
import { liveHoldings } from './lib/liveHoldings.js';
import { dailyBars } from './lib/bars.js';
import { basketRequest, runBasket as runBasketWith } from './lib/basket.js';
import { barStore, openBarStore } from './lib/barStore.js';
import { createBarCrawler } from './lib/barCrawler.js';
import { ibConnect, ibStatus } from './lib/ib.js';
import { tvStatus } from './lib/tvws.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
// BASE_URL: serve everything under a path prefix (behind a reverse proxy at
// https://host/stockscan/ set BASE_URL=/stockscan). '' = the root.
const BASE = `/${String(process.env.BASE_URL || '').trim().replace(/^\/+|\/+$/g, '')}`.replace(/^\/$/, '');

const client = new SecClient();
openStore();
requireVersion(SCRAPE_VERSION);
openBarStore();
const prefetcher = createPrefetcher(client);
// Background crawl of every ticker company's latest filing (STOCKSCAN_CRAWL=0 turns it off).
const crawler = createCrawler(client, { prefetcher, enabled: !/^(0|false|no|off)$/i.test(process.env.STOCKSCAN_CRAWL || '1') });
// Background crawl of every ticker's daily bars from TradingView, once a day after the close (STOCKSCAN_BARS_CRAWL=0 turns it off).
const barCrawler = createBarCrawler(client, { enabled: !/^(0|false|no|off)$/i.test(process.env.STOCKSCAN_BARS_CRAWL || '1') });

// Ticker table: refresh in the background at startup and daily; the saved
// copy serves searches meanwhile. Each refresh also drops the filings of
// companies that have since left the table (delisted).
const refresh = () =>
  refreshTickers(client)
    .then((rows) => {
      console.log(`ticker table refreshed: ${rows.length} companies`);
      purgeDelisted(rows);
    })
    .catch((e) => console.warn(`ticker refresh failed: ${e.message}`));
setTimeout(refresh, 1000);
setInterval(refresh, 24 * 3600 * 1000).unref();

// Filer universe (SIC / filer status for the browse pages): build it in the
// background when missing or older than a week, so the first visit is instant.
setTimeout(() => {
  if (universeStale()) refreshUniverse(client, 'low').catch((e) => console.warn(`universe build failed: ${e.message}`));
}, 5000);
setTimeout(() => crawler.start(), 15_000);
setTimeout(() => barCrawler.start(), 20_000);
// market snapshot (price, market cap, multiples) for the screener: fetch at startup, refresh every half hour
setTimeout(() => marketSnapshot().catch(() => {}), 3000);
setInterval(() => marketSnapshot().catch(() => {}), 30 * 60 * 1000).unref();

// IBKR TWS for the custom-ETF charts: connect once at startup; when TWS is not
// running the charts use Yahoo Finance and the page offers a retry.
if (ibStatus().enabled) {
  setTimeout(() => {
    ibConnect(4000).then((ok) => {
      if (!ok) console.log(`ibkr: TWS / IB Gateway not reachable at ${ibStatus().host}:${ibStatus().port} - custom ETF charts use Yahoo Finance (IB_HOST / IB_PORT / IB_ENABLED=0)`);
    });
  }, 2000);
}

// Score every saved filing that has no score yet (new version, or filings
// saved before scoring existed) - a few ms each, in the background.
setTimeout(() => {
  const todo = store.unscoredAccessions(SCORE_VERSION);
  if (!todo.length) return;
  console.log(`scoring ${todo.length} saved filings in the background`);
  let i = 0;
  const step = () => {
    const t0 = Date.now();
    while (i < todo.length && Date.now() - t0 < 50) {
      try {
        scoreAccession(todo[i]);
      } catch (err) {
        console.warn(`score ${todo[i]}: ${err.message}`);
      }
      i++;
    }
    if (i < todo.length) setTimeout(step, 20);
    else console.log('scoring done');
  };
  step();
}, 8000);

const app = express();
app.use(express.json());
app.use('/api', (req, _res, next) => {
  if (req.path !== '/status') client.touch(); // any user request pauses background work (the status poll is not one)
  next();
});

// In-flight de-duplication: two browser tabs asking for the same filing share one scrape.
const inflight = new Map();
function dedupe(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// Scrape a filing and, with ?view=current, reduce it to its own period
// (needs the previous 10-Q for year-to-date-only statements).
async function filingResponse(req, company, filing) {
  const data = await dedupe(filing.accession, () => scrapeFiling(client, filing, company));
  prefetcher.schedule(company, filing);
  if (req.query.view !== 'current') return data;
  let prev = null;
  const q = /^Q([2-3])$/.exec(filing.fiscalPeriod || '');
  if (q) {
    const pf = pickFiling(company.filings, { year: filing.fiscalYear, period: `Q${Number(q[1]) - 1}` });
    if (pf) {
      try {
        prev = { filing: pf, data: await dedupe(pf.accession, () => scrapeFiling(client, pf, company)) };
      } catch (err) {
        console.warn(`previous filing ${pf.accession} unavailable: ${err.message}`);
      }
    }
  }
  return currentView(data, filing, prev);
}

// GET /api/search?q=goog  -> ticker / company-name suggestions, each with the
// latest-filing score when one is saved (so every search box can show it)
app.get(
  '/api/search',
  wrap(async (req, res) => {
    const rows = await searchCompanies(client, String(req.query.q || ''), Number(req.query.limit) || 10);
    res.json(
      rows.map((r) => {
        let score = null;
        try {
          score = latestScore(r.cik);
        } catch {
          /* unscorable filing: no badge */
        }
        return { ...r, score: scoreBadge(score) };
      }),
    );
  }),
);

// GET /api/company/GOOGL[?refresh=1]  -> company info + every Inline XBRL
// 10-K/10-Q/20-F/40-F, newest first, each tagged with fiscalYear /
// fiscalPeriod (FY, Q1-Q3). refresh=1 re-reads the filing list from SEC now.
app.get(
  '/api/company/:id',
  wrap(async (req, res) => {
    const forms = req.query.form ? String(req.query.form).split(',') : DEFAULT_FORMS;
    const company = await getCompany(client, req.params.id, { forms, refresh: req.query.refresh === '1' });
    // industry / filer status from the browse universe when it is already built
    res.json({ ...company, sicZh: sicInfo(company.sic)?.zh || null, filer: lookupFiler(company.cik) });
  }),
);

// GET /api/company/GOOGL/statements?year=2025&period=Q2   (no params = latest filing)
app.get(
  '/api/company/:id/statements',
  wrap(async (req, res) => {
    const forms = req.query.form ? String(req.query.form).split(',') : DEFAULT_FORMS;
    const company = await getCompany(client, req.params.id, { forms });
    const filing = pickFiling(company.filings, { year: req.query.year, period: req.query.period });
    if (!filing) {
      return res.status(404).json({
        error: `No filing for ${company.name} matching year=${req.query.year || '*'} period=${req.query.period || '*'}`,
        available: company.filings.map((f) => ({ fiscalYear: f.fiscalYear, fiscalPeriod: f.fiscalPeriod, form: f.form, accession: f.accession })),
      });
    }
    res.json(await filingResponse(req, company, filing));
  }),
);

// GET /api/company/GOOGL/quarters?year=2025 -> Q1..Q3 from the 10-Qs, FY from
// the 10-K and Q4 derived as FY - Q1 - Q2 - Q3
app.get(
  '/api/company/:id/quarters',
  wrap(async (req, res) => {
    const year = Number(req.query.year);
    if (!year) return res.status(400).json({ error: 'year query parameter required' });
    const company = await getCompany(client, req.params.id);
    res.json(await dedupe(`q4:${company.cik}:${year}`, () => buildQuarterly((f) => scrapeFiling(client, f, company), company, year)));
    prefetcher.schedule(company, pickFiling(company.filings, { year, period: 'FY' }));
  }),
);

// GET /api/company/GOOGL/indicators?year=2023&period=Q3&n=20&basis=x4|ttm&mode=quarter|year|same
// -> financial ratios for the 20 fiscal quarters ending at FY2023 Q3, or with
//    mode=year, N years each made of the four quarters ending at that quarter
//    (2022 Q4 + 2023 Q1..Q3, 2021 Q4 + 2022 Q1..Q3, ...); mode=same compares
//    the same quarter across N years (2019 Q3, 2020 Q3, ... 2023 Q3)
app.get(
  '/api/company/:id/indicators',
  wrap(async (req, res) => {
    const year = Number(req.query.year);
    const period = String(req.query.period || 'FY').toUpperCase();
    if (!year || !/^(Q[1-4]|FY)$/.test(period)) return res.status(400).json({ error: 'year and period (Q1-Q4 or FY) required' });
    const mode = ['year', 'same'].includes(req.query.mode) ? req.query.mode : 'quarter';
    const n = Math.min(mode === 'quarter' ? 40 : 10, Math.max(1, Number(req.query.n) || (mode === 'quarter' ? 20 : 5)));
    const basis = req.query.basis === 'ttm' ? 'ttm' : 'x4';
    const company = await getCompany(client, req.params.id);
    res.json(
      await dedupe(`ind:${company.cik}:${year}:${period}:${n}:${basis}:${mode}`, () => buildIndicators((f) => scrapeFiling(client, f, company), company, { year, period, n, basis, mode })),
    );
  }),
);

// GET /api/company/AAPL/valuation?year=2026&period=Q3&n=20 -> relative
// multiples over the last N quarters (price at each quarter end) and absolute
// models on the trailing four quarters at today's price
app.get(
  '/api/company/:id/valuation',
  wrap(async (req, res) => {
    const year = Number(req.query.year);
    const period = String(req.query.period || 'FY').toUpperCase();
    if (!year || !/^(Q[1-4]|FY)$/.test(period)) return res.status(400).json({ error: 'year and period (Q1-Q4 or FY) required' });
    const n = Math.min(40, Math.max(4, Number(req.query.n) || 20));
    const adr = Math.max(0.0001, Number(req.query.adr) || 1); // ordinary shares per listed share (ADR ratio)
    const company = await getCompany(client, req.params.id);
    res.json(await dedupe(`val:${company.cik}:${year}:${period}:${n}:${adr}`, () => buildValuation(client, company, { year, period, n, adr })));
  }),
);

// GET /api/filing/1652044/0001652044-26-000048[?view=current]  -> one specific
// filing; view=current keeps only the filing's own period in every statement
app.get(
  '/api/filing/:cik/:accession',
  wrap(async (req, res) => {
    const company = await getCompany(client, req.params.cik);
    let filing = company.filings.find((f) => f.accession === req.params.accession);
    if (!filing) {
      // Not in the list (odd form type): look it up from the folder index.
      const cik = company.cik;
      const nodash = req.params.accession.replace(/-/g, '');
      const idx = await client.json(`https://www.sec.gov/Archives/edgar/data/${cik}/${nodash}/index.json`);
      const doc = idx.directory.item.find((i) => /^[a-z0-9-]+-\d{8}\.htm$/i.test(i.name));
      if (!doc) return res.status(404).json({ error: `Cannot find an Inline XBRL document in ${req.params.accession}` });
      filing = { cik, accession: req.params.accession, primaryDocument: doc.name, ...filingUrls(cik, req.params.accession, doc.name) };
    }
    res.json(await filingResponse(req, company, filing));
  }),
);

// GET /api/filing?url=https://www.sec.gov/ix?doc=/Archives/edgar/data/...
app.get(
  '/api/filing',
  wrap(async (req, res) => {
    if (!req.query.url) return res.status(400).json({ error: 'url query parameter required' });
    const base = filingFromUrl(String(req.query.url));
    const company = await getCompany(client, String(base.cik));
    const filing = company.filings.find((f) => f.accession === base.accession) || base;
    res.json(await filingResponse(req, company, filing));
  }),
);

// ---------- browse: industry (SIC), filer status, ETF constituents ----------

// GET /api/browse/sic -> SIC divisions and 4-digit codes with company counts
app.get(
  '/api/browse/sic',
  wrap(async (_req, res) => {
    const u = await getUniverse(client);
    res.json({ updatedAt: u.updatedAt, datasets: u.datasets, ...sicCounts(u.companies) });
  }),
);

// GET /api/browse/filer -> filer-status categories with counts
app.get(
  '/api/browse/filer',
  wrap(async (_req, res) => {
    const u = await getUniverse(client);
    res.json({ updatedAt: u.updatedAt, datasets: u.datasets, categories: filerCounts(u.companies) });
  }),
);

// GET /api/browse/companies?sic=7372 | ?afs=LAF [&listed=0] [&q=text] -> companies, largest public float first
app.get(
  '/api/browse/companies',
  wrap(async (req, res) => {
    const u = await getUniverse(client);
    res.json({ updatedAt: u.updatedAt, ...browseCompanies(u.companies, req.query) });
  }),
);

// GET /api/browse/etf[?q=text] -> ETF list (popular ones first)
app.get(
  '/api/browse/etf',
  wrap(async (req, res) => {
    const { etfs, updatedAt } = await etfList(client);
    const q = String(req.query.q || '').trim().toUpperCase();
    const rank = new Map(POPULAR_ETFS.map((t, i) => [t, i]));
    let rows = etfs;
    if (q) rows = rows.filter((e) => e.ticker.startsWith(q) || e.name.toUpperCase().includes(q) || e.entity.toUpperCase().includes(q));
    rows = [...rows].sort((a, b) => (rank.get(a.ticker) ?? 1e9) - (rank.get(b.ticker) ?? 1e9) || a.ticker.localeCompare(b.ticker));
    res.json({ updatedAt, total: etfs.length, count: rows.length, popular: POPULAR_ETFS, etfs: rows.slice(0, Number(req.query.limit) || 300) });
  }),
);

// GET /api/browse/etf/VOO -> latest N-PORT constituents, mapped to EDGAR companies
app.get(
  '/api/browse/etf/:ticker',
  wrap(async (req, res) => {
    res.json(await dedupe(`etf:${req.params.ticker.toUpperCase()}`, () => etfHoldings(client, req.params.ticker)));
  }),
);

// ---------- scores ----------

// GET /api/score?ciks=320193,1045810 -> score of each company's newest saved
// filing (null when the crawler has not saved one yet)
app.get('/api/score', (req, res) => {
  const ciks = String(req.query.ciks || '')
    .split(',')
    .map((x) => Number(x))
    .filter((x) => Number.isInteger(x) && x > 0)
    .slice(0, 6000);
  const out = {};
  for (const cik of ciks) {
    const s = latestScore(cik);
    out[cik] = scoreBadge(s);
  }
  res.json({ version: SCORE_VERSION, items: SCORE_ITEMS.map(({ key, name, category, benchmark, weight }) => ({ key, name, category, benchmark, weight })), scores: out });
});

// GET /api/score/1652044/0001652044-26-000048 -> full score breakdown of one filing (scrapes it if needed)
app.get(
  '/api/score/:cik/:accession',
  wrap(async (req, res) => {
    let s = scoreAccession(req.params.accession);
    if (!s) {
      const company = await getCompany(client, req.params.cik);
      const filing = company.filings.find((f) => f.accession === req.params.accession);
      if (!filing) return res.status(404).json({ error: `Filing ${req.params.accession} not found` });
      await dedupe(filing.accession, () => scrapeFiling(client, filing, company));
      s = scoreAccession(filing.accession);
    }
    if (!s) return res.status(404).json({ error: 'Cannot score this filing' });
    res.json(s);
  }),
);

// ---------- screener ----------

app.get('/api/screen/fields', (_req, res) => res.json({ fields: SCREEN_FIELDS, divisions: SIC.divisions, filer: FILER_STATUS, market: marketStatus() }));

// GET /api/screen?sic=7372&division=D&afs=LAF&exdiv=H,I&exsic=6770,2834&score_min=60&grossMargin_min=40
//     &roe_chg_min=2&revenueAnn_yoy_min=10&price_max=50&marketCap_min=1000&sort=score&dir=desc&limit=200
// -> companies whose newest saved filing passes every filter (values are the
//    single-filing figures used for the score: year-to-date, annualised).
//    <key>_min / _max filter the value; <key>_chg_* the change since the
//    previous filing; <key>_yoy_* the change since the same period a year
//    earlier - percentage points for ratios, % growth for amounts and the score.
app.get(
  '/api/screen',
  wrap(async (req, res) => {
    const u = await getUniverse(client);
    const byCik = new Map(u.companies.map((c) => [c.cik, c]));
    const market = await marketSnapshot({ wait: wantsMarket(req.query) });
    const scores = latestScores();
    const rows = screenRows(scores, byCik, market?.byTicker || null);
    res.json({ ...screenQuery(rows, req.query), scored: scores.length, market: marketStatus() });
  }),
);

// GET /api/browse/etf/QQQ/live -> freshest constituents (issuer daily file /
// index list, else N-PORT) for copying into and resyncing a custom ETF
app.get(
  '/api/browse/etf/:ticker/live',
  wrap(async (req, res) => {
    res.json(await dedupe(`etf-live:${req.params.ticker.toUpperCase()}`, () => liveHoldings(client, req.params.ticker)));
  }),
);

// ---- custom ETF (basket) charts: daily bars from IBKR TWS, else Yahoo ----

// GET /api/quotes/tv-symbol/:ticker -> { symbol: 'NASDAQ:AAPL' } for TradingView's
// widget (a bare ticker can resolve to another country's listing)
app.get(
  '/api/quotes/tv-symbol/:ticker',
  wrap(async (req, res) => {
    const t = String(req.params.ticker).toUpperCase().replace(/\./g, '-');
    const snap = await marketSnapshot();
    const rec = snap?.byTicker?.[t];
    res.json({ ticker: t, symbol: rec?.tv || t.replace(/-/g, '.'), exchange: rec?.exchange || null, known: !!rec });
  }),
);

// GET /api/quotes/status -> is TWS / IB Gateway reachable (else bars come from Yahoo)
// The licensed TradingView Advanced Charts library, when present in
// web/assets/tradingview/ (charting_library/ + datafeeds/), is served at
// /tradingview/ and the custom-ETF page uses it instead of Lightweight Charts.
const TV_DIR = path.join(__dirname, '..', 'web', 'assets', 'tradingview');
const tvLibrary = () => fs.existsSync(path.join(TV_DIR, 'charting_library', 'charting_library.standalone.js'));
if (tvLibrary()) app.use('/tradingview', express.static(TV_DIR, { maxAge: '1h' }));
app.get('/api/quotes/status', (_req, res) => res.json({ tv: tvStatus(), ib: ibStatus(), source: tvStatus().enabled ? 'TradingView' : ibStatus().connected ? 'IBKR' : 'Yahoo Finance', tvLibrary: tvLibrary() }));
// POST /api/quotes/ib/connect -> (re)try the TWS connection now
app.post(
  '/api/quotes/ib/connect',
  wrap(async (_req, res) => {
    await ibConnect(5000);
    res.json({ ib: ibStatus() });
  }),
);

// GET /api/bars/AAPL -> ten years of daily OHLC (split-adjusted)
app.get(
  '/api/bars/:symbol',
  wrap(async (req, res) => {
    res.json(await dedupe(`bars:${req.params.symbol.toUpperCase()}`, () => dailyBars(req.params.symbol)));
  }),
);

// The custom-ETF index (basket.js): every constituent's daily bars, a few at
// a time, then the index; with `emit` the page draws while the rest lands.
const basketEnv = () => ({ listingOf, extra: { ib: ibStatus().connected, tv: tvStatus().connected } });
const runBasket = (req, opts = {}) => runBasketWith(req, (ticker) => dedupe(`bars:${ticker}`, () => dailyBars(ticker)), { ...opts, ...basketEnv() });

// POST /api/basket { constituents: [{ ticker, cik, weight }], range, rebalance, benchmark }
//  -> index bars (base 100), stats, per-constituent returns, benchmark overlay
app.post(
  '/api/basket',
  wrap(async (req, res) => {
    res.json(await runBasket(basketRequest(req.body || {})));
  }),
);

// POST /api/basket/stream - the same, streamed as NDJSON (one JSON object per
// line): { type: 'start' } → { type: 'member' } per constituent as its bars
// arrive → (with { interim: true } in the body: { type: 'series', partial: true }
// every second or so) → the final { type: 'series', partial: false }.
// Closing the connection stops the work.
app.post(
  '/api/basket/stream',
  wrap(async (req, res) => {
    const request = basketRequest(req.body || {});
    res.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    const emit = (ev) => {
      if (!res.writableEnded && !ac.signal.aborted) res.write(`${JSON.stringify(ev)}\n`);
    };
    try {
      await runBasket(request, { emit, signal: ac.signal, interim: req.body?.interim ? 1200 : 0 });
    } catch (err) {
      emit({ type: 'error', error: err.message });
    }
    res.end();
  }),
);

// GET /api/status -> local store and prefetch queue
app.get('/api/status', (_req, res) => {
  res.json({ store: { file: store.file, ...store.size(), bars: barStore.stats() }, prefetch: prefetcher.status(), crawler: crawler.status(), barCrawler: barCrawler.status(), clientIdle: client.idle, tv: tvStatus(), ib: ibStatus() });
});

// Serve the built Vue app when it exists (npm run build:web). The build uses
// relative asset URLs, so the same bundle works under any BASE_URL; the page
// is told the prefix so its API calls go to the right place.
const dist = path.join(__dirname, '..', 'web', 'dist');
if (fs.existsSync(dist)) {
  const page = fs.readFileSync(path.join(dist, 'index.html'), 'utf8').replace('</head>', `<script>window.__STOCKSCAN_BASE__=${JSON.stringify(BASE)}</script></head>`);
  app.use(express.static(dist, { index: false }));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.type('html').send(page));
}

app.use((err, _req, res, _next) => {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message });
});

// the prefix: /stockscan -> /stockscan/ (relative asset URLs need the slash), everything below it -> app
let root = app;
if (BASE) {
  root = express();
  root.use((req, res, next) => (req.path === BASE ? res.redirect(301, `${BASE}/${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`) : next()));
  root.use(BASE, app);
  root.use((_req, res) => res.status(404).type('text').send(`stockscan is served under ${BASE}/`));
}

root.listen(PORT, () => {
  console.log(`stockscan server listening on http://localhost:${PORT}${BASE}/`);
  console.log(`store: ${store.file} (${store.filingCount()} filings saved)`);
  if (crawler.status().enabled) console.log('background crawl of latest filings enabled (STOCKSCAN_CRAWL=0 to disable)');
  if (barCrawler.status().enabled) console.log('background crawl of daily bars enabled (STOCKSCAN_BARS_CRAWL=0 to disable)');
  if (!fs.existsSync(dist)) console.log('web/dist not found - run "npm run build:web" or use the Vite dev server (npm --prefix web run dev)');
});
