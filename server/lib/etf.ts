// ETFs and their constituents, entirely from SEC data:
//   * which ETFs exist: the Investment Company Series and Class dataset
//     (every registered fund series/class with its ticker; ETF tickers are the
//     short ones - mutual fund classes are five letters ending in X), plus the
//     handful of unit-investment-trust ETFs that have no series (SPY, DIA…)
//   * holdings: the fund's latest Form N-PORT (monthly portfolio, filed
//     quarterly with a 60-day lag), looked up by series id on EDGAR
//   * mapping a holding to a company: N-PORT identifies securities by CUSIP;
//     the fails-to-deliver files give CUSIP -> ticker, the ticker table gives
//     ticker -> CIK, and the issuer name is the fallback

import { loadXml } from './ixbrl.ts';
import { store } from './store.ts';
import { tickerTable } from './edgar.ts';
import { unzipBuffer } from './remoteZip.ts';
import type { Fetcher, Priority } from './secClient.ts';
import type { IsoDate } from './types.ts';
import type { TickerRow } from './edgar.ts';

/** One ETF of the series/class dataset (or a unit investment trust). */
export interface Etf {
  ticker: string;
  name: string;
  className: string;
  entity: string;
  cik: number;
  /** null for a unit investment trust, which files under its own CIK */
  seriesId: string | null;
}

/** The ETF list, with the day it was built. */
export interface EtfList {
  updatedAt: string;
  etfs: Etf[];
}

/** CUSIP -> ticker, from the fails-to-deliver files. */
export interface CusipMap {
  updatedAt: string;
  files: string[];
  map: Record<string, string>;
}

/** One N-PORT filing of a fund. */
export interface NportFiling {
  cik: number;
  accession: string;
  nodash: string;
  form: string;
  filingDate: IsoDate;
  indexUrl: string;
}

/** One line of a fund's portfolio. */
export interface NportHolding {
  name: string;
  title: string;
  cusip: string | null;
  isin: string | null;
  ticker: string | null;
  lei: string | null;
  balance: number | null;
  units: string | null;
  valUSD: number | null;
  pctVal: number | null;
  assetCat: string | null;
  issuerCat: string | null;
  country: string | null;
}

/** A parsed N-PORT document. */
export interface NportDocument {
  seriesName: string;
  seriesId: string;
  reportDate: IsoDate | null;
  totAssets: number | null;
  netAssets: number | null;
  holdings: NportHolding[];
}

/** A holding matched against EDGAR's companies. */
export interface MappedHolding extends NportHolding {
  symbol: string | null;
  cik: number | null;
  /** how it was matched: by ticker, by CUSIP, or by issuer name */
  via: 'ticker' | 'cusip' | 'name' | null;
  assetZh: string | null;
}

/** The indexes that turn a holding into a company. */
interface Resolver {
  source: TickerRow[];
  bySymbol: Map<string, number>;
  byName: Map<string, number | null>;
  nameOf: Map<number, { name: string; ticker: string }>;
}

const SERIES_CSV = (year: number) => `https://www.sec.gov/files/investment/data/other/investment-company-series-class-information/investment-company-series-class-${year}.csv`;
const FAILS = (yyyymm: string, half: string) => `https://www.sec.gov/files/data/fails-deliver-data/cnsfails${yyyymm}${half}.zip`;
const BROWSE = 'https://www.sec.gov/cgi-bin/browse-edgar';
const ARCHIVES = 'https://www.sec.gov/Archives/edgar/data';

const LIST_TTL = 7 * 24 * 3600 * 1000;
const NPORT_LIST_TTL = 24 * 3600 * 1000;
const FAILS_FILES = 6; // half-month files to merge (≈ 3 months: nearly every listed stock fails at least once)

// ETFs organised as unit investment trusts: no series id, N-PORT is filed under the trust's own CIK.
const UIT_ETFS: Omit<Etf, 'className' | 'seriesId'>[] = [
  { ticker: 'SPY', name: 'SPDR S&P 500 ETF Trust', entity: 'SPDR S&P 500 ETF TRUST', cik: 884394 },
  { ticker: 'DIA', name: 'SPDR Dow Jones Industrial Average ETF Trust', entity: 'SPDR DOW JONES INDUSTRIAL AVERAGE ETF TRUST', cik: 1041130 },
  { ticker: 'MDY', name: 'SPDR S&P MidCap 400 ETF Trust', entity: 'SPDR S&P MIDCAP 400 ETF TRUST', cik: 936958 },
];

