// Every SEC filer with its SIC code and filer status, for the browse pages.
//
// Source: the Financial Statement Data Sets (one zip per calendar quarter);
// their sub.txt lists every 10-K/10-Q/20-F… submission with the filer's SIC
// and `afs` (filer status: 1-LAF large accelerated, 2-ACC accelerated,
// 4-NON non-accelerated). Only sub.txt is pulled out of each zip (Range
// requests), the last four quarters cover every active filer. Public float
// (which is what decides the filer status) comes from the XBRL frames API.


import { store } from './store.js';
import { readZipEntry } from './remoteZip.js';
import { tickerTable } from './edgar.js';
import { FILER_STATUS, SIC, sicInfo } from './sic.js';

export { FILER_STATUS, SIC, sicInfo };


const DATASETS = 'https://www.sec.gov/files/dera/data/financial-statement-data-sets/';
const FRAMES_BASE = 'https://data.sec.gov/api/xbrl/frames/';
const UNIVERSE_TTL = 7 * 24 * 3600 * 1000;
const QUARTERS = 4; // datasets to merge
const FLOAT_FRAMES = 10; // quarter-end instants to scan (2.5 years: the latest public float and the one before)

const ANNUAL_FORMS = /^(10-K|10-Q|20-F|40-F|10-KT|10-QT)(\/A)?$/;

// Candidate dataset names, newest first: 2026q3, 2026q2, ...
function datasetNames(now = new Date(), count = QUARTERS + 3) {
  const out = [];
  let y = now.getUTCFullYear();
  let q = Math.floor(now.getUTCMonth() / 3) + 1;
  for (let i = 0; i < count; i++) {
    out.push(`${y}q${q}`);
    if (--q === 0) {
      q = 4;
      y--;
    }
  }
  return out;
}

function parseSub(text) {
  const lines = text.split('\n');
  const header = lines[0].replace(/\r$/, '').split('\t');
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].replace(/\r$/, '').split('\t');
    if (f.length < header.length) continue;
    const form = f[col.form];
    if (!ANNUAL_FORMS.test(form)) continue;
    rows.push({
      cik: Number(f[col.cik]),
      name: f[col.name],
      sic: f[col.sic] ? f[col.sic].padStart(4, '0') : null,
      afs: f[col.afs] ? f[col.afs].slice(2) : null, // "1-LAF" -> "LAF"
      wksi: f[col.wksi] === '1',
      fye: f[col.fye] || null,
      form,
      period: f[col.period] || null,
      filed: f[col.filed] || null,
      state: f[col.stprba] || null,
      country: f[col.countryba] || null,
      cityba: f[col.cityba] || null,
    });
  }
  return rows;
}

async function loadDatasets(client, priority) {
  const names = datasetNames();
  const used = [];
  const byCik = new Map();
  for (const name of names) {
    if (used.length >= QUARTERS) break;
    const url = `${DATASETS}${name}.zip`;
    let text;
    try {
      text = (await readZipEntry(client, url, 'sub.txt', { priority })).toString('utf8');
    } catch (err) {
      if (err.status === 404) continue; // quarter not published yet
      throw err;
    }
    used.push(name);
    for (const row of parseSub(text)) {
      const prev = byCik.get(row.cik);
      // newest submission wins; a row with a filer status beats one without.
      // WKSI is only flagged on annual reports, so keep it once seen.
      if (prev) row.wksi = row.wksi || prev.wksi;
      if (!prev || (row.afs && !prev.afs) || (!!row.afs === !!prev.afs && row.filed > prev.filed)) byCik.set(row.cik, row);
      else prev.wksi = prev.wksi || row.wksi;
    }
  }
  if (!used.length) throw new Error('No Financial Statement Data Set could be downloaded from SEC');
  return { datasets: used, byCik };
}

// One concept's values for every filer over the last FLOAT_FRAMES quarter-end
// instants: Map cik -> [{ value, date }] newest first.
async function loadFrames(client, concept, priority) {
  const out = new Map();
  const now = new Date();
  let y = now.getUTCFullYear();
  let q = Math.floor(now.getUTCMonth() / 3) + 1;
  for (let i = 0; i < FLOAT_FRAMES; i++) {
    try {
      const frame = await client.json(`${FRAMES_BASE}${concept}/${concept.startsWith('dei/EntityCommonStock') ? 'shares' : 'USD'}/CY${y}Q${q}I.json`, { priority });
      for (const d of frame.data || []) {
        if (typeof d.val !== 'number') continue;
        if (!out.has(d.cik)) out.set(d.cik, []);
        out.get(d.cik).push({ value: d.val, date: d.end });
      }
    } catch (err) {
      if (err.status !== 404) console.warn(`frame ${concept} CY${y}Q${q}I: ${err.message}`);
    }
    if (--q === 0) {
      q = 4;
      y--;
    }
  }
  for (const list of out.values()) list.sort((a, b) => (a.date < b.date ? 1 : -1));
  return out;
}

const BERKSHIRE = 1067983; // the one share price legitimately above $10,000

