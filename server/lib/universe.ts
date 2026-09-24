// Every SEC filer with its SIC code and filer status, for the browse pages.
//
// Source: the Financial Statement Data Sets (one zip per calendar quarter);
// their sub.txt lists every 10-K/10-Q/20-F… submission with the filer's SIC
// and `afs` (filer status: 1-LAF large accelerated, 2-ACC accelerated,
// 4-NON non-accelerated). Only sub.txt is pulled out of each zip (Range
// requests), the last four quarters cover every active filer. Public float
// (which is what decides the filer status) comes from the XBRL frames API.


import { store } from './store.ts';
import { readZipEntry } from './remoteZip.ts';
import { tickerTable } from './edgar.ts';
import { FILER_STATUS, SIC, sicInfo } from './sic.ts';

export { FILER_STATUS, SIC, sicInfo };
import type { Fetcher, Priority } from './secClient.ts';
import type { IsoDate, UniverseCompany } from './types.ts';
import type { FilerStatus, FilerStatusCode, SicCode } from './sic.ts';

/** One submission row of sub.txt: who filed, and how they are classified. */
interface SubRow {
  cik: number;
  name: string;
  sic: string | null;
  afs: string | null;
  wksi: boolean;
  fye: string | null;
  form: string;
  period: IsoDate | null;
  filed: IsoDate | null;
  state: string | null;
  country: string | null;
  cityba: string | null;
}

/** One value of one filer at one quarter end. */
interface FrameValue {
  value: number;
  date: IsoDate;
}

/** The three concepts the float sanity-check reads. */
interface FloatFrames {
  floats: Map<number, FrameValue[]>;
  shares: Map<number, FrameValue[]>;
  assets: Map<number, FrameValue[]>;
}

/** Every filer, as the browse pages read them. */
export interface Universe {
  updatedAt: string;
  datasets: string[];
  companies: UniverseCompany[];
}


const DATASETS = 'https://www.sec.gov/files/dera/data/financial-statement-data-sets/';
const FRAMES_BASE = 'https://data.sec.gov/api/xbrl/frames/';
const UNIVERSE_TTL = 7 * 24 * 3600 * 1000;
const QUARTERS = 4; // datasets to merge
const FLOAT_FRAMES = 10; // quarter-end instants to scan (2.5 years: the latest public float and the one before)

const ANNUAL_FORMS = /^(10-K|10-Q|20-F|40-F|10-KT|10-QT)(\/A)?$/;

// Candidate dataset names, newest first: 2026q3, 2026q2, ...
function datasetNames(now = new Date(), count = QUARTERS + 3): string[] {
  const out: string[] = [];
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

function parseSub(text: string): SubRow[] {
  const lines = text.split('\n');
  const header = lines[0]!.replace(/\r$/, '').split('\t');
  const col = Object.fromEntries(header.map((h, i) => [h, i])) as Record<string, number>;
  const rows: SubRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i]!.replace(/\r$/, '').split('\t');
    if (f.length < header.length) continue;
    const form = f[col.form!]!;
    if (!ANNUAL_FORMS.test(form)) continue;
    rows.push({
      cik: Number(f[col.cik!]),
      name: f[col.name!]!,
      sic: f[col.sic!] ? f[col.sic!]!.padStart(4, '0') : null,
      afs: f[col.afs!] ? f[col.afs!]!.slice(2) : null, // "1-LAF" -> "LAF"
      wksi: f[col.wksi!] === '1',
      fye: f[col.fye!] || null,
      form,
      period: f[col.period!] || null,
      filed: f[col.filed!] || null,
      state: f[col.stprba!] || null,
      country: f[col.countryba!] || null,
      cityba: f[col.cityba!] || null,
    });
  }
  return rows;
}

