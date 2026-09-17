// The pure-frontend data layer: the same methods as api.http.js, answered
// from static files (the saved filings and the indexes `npm run
// build:static` writes) with the server's own computation modules running in
// the browser. Nothing here talks to SEC, TradingView or a broker, so what
// needs live data (prices, valuation, own-computed basket charts, fetching a
// filing that is not saved) is unavailable and says so.
import { applyZh } from '../../server/lib/zh.js';
import { reclassify } from '../../server/lib/statementTypes.js';
import { fatten } from '../../server/lib/storeFormat.js';
import { currentView } from '../../server/lib/current.js';
import { buildQuarterly } from '../../server/lib/quarters.js';
import { buildIndicators } from '../../server/lib/indicators.js';
import { filingUrls, pickFiling } from '../../server/lib/filings.js';
import { ITEMS, SCORE_VERSION, scoreFiling } from '../../server/lib/scoreModel.js';
import { SCREEN_FIELDS, browseCompanies, filerCounts, scoreBadge, screenQuery, searchRows, sicCounts } from '../../server/lib/screen.js';
import { FILER_STATUS, SIC, sicInfo } from '../../server/lib/sic.js';
import { adjusted, decodeBars } from '../../server/lib/barFormat.js';
import { basketRequest, runBasket } from '../../server/lib/basket.js';
import * as data from './staticData';

const unavailable = (what) => Promise.reject(new Error(`純前端版沒有${what}（需要伺服器版）`));

// ticker / CIK -> the company record of the index
async function companyOf(id) {
  const all = await data.companies();
  const s = String(id).trim();
  let cik = /^\d+$/.test(s) ? Number(s) : null;
  if (cik == null) {
    const t = s.toUpperCase().replace(/\./g, '-');
    const row = (await data.tickers()).find((r) => r.ticker === t);
    if (!row) throw new Error(`Ticker not found: ${id}`);
    cik = row.cik;
  }
  const c = all[cik];
  if (!c) throw new Error(`這家公司（CIK ${cik}）的財報不在這份靜態資料裡`);
  if (!c.filings[0]?.viewerUrl) for (const f of c.filings) Object.assign(f, { cik, isInlineXBRL: true }, f.primaryDocument ? filingUrls(cik, f.accession, f.primaryDocument) : {});
  return c;
}

// a saved filing, as the server hands it out
async function loadFiling(f) {
  if (!f?.file) throw new Error(`${f?.accession || '這份申報'} 沒有存檔`);
  const [rec, docs] = await Promise.all([data.readZst('filings', `/data/store/${f.file}`), data.documentation()]);
  return applyZh(reclassify(fatten(rec.data, docs)));
}