async function loadFloatFrames(client, priority) {
  const [floats, shares, assets] = await Promise.all([
    loadFrames(client, 'dei/EntityPublicFloat', priority),
    loadFrames(client, 'dei/EntityCommonStockSharesOutstanding', priority),
    loadFrames(client, 'us-gaap/Assets', priority),
  ]);
  return { floats, shares, assets };
}

const nearest = (list, date) => (list || []).find((x) => x.date <= date) || (list || []).at(-1) || null;

// Latest public float of one filer. Filers sometimes tag EntityPublicFloat in
// the wrong scale (thousands or millions), so the value is checked against the
// implied share price, the ratio to total assets, the previous year's figure
// and the filer status itself (an accelerated filer's float is < $700M by
// definition); a value that fails is divided by 1,000 and flagged.
function resolveFloat(frames, cik, afs) {
  const list = frames.floats.get(cik);
  if (!list) return null;
  let { value, date } = list[0];
  const prior = list.find((x) => x.date < date && x.date.slice(0, 4) < date.slice(0, 4));
  const sh = nearest(frames.shares.get(cik), date);
  const as = nearest(frames.assets.get(cik), date);
  let adjusted = false;
  for (let i = 0; i < 2; i++) {
    const price = sh && sh.value > 0 && cik !== BERKSHIRE ? value / sh.value : null;
    const toAssets = as && as.value > 0 ? value / as.value : null;
    const jumped = prior && prior.value > 0 && value / prior.value >= 100; // 100× the year before
    // (asset and year-over-year tests only for floats big enough to matter: tiny shells are noisy)
    const strong = price > 10_000 || (toAssets > 300 && value > 1e8) || (afs === 'ACC' && value >= 7e8 * 1.5);
    const weak = jumped && value > 1e8 && (price > 500 || toAssets > 30);
    if (!strong && !weak) break;
    // never push the value below what the filer status requires (shares data can be wrong too)
    const floor = afs === 'LAF' ? 7e8 * 0.8 : afs === 'ACC' ? 7.5e7 * 0.8 : 0;
    if (value / 1000 < floor) break;
    value /= 1000;
    adjusted = true;
  }
  // the opposite slip: a large accelerated filer reporting a few hundred thousand dollars
  if (afs === 'LAF' && value > 0 && value < 1e6) {
    value *= 1000;
    adjusted = true;
  }
  return { value, date, adjusted };
}

async function buildUniverse(client, priority) {
  const [{ datasets, byCik }, frames, tickers] = await Promise.all([loadDatasets(client, priority), loadFloatFrames(client, priority), tickerTable(client)]);
  const tickersByCik = new Map();
  for (const t of tickers) {
    if (!tickersByCik.has(t.cik)) tickersByCik.set(t.cik, []);
    tickersByCik.get(t.cik).push(t.ticker);
  }
  const companies = [];
  for (const row of byCik.values()) {
    const tk = (tickersByCik.get(row.cik) || []).sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
    const fl = resolveFloat(frames, row.cik, row.afs);
    companies.push({ ...row, tickers: tk, ticker: tk[0] || null, float: fl?.value ?? null, floatDate: fl?.date ?? null, floatAdjusted: !!fl?.adjusted });
  }
  companies.sort((a, b) => (b.float ?? -1) - (a.float ?? -1) || a.name.localeCompare(b.name));
  return { updatedAt: new Date().toISOString(), datasets, companies };
}

let memo = null;
let building = null;

// Cached universe: memory -> SQLite (refreshed in the background when older
// than a week) -> built from SEC on first use.
export async function getUniverse(client, { priority = 'high' } = {}) {
  if (memo) return memo;
  const saved = store.getDoc('universe.json');
  if (saved) {
    memo = saved.value;
    if (saved.ageMs > UNIVERSE_TTL) refreshUniverse(client, 'low').catch((e) => console.warn(`universe refresh failed: ${e.message}`));
    return memo;
  }
  return refreshUniverse(client, priority);
}

export function refreshUniverse(client, priority = 'low') {
  if (building) return building;
  building = buildUniverse(client, priority)
    .then((u) => {
      store.putDoc('universe.json', u);
      memo = u;
      console.log(`universe refreshed: ${u.companies.length} filers from ${u.datasets.join(', ')}`);
      return u;
    })
    .finally(() => {
      building = null;
    });
  return building;
}

// Classification of one filer from whatever copy is already at hand (no
// network) - for decorating the company page.
export function lookupFiler(cik) {
  const u = memo || store.getDoc('universe.json')?.value;
  if (!u) return null;
  if (!memo) memo = u;
  const c = u.companies.find((x) => x.cik === cik);
  if (!c) return null;
  return { afs: c.afs, filerStatus: FILER_STATUS[c.afs] || null, wksi: c.wksi, publicFloat: c.float, publicFloatDate: c.floatDate, publicFloatAdjusted: c.floatAdjusted, sic: c.sic, sicInfo: sicInfo(c.sic) };
}

export function universeStale() {
  const saved = store.getDoc('universe.json');
  return !saved || saved.ageMs > UNIVERSE_TTL;
}
