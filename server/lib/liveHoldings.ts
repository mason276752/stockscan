// ETF constituents fresher than the quarterly N-PORT, for the custom-ETF
// "copy" and "resync": the issuer's daily holdings file where one can be
// fetched without a browser (State Street publishes an xlsx per SPDR fund),
// the index's constituent list from Nasdaq for Nasdaq-100 trackers (weights
// approximated by market cap - QQQ is modified cap-weighted), and, for funds
// that track the same index, the SPDR fund's file as a stand-in. Everything
// else falls back to N-PORT. iShares and Invesco gate their files behind an
// attestation page, so they are not sources here.

import { store } from './store.ts';
import { unzipBuffer } from './remoteZip.ts';
import { tickerTable } from './edgar.ts';
import { etfHoldings, findEtf } from './etf.ts';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const TTL = 6 * 3600 * 1000;

// funds tracking an index another source covers daily
const PROXY = {
  IVV: { via: 'SPY', note: 'IVV 與 SPY 同追蹤 S&P 500，成分取自 SPDR 的每日持股' },
  VOO: { via: 'SPY', note: 'VOO 與 SPY 同追蹤 S&P 500，成分取自 SPDR 的每日持股' },
  SPLG: { via: 'SPY', note: 'SPLG 與 SPY 同追蹤 S&P 500，成分取自 SPDR 的每日持股' },
  QQQM: { via: 'QQQ', note: 'QQQM 與 QQQ 同追蹤 Nasdaq-100' },
};
const NASDAQ_INDEX = { QQQ: 'nasdaq100' };

async function fetchBuf(url, accept = '*/*') {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept }, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} returned ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// State Street: https://www.ssga.com/.../holdings-daily-us-en-<ticker>.xlsx
async function ssga(ticker) {
  const t = ticker.toLowerCase();
  const buf = await fetchBuf(`https://www.ssga.com/us/en/intermediary/library-content/products/fund-data/etfs/us/holdings-daily-us-en-${t}.xlsx`);
  if (buf.subarray(0, 2).toString() !== 'PK') throw new Error('not an xlsx');
  const files = await unzipBuffer(buf, ['xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml']);
  const unesc = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  const sst = [...(files['xl/sharedStrings.xml']?.toString() || '').matchAll(/<si>(.*?)<\/si>/gs)].map((m) => unesc([...m[1].matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((x) => x[1]).join('')));
  const rows = [];
  for (const r of files['xl/worksheets/sheet1.xml'].toString().matchAll(/<row [^>]*>(.*?)<\/row>/gs)) {
    const cells = {};
    for (const c of r[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>(.*?)<\/c>)/gs)) {
      const [, col, attrs, inner] = c;
      let v = inner ? (/<v>(.*?)<\/v>/s.exec(inner)?.[1] ?? /<t[^>]*>(.*?)<\/t>/s.exec(inner)?.[1] ?? null) : null;
      if (v != null && /t="s"/.test(attrs)) v = sst[Number(v)];
      else if (v != null && /t="inlineStr"/.test(attrs)) v = unesc(v);
      cells[col] = v;
    }
    rows.push(cells);
  }
  const asOfRow = rows.find((r) => /^Holdings:/i.test(r.A || ''));
  const asOf = asOfRow ? isoDate(String(asOfRow.B || '').replace(/^As of\s*/i, '')) : null;
  const head = rows.findIndex((r) => r.A === 'Name' && r.B === 'Ticker');
  if (head < 0) throw new Error('holdings table not found');
  const cols = Object.fromEntries(Object.entries(rows[head]).map(([k, v]) => [String(v).toLowerCase(), k]));
  const holdings = [];
  for (const r of rows.slice(head + 1)) {
    const symbol = String(r[cols.ticker] || '').trim();
    const weight = Number(r[cols.weight]);
    if (!symbol || symbol === '-' || !(weight > 0)) continue;
    if (/^(CASH|USD|-)/i.test(symbol) || /cash|money market|futures?\b/i.test(String(r[cols.name] || ''))) continue;
    holdings.push({ symbol: symbol.replace(/\./g, '-').toUpperCase(), name: String(r[cols.name] || '').trim(), weight, shares: Number(r[cols['shares held']]) || null });
  }
  return { source: 'SSGA 每日持股（State Street）', asOf, holdings, url: `https://www.ssga.com/us/en/intermediary/etfs/funds/spdr-${t}` };
}

