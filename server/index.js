import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SecClient } from './lib/secClient.js';
import { openStore, requireVersion, store } from './lib/store.js';
import { createPrefetcher } from './lib/prefetch.js';
import { createCrawler } from './lib/crawler.js';
import { DEFAULT_FORMS, filingFromUrl, filingUrls, getCompany, pickFiling, refreshTickers, searchCompanies } from './lib/edgar.js';
import { scrapeFiling, SCRAPE_VERSION } from './lib/scrape.js';
import { buildQuarterly } from './lib/quarters.js';
import { buildIndicators } from './lib/indicators.js';
import { currentView } from './lib/current.js';
import { FILER_STATUS, SIC, getUniverse, lookupFiler, refreshUniverse, sicInfo, universeStale } from './lib/universe.js';
import { POPULAR_ETFS, etfHoldings, etfList } from './lib/etf.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

const client = new SecClient();
openStore();
requireVersion(SCRAPE_VERSION);
const prefetcher = createPrefetcher(client);
// Background crawl of every ticker company's latest filing (STOCKSCAN_CRAWL=0 turns it off).
const crawler = createCrawler(client, { prefetcher, enabled: !/^(0|false|no|off)$/i.test(process.env.STOCKSCAN_CRAWL || '1') });

// Ticker table: refresh in the background at startup and daily; the saved
// copy serves searches meanwhile.
const refresh = () => refreshTickers(client).then((rows) => console.log(`ticker table refreshed: ${rows.length} companies`)).catch((e) => console.warn(`ticker refresh failed: ${e.message}`));
setTimeout(refresh, 1000);
setInterval(refresh, 24 * 3600 * 1000).unref();

// Filer universe (SIC / filer status for the browse pages): build it in the
// background when missing or older than a week, so the first visit is instant.
setTimeout(() => {
  if (universeStale()) refreshUniverse(client, 'low').catch((e) => console.warn(`universe build failed: ${e.message}`));
}, 5000);
setTimeout(() => crawler.start(), 15_000);

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

// GET /api/search?q=goog  -> ticker / company-name suggestions
app.get(
  '/api/search',
  wrap(async (req, res) => {
    res.json(await searchCompanies(client, String(req.query.q || ''), Number(req.query.limit) || 10));
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
    res.json(await dedupe(`q4:${company.cik}:${year}`, () => buildQuarterly(client, company, year)));
    prefetcher.schedule(company, pickFiling(company.filings, { year, period: 'FY' }));
  }),
);

