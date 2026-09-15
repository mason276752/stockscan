import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SecClient } from './lib/secClient.js';
import { DEFAULT_FORMS, filingFromUrl, filingUrls, getCompany, pickFiling, searchCompanies } from './lib/edgar.js';
import { scrapeFiling } from './lib/scrape.js';
import { buildQuarterly } from './lib/quarters.js';
import { buildIndicators } from './lib/indicators.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

const client = new SecClient();
const app = express();
app.use(express.json());

// In-flight de-duplication: two browser tabs asking for the same filing share one scrape.
const inflight = new Map();
function dedupe(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// GET /api/search?q=goog  -> ticker / company-name suggestions
app.get(
  '/api/search',
  wrap(async (req, res) => {
    res.json(await searchCompanies(client, String(req.query.q || ''), Number(req.query.limit) || 10));
  }),
);

// GET /api/company/GOOGL  -> company info + every Inline XBRL 10-K/10-Q/20-F/40-F,
// newest first, each tagged with fiscalYear / fiscalPeriod (FY, Q1-Q3)
app.get(
  '/api/company/:id',
  wrap(async (req, res) => {
    const forms = req.query.form ? String(req.query.form).split(',') : DEFAULT_FORMS;
    res.json(await getCompany(client, req.params.id, { forms }));
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
    res.json(await dedupe(filing.accession, () => scrapeFiling(client, filing, company)));
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

// GET /api/filing/1652044/0001652044-26-000048  -> one specific filing
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
    res.json(await dedupe(filing.accession, () => scrapeFiling(client, filing, company)));
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
    res.json(await dedupe(filing.accession, () => scrapeFiling(client, filing, company)));
  }),
);

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
  if (!fs.existsSync(dist)) console.log('web/dist not found - run "npm run build:web" or use the Vite dev server (npm --prefix web run dev)');
});