export const api = {
  isStatic: true,
  meta: () => data.meta(),

  async search(q) {
    const [rows, scores] = await Promise.all([data.tickers(), data.scoresMin()]);
    return searchRows(rows, q, 10).map((r) => ({ ...r, score: scores[r.cik] || null }));
  },
  async company(id) {
    const c = await companyOf(id);
    return { ...c, sicZh: sicInfo(c.sic)?.zh || null, filingsUpdatedAt: (await data.meta()).builtAt, filingsStale: false };
  },
  async filing(cik, accession, view = 'all') {
    const c = await companyOf(cik);
    const filing = c.filings.find((f) => f.accession === accession);
    if (!filing) throw new Error(`Filing ${accession} not found`);
    const d = await loadFiling(filing);
    if (view !== 'current') return d;
    let prev = null;
    const q = /^Q([2-3])$/.exec(filing.fiscalPeriod || '');
    if (q) {
      const pf = pickFiling(c.filings, { year: filing.fiscalYear, period: `Q${Number(q[1]) - 1}` });
      if (pf?.file) {
        try {
          prev = { filing: pf, data: await loadFiling(pf) };
        } catch {
          prev = null;
        }
      }
    }
    return currentView(d, filing, prev);
  },
  filingUrl: () => null,
  async quarters(id, year) {
    const c = await companyOf(id);
    return buildQuarterly(loadFiling, c, Number(year));
  },
  quartersUrl: () => null,
  async indicators(id, params) {
    const c = await companyOf(id);
    const year = Number(params.year);
    const period = String(params.period || 'FY').toUpperCase();
    const mode = ['year', 'same'].includes(params.mode) ? params.mode : 'quarter';
    const n = Math.min(mode === 'quarter' ? 40 : 10, Math.max(1, Number(params.n) || (mode === 'quarter' ? 20 : 5)));
    const basis = params.basis === 'ttm' ? 'ttm' : 'x4';
    return buildIndicators(loadFiling, c, { year, period, n, basis, mode });
  },
  indicatorsUrl: () => null,
  valuation: () => unavailable('股價估值：估值要抓每季的股價'),
  valuationUrl: () => null,
  async status() {
    const m = await data.meta();
    return { static: true, meta: m, store: { filings: m.filings, scores: m.scores }, crawler: { enabled: false } };
  },
  async screenFields() {
    const m = await data.meta();
    return { fields: SCREEN_FIELDS, divisions: SIC.divisions, filer: FILER_STATUS, market: m.market };
  },
  async screen(params) {
    const [rows, m] = await Promise.all([data.screenRowsIndex(), data.meta()]);
    return { ...screenQuery(rows, params), scored: rows.length, market: m.market };
  },
  screenUrl: () => null,
  async scores(ciks) {
    const all = await data.scoresMin();
    const out = {};
    for (const cik of ciks) out[cik] = all[cik] || null;
    return { version: SCORE_VERSION, items: ITEMS.map(({ key, name, category, benchmark, weight }) => ({ key, name, category, benchmark, weight })), scores: out };
  },
  async score(cik, accession) {
    const c = await companyOf(cik);
    const f = c.filings.find((x) => x.accession === accession);
    if (!f) throw new Error(`Filing ${accession} not found`);
    if (f.scoreFile) return (await data.readZst('scores', `/data/store/${f.scoreFile}`)).score;
    const s = scoreFiling(await loadFiling(f));
    if (!s) throw new Error('Cannot score this filing');
    return s;
  },
  // browse pages
  async browseSic() {
    const u = await data.universe();
    return { updatedAt: u.updatedAt, datasets: u.datasets, ...sicCounts(u.companies) };
  },
  async browseFiler() {
    const u = await data.universe();
    return { updatedAt: u.updatedAt, datasets: u.datasets, categories: filerCounts(u.companies) };
  },
  async browseCompanies(params) {
    const u = await data.universe();
    return { updatedAt: u.updatedAt, ...browseCompanies(u.companies, params) };
  },
  async browseEtfs(q = '') {
    const e = await data.etfs();
    const needle = String(q).trim().toUpperCase();
    const rank = new Map(e.popular.map((t, i) => [t, i]));
    let rows = e.etfs;
    if (needle) rows = rows.filter((x) => x.ticker.startsWith(needle) || x.name.toUpperCase().includes(needle) || (x.entity || '').toUpperCase().includes(needle));
    rows = [...rows].sort((a, b) => (rank.get(a.ticker) ?? 1e9) - (rank.get(b.ticker) ?? 1e9) || a.ticker.localeCompare(b.ticker));
    return { updatedAt: e.updatedAt, total: e.etfs.length, count: rows.length, popular: e.popular, etfs: rows.slice(0, 300) };
  },
  async etfHoldings(ticker) {
    const e = await data.etfs();
    const h = e.holdings[String(ticker).toUpperCase()];
    if (!h) throw new Error(`純前端版只有 build 時放進來的 ETF 成分（${e.popular.join('、')}）`);
    return h;
  },
  etfHoldingsUrl: () => null,
  async etfLive(ticker) {
    // the N-PORT snapshot of the build stands in for the issuer's daily file
    const h = await api.etfHoldings(ticker);
    return {
      etf: h.etf,
      source: `N-PORT（${h.filing?.reportDate || '—'} 持股，build 時的快照）`,
      asOf: h.filing?.reportDate || null,
      holdings: h.holdings.filter((x) => x.symbol && x.pctVal > 0 && x.assetCat === 'EC').map((x) => ({ symbol: x.symbol, name: x.name, weight: x.pctVal, shares: x.balance ?? null, cik: x.cik })),
      nport: true,
      note: '純前端版沒有發行商每日持股，用的是 build 時的季報成分',
      fallbackErrors: [],
      fetchedAt: null,
    };
  },
  // custom ETF charts: the bars the build shipped (data/bars, TradingView's
  // to the build's day), else only TradingView's own widget
  async quotesStatus() {
    const m = await data.meta();
    return { static: true, bars: m.bars || null, builtAt: m.builtAt, tv: { enabled: false, connected: false }, ib: { enabled: false, connected: false }, source: m.bars ? 'TradingView（build 時的日線）' : 'TradingView widget', tvLibrary: false };
  },
  async tvSymbol(ticker) {
    const t = String(ticker).toUpperCase().replace(/\./g, '-');
    const m = (await data.tvSymbols())[t];
    return m ? { ticker: t, ...m, known: true } : { ticker: t, symbol: t.replace(/-/g, '.'), exchange: null, known: false };
  },
  ibConnect: () => unavailable('TWS 連線'),
  // ten years of daily bars from the files the build shipped: the finished
  // years (immutable, cached for good) plus this year's head, split
  // adjustments applied - the same series the server hands out
  async bars(symbol) {
    const m = await data.meta();
    if (!m.bars) return unavailable('日線');
    const s = String(symbol).toUpperCase().replace(/[^A-Z0-9.\-=^]/gi, '_');
    const dir = `/data/bars/tv2/${s}`;
    let meta;
    try {
      meta = await data.readBarsMeta(`${dir}/meta.json`);
    } catch (err) {
      throw new Error(err.status === 404 ? `這份靜態資料裡沒有 ${s} 的日線` : err.message);
    }
    const [years, head] = await Promise.all([
      Promise.all((meta.years || []).map((y) => data.readBarsZst(`${dir}/${y}.zst`, { immutable: true }))),
      data.readBarsZst(`${dir}/head.zst`).catch(() => null),
    ]);
    const raw = years.flatMap(decodeBars).concat(head ? decodeBars(head) : []);
    if (!raw.length) throw new Error(`${s} 沒有日線資料`);
    return { symbol: s, source: meta.source || 'TradingView', currency: meta.currency || 'USD', resolved: meta.resolved || null, fetchedAt: head?.fetchedAt || null, days: adjusted(raw, meta.adjust || []) };
  },
  // the custom-ETF index, computed here from those bars
  async basket(body) {
    return this.basketStream(body, null);
  },
  async basketStream(body, onEvent, signal) {
    const req = basketRequest(body || {});
    const rows = await data.tickers();
    const byTicker = new Map(rows.map((r) => [r.ticker, r]));
    const byCik = new Map(rows.map((r) => [r.cik, r]));
    const listingOf = (ticker, cik) => {
      const t = String(ticker).toUpperCase().replace(/\./g, '-');
      if (byTicker.has(t)) return { listed: true };
      const same = cik ? byCik.get(Number(cik)) : null;
      return same ? { listed: false, renamed: same.ticker } : { listed: false };
    };
    const m = await data.meta();
    return runBasket(req, (t) => api.bars(t), { emit: onEvent, interim: body?.interim ? 1200 : 0, signal, listingOf, extra: { static: true, ib: false, tv: false, asOf: m.builtAt } });
  },
};

export { scoreBadge };