// GET /api/company/GOOGL/indicators?year=2023&period=Q3&n=20&basis=x4|ttm&mode=quarter|year
// -> financial ratios for the 20 fiscal quarters ending at FY2023 Q3, or with
//    mode=year, N years each made of the four quarters ending at that quarter
//    (2022 Q4 + 2023 Q1..Q3, 2021 Q4 + 2022 Q1..Q3, ...)
app.get(
  '/api/company/:id/indicators',
  wrap(async (req, res) => {
    const year = Number(req.query.year);
    const period = String(req.query.period || 'FY').toUpperCase();
    if (!year || !/^(Q[1-4]|FY)$/.test(period)) return res.status(400).json({ error: 'year and period (Q1-Q4 or FY) required' });
    const mode = req.query.mode === 'year' ? 'year' : 'quarter';
    const n = Math.min(mode === 'year' ? 10 : 40, Math.max(1, Number(req.query.n) || (mode === 'year' ? 5 : 20)));
    const basis = req.query.basis === 'ttm' ? 'ttm' : 'x4';
    const company = await getCompany(client, req.params.id);
    res.json(
      await dedupe(`ind:${company.cik}:${year}:${period}:${n}:${basis}:${mode}`, () => buildIndicators(client, company, { year, period, n, basis, mode })),
    );
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

const companyRow = (c) => ({
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

// GET /api/browse/sic -> SIC divisions and 4-digit codes with company counts
app.get(
  '/api/browse/sic',
  wrap(async (_req, res) => {
    const u = await getUniverse(client);
    const counts = new Map();
    for (const c of u.companies) {
      const k = c.sic || '0000';
      const n = counts.get(k) || { total: 0, listed: 0 };
      n.total++;
      if (c.ticker) n.listed++;
      counts.set(k, n);
    }
    const codes = SIC.codes.map((s) => ({ ...s, ...(counts.get(s.code) || { total: 0, listed: 0 }) }));
    // codes that appear in filings but not on SEC's list
    for (const [code, n] of counts) if (!SIC.codes.some((s) => s.code === code)) codes.push({ code, title: null, zh: code === '0000' ? '未指定' : null, division: 'J', office: null, ...n });
    res.json({ updatedAt: u.updatedAt, datasets: u.datasets, divisions: SIC.divisions, codes });
  }),
);

// GET /api/browse/filer -> filer-status categories with counts
app.get(
  '/api/browse/filer',
  wrap(async (_req, res) => {
    const u = await getUniverse(client);
    const counts = {};
    for (const c of u.companies) {
      const k = c.afs || 'UNKNOWN';
      counts[k] ??= { total: 0, listed: 0, wksi: 0 };
      counts[k].total++;
      if (c.ticker) counts[k].listed++;
      if (c.wksi) counts[k].wksi++;
    }
    const categories = [...Object.keys(FILER_STATUS), 'UNKNOWN'].map((k) => ({
      key: k,
      ...(FILER_STATUS[k] || { label: 'Not stated', zh: '未標示', note: '申報書未標示身分' }),
      ...(counts[k] || { total: 0, listed: 0, wksi: 0 }),
    }));
    res.json({ updatedAt: u.updatedAt, datasets: u.datasets, categories });
  }),
);

// GET /api/browse/companies?sic=7372 | ?afs=LAF [&listed=0] [&q=text] -> companies, largest public float first
app.get(
  '/api/browse/companies',
  wrap(async (req, res) => {
    const u = await getUniverse(client);
    const sic = req.query.sic ? String(req.query.sic).padStart(4, '0') : null;
    const afs = req.query.afs ? String(req.query.afs).toUpperCase() : null;
    const listedOnly = req.query.listed !== '0';
    const q = String(req.query.q || '').trim().toUpperCase();
    let rows = u.companies;
    if (sic) rows = rows.filter((c) => (c.sic || '0000') === sic);
    if (afs) rows = rows.filter((c) => (c.afs || 'UNKNOWN') === afs);
    if (listedOnly) rows = rows.filter((c) => c.ticker);
    if (q) rows = rows.filter((c) => c.name.toUpperCase().includes(q) || c.tickers.some((t) => t.startsWith(q)));
    res.json({
      updatedAt: u.updatedAt,
      sic: sic ? sicInfo(sic) : null,
      filer: afs ? { key: afs, ...(FILER_STATUS[afs] || { label: 'Not stated', zh: '未標示' }) } : null,
      count: rows.length,
      companies: rows.slice(0, Number(req.query.limit) || 2000).map(companyRow),
    });
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

// GET /api/status -> local store and prefetch queue
app.get('/api/status', (_req, res) => {
  res.json({ store: { file: store.file, ...store.size() }, prefetch: prefetcher.status(), crawler: crawler.status(), clientIdle: client.idle });
});

// Serve the built Vue app when it exists (npm run build:web).
const dist = path.join(__dirname, '..', 'web', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((err, _req, res, _next) => {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`stockscan server listening on http://localhost:${PORT}`);
  console.log(`store: ${store.file} (${store.filingCount()} filings saved)`);
  if (crawler.status().enabled) console.log('background crawl of latest filings enabled (STOCKSCAN_CRAWL=0 to disable)');
  if (!fs.existsSync(dist)) console.log('web/dist not found - run "npm run build:web" or use the Vite dev server (npm --prefix web run dev)');
});