// Nasdaq's constituent list of an index: symbols with market caps; weight ≈ cap share
async function nasdaqIndex(list) {
  const res = await fetch(`https://api.nasdaq.com/api/quote/list-type/${list}`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`api.nasdaq.com returned ${res.status}`);
  const j = await res.json();
  const rows = j?.data?.data?.rows || [];
  const caps = rows.map((r) => ({ symbol: String(r.symbol).trim().replace(/\./g, '-').toUpperCase(), name: String(r.companyName || '').replace(/ Common Stock| Class [A-C] .*$/i, '').trim(), cap: Number(String(r.marketCap || '').replace(/[^0-9.]/g, '')) || 0 }));
  const tot = caps.reduce((s, c) => s + c.cap, 0);
  const holdings = caps.filter((c) => c.cap > 0).map((c) => ({ symbol: c.symbol, name: c.name, weight: (c.cap / tot) * 100, shares: null }));
  return { source: 'Nasdaq 指數成分（權重以市值近似）', asOf: isoDate(j?.data?.date) || new Date().toISOString().slice(0, 10), holdings, approximate: true, url: 'https://www.nasdaq.com/market-activity/quotes/nasdaq-ndx-index' };
}

// "14-Sep-2026", "Sep 15, 2026": a calendar date, not an instant - keep the day as written
function isoDate(s) {
  if (!s) return null;
  const m = /(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(s);
  const d = new Date(`${m ? `${m[2]} ${m[1]}, ${m[3]}` : s} UTC`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// Freshest constituents of an ETF, with the source they came from:
// { etf, source, asOf, approximate, note, holdings: [{ symbol, name, weight, cik }] }
export async function liveHoldings(client, ticker) {
  const T = String(ticker).toUpperCase();
  const key = `live-holdings:${T}`;
  const saved = store.getKV(key);
  if (saved && saved.ageMs < TTL) return saved.value;
  const etf = await findEtf(client, T).catch(() => ({ ticker: T, name: T }));
  const proxy = PROXY[T];
  const src = proxy ? proxy.via : T;
  let out = null;
  const tried = [];
  for (const attempt of [() => (NASDAQ_INDEX[src] ? nasdaqIndex(NASDAQ_INDEX[src]) : null), () => ssga(src)]) {
    try {
      const r = await attempt();
      if (r?.holdings?.length) {
        out = r;
        break;
      }
    } catch (err) {
      tried.push(err.message);
    }
  }
  if (!out) {
    // quarterly N-PORT: what the fund itself filed
    const np = await etfHoldings(client, T);
    out = {
      source: `N-PORT（${np.filing.reportDate} 持股，${np.filing.filingDate} 申報）`,
      asOf: np.filing.reportDate,
      holdings: np.holdings.filter((h) => h.symbol && h.pctVal > 0 && h.assetCat === 'EC').map((h) => ({ symbol: h.symbol, name: h.name, weight: h.pctVal, shares: h.balance ?? null, cik: h.cik })),
      nport: true,
      url: np.filing.viewerUrl,
    };
  }
  // EDGAR company behind each symbol (for the score column and the report page)
  const byTicker = new Map((await tickerTable(client)).map((r) => [r.ticker, r]));
  for (const h of out.holdings) {
    const row = byTicker.get(h.symbol);
    if (row) {
      h.cik = row.cik;
      if (!h.name) h.name = row.name;
    } else h.cik ??= null;
  }
  const value = { etf: { ticker: T, name: etf.name || T }, ...out, note: proxy?.note || null, fallbackErrors: tried, fetchedAt: new Date().toISOString() };
  store.putKV(key, value);
  return value;
}