// Well-known tickers shown first on the ETF page.
export const POPULAR_ETFS = [
  'SPY', 'VOO', 'IVV', 'VTI', 'QQQ', 'DIA', 'IWM', 'VUG', 'VTV', 'VIG', 'SCHD', 'VYM', 'RSP', 'MDY',
  'XLK', 'XLF', 'XLV', 'XLE', 'XLY', 'XLP', 'XLI', 'XLU', 'XLB', 'XLRE', 'XLC',
  'SMH', 'SOXX', 'VGT', 'IBB', 'XBI', 'ARKK', 'VNQ', 'ITA', 'KBE', 'XOP', 'IYT', 'IGV', 'BOTZ', 'JEPI', 'QQQM',
];

// ---------- ETF list ----------

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

async function buildEtfList(client: Fetcher, priority: Priority | undefined): Promise<EtfList> {
  const year = new Date().getUTCFullYear();
  let text: string | undefined;
  for (const y of [year, year - 1]) {
    try {
      text = await client.text(SERIES_CSV(y), { priority });
      break;
    } catch (err) {
      if ((err as { status?: number }).status !== 404) throw err;
    }
  }
  if (!text) throw new Error('Investment company series/class dataset not found on SEC');
  const rows = parseCsv(text.replace(/^\uFEFF/, ''));
  const header = rows[0]!;
  const col = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  const iCik = col('CIK Number');
  const iEntity = col('Entity Name');
  const iOrg = col('Entity Org Type');
  const iSeries = col('Series ID');
  const iSeriesName = col('Series Name');
  const iClass = col('Class Name');
  const iTicker = col('Class Ticker');
  const out: Etf[] = [];
  const seen = new Set<string>();
  for (const r of rows.slice(1)) {
    const ticker = (r[iTicker] || '').trim().toUpperCase();
    // org type 30 = registered investment company (N-1A / N-2); five-letter
    // tickers ending in X are mutual fund classes
    if (!ticker || ticker.length > 4 || r[iOrg] !== '30' || seen.has(ticker)) continue;
    seen.add(ticker);
    const clean = (v: string) => v.replace(/\((R|TM|SM)\)/g, '').replace(/\s+/g, ' ').trim();
    out.push({
      ticker,
      name: clean(r[iSeriesName]!),
      className: clean(r[iClass]!),
      entity: r[iEntity]!.trim(),
      cik: Number(r[iCik]),
      seriesId: r[iSeries]!.trim(),
    });
  }
  for (const u of UIT_ETFS) if (!seen.has(u.ticker)) out.push({ ...u, className: u.name, seriesId: null });
  out.sort((a, b) => a.ticker.localeCompare(b.ticker));
  return { updatedAt: new Date().toISOString(), etfs: out };
}

let listMemo: EtfList | null = null;
export async function etfList(client: Fetcher, { priority = 'high' }: { priority?: Priority } = {}): Promise<EtfList> {
  if (listMemo) return listMemo;
  const saved = store.getKV<EtfList>('etfs');
  if (saved) {
    listMemo = saved.value;
    if (saved.ageMs > LIST_TTL) buildEtfList(client, 'low').then(save('etfs', (v) => (listMemo = v))).catch(() => {});
    return listMemo;
  }
  listMemo = await buildEtfList(client, priority);
  store.putKV('etfs', listMemo);
  return listMemo;
}

const save = <T,>(key: string, assign: (v: T) => void) => (value: T) => {
  store.putKV(key, value);
  assign(value);
};

export async function findEtf(client: Fetcher, ticker: string): Promise<Etf> {
  const wanted = String(ticker).trim().toUpperCase();
  const { etfs } = await etfList(client);
  const hit = etfs.find((e) => e.ticker === wanted);
  if (!hit) throw Object.assign(new Error(`ETF not found on SEC: ${ticker}`), { status: 404 });
  return hit;
}

// ---------- CUSIP -> ticker (fails-to-deliver files) ----------

async function buildCusipMap(client: Fetcher, priority: Priority | undefined): Promise<CusipMap> {
  const map: Record<string, string> = {};
  const files: string[] = [];
  const now = new Date();
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth() + 1;
  let half = now.getUTCDate() > 15 ? 'b' : 'a';
  for (let tries = 0; files.length < FAILS_FILES && tries < FAILS_FILES + 8; tries++) {
    const name = `${y}${String(m).padStart(2, '0')}${half}`;
    try {
      const zip = await client.buffer(FAILS(`${y}${String(m).padStart(2, '0')}`, half), { priority });
      const entries = await unzipBuffer(zip);
      for (const buf of Object.values(entries)) {
        for (const line of buf.toString('latin1').split('\n')) {
          const f = line.split('|');
          if (f.length < 5 || !/^\d{8}$/.test(f[0]!)) continue;
          const cusip = f[1]!.trim();
          const symbol = f[2]!.trim();
          if (cusip && symbol && !map[cusip]) map[cusip] = symbol;
        }
      }
      files.push(name);
    } catch (err) {
      if ((err as { status?: number }).status !== 404) console.warn(`fails-to-deliver ${name}: ${(err as Error).message}`);
    }
    if (half === 'b') half = 'a';
    else {
      half = 'b';
      if (--m === 0) {
        m = 12;
        y--;
      }
    }
  }
  if (!files.length) throw new Error('No fails-to-deliver file could be downloaded from SEC');
  return { updatedAt: new Date().toISOString(), files, map };
}