async function loadDatasets(client: Fetcher, priority: Priority | undefined): Promise<{ datasets: string[]; byCik: Map<number, SubRow> }> {
  const names = datasetNames();
  const used: string[] = [];
  const byCik = new Map<number, SubRow>();
  for (const name of names) {
    if (used.length >= QUARTERS) break;
    const url = `${DATASETS}${name}.zip`;
    let text: string;
    try {
      text = (await readZipEntry(client, url, 'sub.txt', { priority })).toString('utf8');
    } catch (err) {
      if ((err as { status?: number }).status === 404) continue; // quarter not published yet
      throw err;
    }
    used.push(name);
    for (const row of parseSub(text)) {
      const prev = byCik.get(row.cik);
      // newest submission wins; a row with a filer status beats one without.
      // WKSI is only flagged on annual reports, so keep it once seen.
      if (prev) row.wksi = row.wksi || prev.wksi;
      if (!prev || (row.afs && !prev.afs) || (!!row.afs === !!prev.afs && row.filed! > prev.filed!)) byCik.set(row.cik, row);
      else prev.wksi = prev.wksi || row.wksi;
    }
  }
  if (!used.length) throw new Error('No Financial Statement Data Set could be downloaded from SEC');
  return { datasets: used, byCik };
}

// One concept's values for every filer over the last FLOAT_FRAMES quarter-end
// instants: Map cik -> [{ value, date }] newest first.
async function loadFrames(client: Fetcher, concept: string, priority: Priority | undefined): Promise<Map<number, FrameValue[]>> {
  const out = new Map<number, FrameValue[]>();
  const now = new Date();
  let y = now.getUTCFullYear();
  let q = Math.floor(now.getUTCMonth() / 3) + 1;
  for (let i = 0; i < FLOAT_FRAMES; i++) {
    try {
      const frame = await client.json<{ data?: { cik: number; val: unknown; end: IsoDate }[] }>(`${FRAMES_BASE}${concept}/${concept.startsWith('dei/EntityCommonStock') ? 'shares' : 'USD'}/CY${y}Q${q}I.json`, { priority });
      for (const d of frame.data || []) {
        if (typeof d.val !== 'number') continue;
        if (!out.has(d.cik)) out.set(d.cik, []);
        out.get(d.cik)!.push({ value: d.val, date: d.end });
      }
    } catch (err) {
      if ((err as { status?: number }).status !== 404) console.warn(`frame ${concept} CY${y}Q${q}I: ${(err as Error).message}`);
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

async function loadFloatFrames(client: Fetcher, priority: Priority | undefined): Promise<FloatFrames> {
  const [floats, shares, assets] = await Promise.all([
    loadFrames(client, 'dei/EntityPublicFloat', priority),
    loadFrames(client, 'dei/EntityCommonStockSharesOutstanding', priority),
    loadFrames(client, 'us-gaap/Assets', priority),
  ]);
  return { floats, shares, assets };
}

const nearest = (list: FrameValue[] | undefined, date: IsoDate) => (list || []).find((x) => x.date <= date) || (list || []).at(-1) || null;

// Latest public float of one filer. Filers sometimes tag EntityPublicFloat in
// the wrong scale (thousands or millions), so the value is checked against the
// implied share price, the ratio to total assets, the previous year's figure
// and the filer status itself (an accelerated filer's float is < $700M by
// definition); a value that fails is divided by 1,000 and flagged.
function resolveFloat(frames: FloatFrames, cik: number, afs: string | null): { value: number; date: IsoDate; adjusted: boolean } | null {
  const list = frames.floats.get(cik);
  if (!list) return null;
  let { value, date } = list[0]!;
  const prior = list.find((x) => x.date < date && x.date.slice(0, 4) < date.slice(0, 4));
  const sh = nearest(frames.shares.get(cik), date);
  const as = nearest(frames.assets.get(cik), date);
  let adjusted = false;
  for (let i = 0; i < 2; i++) {
    const price = sh && sh.value > 0 && cik !== BERKSHIRE ? value / sh.value : null;
    const toAssets = as && as.value > 0 ? value / as.value : null;
    const jumped = prior && prior.value > 0 && value / prior.value >= 100; // 100× the year before
    // (asset and year-over-year tests only for floats big enough to matter: tiny shells are noisy)
    const strong = price! > 10_000 || (toAssets! > 300 && value > 1e8) || (afs === 'ACC' && value >= 7e8 * 1.5);
    const weak = jumped && value > 1e8 && (price! > 500 || toAssets! > 30);
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

async function buildUniverse(client: Fetcher, priority: Priority | undefined): Promise<Universe> {
  const [{ datasets, byCik }, frames, tickers] = await Promise.all([loadDatasets(client, priority), loadFloatFrames(client, priority), tickerTable(client)]);
  const tickersByCik = new Map<number, string[]>();
  for (const t of tickers) {
    if (!tickersByCik.has(t.cik)) tickersByCik.set(t.cik, []);
    tickersByCik.get(t.cik)!.push(t.ticker);
  }
  const companies: UniverseCompany[] = [];
  for (const row of byCik.values()) {
    const tk = (tickersByCik.get(row.cik) || []).sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
    const fl = resolveFloat(frames, row.cik, row.afs);
    companies.push({ ...row, tickers: tk, ticker: tk[0] || null, float: fl?.value ?? null, floatDate: fl?.date ?? null, floatAdjusted: !!fl?.adjusted });
  }
  companies.sort((a, b) => (b.float ?? -1) - (a.float ?? -1) || a.name.localeCompare(b.name));
  return { updatedAt: new Date().toISOString(), datasets, companies };
}

let memo: Universe | null = null;
let building: Promise<Universe> | null = null;

// Cached universe: memory -> SQLite (refreshed in the background when older
// than a week) -> built from SEC on first use.
// the saved universe with its age from the updatedAt inside (a git checkout
// resets file mtimes, so the file's own time is what counts)
function savedUniverse(): { value: Universe; ageMs: number } | null {
  const saved = store.getDoc<Universe>('universe.json');
  if (!saved) return null;
  const at = Date.parse(saved.value?.updatedAt || '');
  return { value: saved.value, ageMs: Number.isFinite(at) ? Date.now() - at : saved.ageMs };
}

export async function getUniverse(client: Fetcher, { priority = 'high' }: { priority?: Priority } = {}): Promise<Universe> {
  if (memo) return memo;
  const saved = savedUniverse();
  if (saved) {
    memo = saved.value;
    if (saved.ageMs > UNIVERSE_TTL) refreshUniverse(client, 'low').catch((e) => console.warn(`universe refresh failed: ${(e as Error).message}`));
    return memo;
  }
  return refreshUniverse(client, priority);
}

export function refreshUniverse(client: Fetcher, priority: Priority = 'low'): Promise<Universe> {
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
/** How a filer is classified, for the company header. */
export interface FilerInfo {
  afs: string | null;
  filerStatus: FilerStatus | null;
  wksi?: boolean;
  publicFloat?: number | null;
  publicFloatDate?: IsoDate | null;
  publicFloatAdjusted?: boolean;
  sic: string | null;
  sicInfo: SicCode | null;
}

export function lookupFiler(cik: number): FilerInfo | null {
  const u = memo || store.getDoc<Universe>('universe.json')?.value;
  if (!u) return null;
  if (!memo) memo = u;
  const c = u.companies.find((x) => x.cik === cik);
  if (!c) return null;
  return { afs: c.afs, filerStatus: FILER_STATUS[c.afs as FilerStatusCode] || null, wksi: c.wksi, publicFloat: c.float, publicFloatDate: c.floatDate, publicFloatAdjusted: c.floatAdjusted, sic: c.sic, sicInfo: sicInfo(c.sic) };
}

export function universeStale(): boolean {
  const saved = savedUniverse();
  return !saved || saved.ageMs > UNIVERSE_TTL;
}