let cusipMemo: CusipMap | null = null;
async function cusipMap(client: Fetcher, priority: Priority | undefined): Promise<CusipMap> {
  if (cusipMemo) return cusipMemo;
  const saved = store.getKV<CusipMap>('cusips');
  if (saved) {
    cusipMemo = saved.value;
    if (saved.ageMs > LIST_TTL) buildCusipMap(client, 'low').then(save('cusips', (v) => (cusipMemo = v))).catch(() => {});
    return cusipMemo;
  }
  cusipMemo = await buildCusipMap(client, priority);
  store.putKV('cusips', cusipMemo);
  return cusipMemo;
}

// ---------- ticker / name -> CIK ----------

const NOISE = new Set(
  'INC INCORPORATED CORP CORPORATION CO COMPANY LTD LIMITED PLC LLC LP HOLDINGS HOLDING HLDGS GROUP GRP THE CLASS A B C COM COMMON STOCK SHS SHARES NEW ORD ORDINARY ADR ADS SA NV AG SE SPA AND OF TRUST REIT'.split(' '),
);
function normName(s: string): string {
  return s
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !NOISE.has(w))
    .join(' ');
}

let resolverMemo: Resolver | null = null; // rebuilt when the ticker table object changes
async function resolver(client: Fetcher): Promise<Resolver> {
  const tickers = await tickerTable(client);
  if (resolverMemo?.source === tickers) return resolverMemo;
  const bySymbol = new Map<string, number>();
  const byName = new Map<string, number | null>();
  const nameOf = new Map<number, { name: string; ticker: string }>();
  for (const t of tickers) {
    bySymbol.set(t.ticker.replace(/[^A-Z0-9]/g, ''), t.cik);
    bySymbol.set(t.ticker, t.cik);
    if (!nameOf.has(t.cik)) nameOf.set(t.cik, { name: t.name, ticker: t.ticker });
    const n = normName(t.name);
    if (!n) continue;
    if (byName.has(n) && byName.get(n) !== t.cik) byName.set(n, null); // ambiguous
    else if (!byName.has(n)) byName.set(n, t.cik);
  }
  resolverMemo = { source: tickers, bySymbol, byName, nameOf };
  return resolverMemo;
}

// ---------- N-PORT ----------

function accessionFromHref(href: string) {
  const m = /\/data\/(\d+)\/(\d{18})\//.exec(href);
  if (!m) return null;
  const a = m[2]!;
  return { cik: Number(m[1]), accession: `${a.slice(0, 10)}-${a.slice(10, 12)}-${a.slice(12)}`, nodash: a };
}

// Newest N-PORT filings of a series (or a UIT's CIK) from the EDGAR browse feed.
async function nportFilings(client: Fetcher, key: string, priority: Priority | undefined): Promise<NportFiling[]> {
  const kv = `nport-list:${key}`;
  const saved = store.getKV<NportFiling[]>(kv);
  if (saved && saved.ageMs < NPORT_LIST_TTL) return saved.value;
  const url = `${BROWSE}?action=getcompany&CIK=${encodeURIComponent(key)}&type=NPORT-P&dateb=&owner=include&count=10&output=atom`;
  let text: string;
  try {
    text = await client.text(url, { priority });
  } catch (err) {
    if (saved) return saved.value;
    throw err;
  }
  const $ = loadXml(text);
  const list: NportFiling[] = [];
  $('entry').each((_, e) => {
    const type = $(e).find('filing-type').text().trim();
    if (!/^NPORT-P(\/A)?$/.test(type)) return;
    const href = $(e).find('filing-href').text().trim();
    const id = accessionFromHref(href);
    if (id) list.push({ ...id, form: type, filingDate: $(e).find('filing-date').text().trim(), indexUrl: href });
  });
  list.sort((a, b) => (a.filingDate < b.filingDate ? 1 : -1));
  store.putKV(kv, list);
  return list;
}

const num = (s: string | null | undefined) => (s === '' || s == null ? null : Number(s));
const na = (s: string | null | undefined) => (!s || /^(N\/A|0+)$/i.test(s) ? null : s);

function parseNport(text: string): NportDocument {
  const $ = loadXml(text);
  const g = (sel: string) => $(sel).first().text().trim();
  const holdings: NportHolding[] = [];
  $('invstOrSec').each((_, e) => {
    const el = $(e);
    const idents = el.children('identifiers');
    holdings.push({
      name: na(el.children('name').text().trim()) || na(el.children('title').text().trim()) || '',
      title: na(el.children('title').text().trim()) || '',
      cusip: na(el.children('cusip').text().trim()),
      isin: idents.find('isin').attr('value') || null,
      ticker: idents.find('ticker').attr('value') || null,
      lei: el.children('lei').text().trim() || null,
      balance: num(el.children('balance').text().trim()),
      units: el.children('units').text().trim() || null,
      valUSD: num(el.children('valUSD').text().trim()),
      pctVal: num(el.children('pctVal').text().trim()),
      assetCat: el.children('assetCat').text().trim() || el.children('assetCatDesc').text().trim() || null,
      issuerCat: el.children('issuerCat').text().trim() || null,
      country: el.children('invCountry').text().trim() || null,
    });
  });
  return {
    seriesName: g('seriesName'),
    seriesId: g('seriesId'),
    reportDate: g('repPdDate') || null,
    totAssets: num(g('totAssets')),
    netAssets: num(g('netAssets')),
    holdings,
  };
}

async function nportDocument(client: Fetcher, filing: NportFiling, priority: Priority | undefined): Promise<NportDocument> {
  const kv = `nport:${filing.accession}`;
  const saved = store.getKV<NportDocument>(kv);
  if (saved) return saved.value; // a filed document never changes
  const folder = `${ARCHIVES}/${filing.cik}/${filing.nodash}`;
  const idx = await client.json<{ directory: { item: { name: string }[] } }>(`${folder}/index.json`, { priority });
  const xml = idx.directory.item.find((i) => /^primary_doc\.xml$/i.test(i.name)) || idx.directory.item.find((i) => /\.xml$/i.test(i.name));
  if (!xml) throw new Error(`No N-PORT XML in ${filing.accession}`);
  const doc = parseNport(await client.text(`${folder}/${xml.name}`, { priority }));
  store.putKV(kv, doc);
  return doc;
}

const ASSET_ZH: Record<string, string> = { EC: '股票', DBT: '債券', STIV: '短期投資', RA: '附買回', DE: '衍生性商品', DCO: '衍生性商品', DIR: '利率衍生商品', DFE: '外匯衍生商品', DEQ: '股權衍生商品', ABS: '資產擔保證券', LON: '貸款', CDS: '信用違約交換', 'ABS-MBS': '不動產抵押證券', 'ABS-APCP': 'ABS 商業本票', 'ABS-CBDO': 'CBO/CDO', 'ABS-O': '其他 ABS', SN: '結構型商品', 'DE-O': '其他衍生商品', RE: '不動產', EP: '特別股', 'EC-O': '其他股權', COMM: '商品', OTHER: '其他' };

// Latest constituents of an ETF, each mapped to an EDGAR company when possible.
export async function etfHoldings(client: Fetcher, ticker: string, { priority = 'high' }: { priority?: Priority } = {}) {
  const etf = await findEtf(client, ticker);
  const filings = await nportFilings(client, etf.seriesId || String(etf.cik).padStart(10, '0'), priority);
  if (!filings.length) throw Object.assign(new Error(`${etf.ticker} has no Form N-PORT on EDGAR yet`), { status: 404 });
  const filing = filings[0]!;
  const [doc, cusips, r] = await Promise.all([nportDocument(client, filing, priority), cusipMap(client, priority), resolver(client)]);

  let mapped = 0;
  const holdings: MappedHolding[] = doc.holdings.map((h) => {
    let symbol: string | null = h.ticker ? h.ticker.toUpperCase() : (h.cusip && cusips.map[h.cusip]) || null;
    let cik: number | null = symbol ? (r.bySymbol.get(symbol.replace(/[^A-Z0-9]/g, '')) ?? null) : null;
    let via: MappedHolding['via'] = cik ? (h.ticker ? 'ticker' : 'cusip') : null;
    if (!cik) {
      const byName = r.byName.get(normName(h.name)) || r.byName.get(normName(h.title));
      if (byName) {
        cik = byName;
        via = 'name';
        symbol = symbol || r.nameOf.get(cik)?.ticker || null;
      }
    }
    if (cik) {
      mapped++;
      if (!symbol) symbol = r.nameOf.get(cik)?.ticker || null;
    }
    return { ...h, symbol, cik, via, assetZh: ASSET_ZH[h.assetCat!] || null };
  });
  holdings.sort((a, b) => (b.pctVal ?? -Infinity) - (a.pctVal ?? -Infinity));

  return {
    etf,
    filing: { ...filing, reportDate: doc.reportDate, seriesName: doc.seriesName, netAssets: doc.netAssets, totAssets: doc.totAssets, viewerUrl: filing.indexUrl },
    holdings,
    stats: { total: holdings.length, mapped, equities: holdings.filter((h) => h.assetCat === 'EC').length },
    sources: { cusipFiles: cusips.files, cusipUpdatedAt: cusips.updatedAt },
  };
}
