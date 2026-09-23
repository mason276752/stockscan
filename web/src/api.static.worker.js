// The pure-frontend data layer, in a Web Worker: the same methods as
// api.http.js, answered from static files (the saved filings and the indexes
// `npm run build:static` writes) with the server's own computation modules
// running in the browser. Nothing here talks to SEC, TradingView or a
// broker, so what needs live data (prices, valuation, own-computed basket
// charts, fetching a filing that is not saved) is unavailable and says so.
//
// It runs off the main thread so fetching, inflating and parsing the indexes
// (the screener's 11 MB of columns, the 12 MB company list), decoding a
// company's filings for its indicators and computing a basket index never
// stall the page; api.static.js on the page is the proxy that forwards each
// call here (see the message loop at the end) and only the answers cross.
import { applyZh } from '../../server/lib/zh.js';
import { reclassify } from '../../server/lib/statementTypes.js';
import { fatten } from '../../server/lib/storeFormat.js';
import { currentView } from '../../server/lib/current.js';
import { buildQuarterly } from '../../server/lib/quarters.js';
import { buildIndicators } from '../../server/lib/indicators.js';
import { filingFile, filingUrls, pickFiling, scoreFile } from '../../server/lib/filings.js';
import { ITEMS, SCORE_VERSION, scoreFilingOf } from '../../server/lib/scoreModel.js';
import { SCREEN_FIELDS, asOfDate, asOfShardYears, browseCompanies, screenAsOfIndex, screenAsOfTable, screenQuery, screenTable, searchRows, wantsHistory } from '../../server/lib/screen.js';
import { FILER_STATUS, SIC, sicInfo } from '../../server/lib/sic.js';
import { adjusted, decodeBars } from '../../server/lib/barFormat.js';
import { basketRequest, runBasket } from '../../server/lib/basket.js';
import { RULE_MAX_MEMBERS, replaySchedule, ruleRequest, runRuleEtf } from '../../server/lib/ruleEtf.js';
import { buildValuation } from '../../server/lib/valuation.js';
import * as data from './staticData';
import { translate } from './locales/translate.js';

// the page's UI language, sent with every request (no DOM / localStorage here)
let locale = 'zh';
const t = (key, params) => translate(locale, key, params);

const unavailable = (what) => Promise.reject(new Error(t('static.unavailable', { what: t(what) })));

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
  if (!c) throw new Error(t('static.noCompany', { cik }));
  if (!c.filings[0]?.viewerUrl) {
    // the store paths the index left out because they follow the naming
    const m = await data.meta();
    for (const f of c.filings) {
      Object.assign(f, { cik, isInlineXBRL: true }, f.primaryDocument ? filingUrls(cik, f.accession, f.primaryDocument) : {});
      f.file ??= filingFile(cik, f, m.scrapeVersion);
      if (f.scoreFile === true) f.scoreFile = scoreFile(cik, f, m.scoreVersion);
      else f.scoreFile ??= null;
    }
  }
  return c;
}

// a saved filing, as the server hands it out. One this build did not carry
// (f.off) comes from the data ref instead - same file, one hop further.
async function loadFiling(f) {
  if (!f?.file) throw new Error(t('static.notSaved', { what: f?.accession || t('static.thisFiling') }));
  const where = data.storeUrl(await data.meta(), f.file, f.off);
  if (!where) throw new Error(t('static.offSite', { what: `${f.fiscalYear || ''} ${f.fiscalPeriod || ''}`.trim() || f.accession }));
  const [rec, docs] = await Promise.all([data.readZst('filings', where), data.documentation()]);
  return applyZh(reclassify(fatten(rec.data, docs)));
}

// the screener's columns as the table screenQuery reads: without the prev /
// yoy columns (index/screen.json alone, enough for most queries) or with
// them (screen-history.json spread in); each built once
const screenTables = {};
const screenRows = (history) => (screenTables[history ? 'full' : 'core'] ??= (history ? Promise.all([data.screenIndex(), data.screenHistoryIndex()]) : Promise.all([data.screenIndex()])).then(([core, hist]) => screenTable(hist ? { ...core, prev: hist.prev, yoy: hist.yoy } : core)));
// as of a date: the scored filings of the years that date can reach (one
// index/screen-asof-<year>.json each, megabytes apiece - only fetched once a
// date is set), grouped by company once per set of years, then each date
// picks the filing every company had out by then. They carry their own prev
// / yoy, so the history file is not needed as well.
let asOfGroups = null; // { key: the loaded years, ready: Promise<{ core, index }> }
let asOfLast = null; // the table of the date last asked for (a filter change keeps the date)
const screenAsOfRows = async (asof) => {
  const published = await data.screenAsOfYears();
  const years = asOfShardYears(asof, published);
  if (!years.length) throw new Error(t('static.asofRange', { from: `${published.at(-1) ?? '—'}-01-01` }));
  const key = years.join(',');
  if (asOfGroups?.key !== key) {
    const ready = Promise.all([screenRows(false), ...years.map((y) => data.screenAsOfShard(y))]).then(([core, ...shards]) => ({ core, index: screenAsOfIndex(shards) }));
    ready.catch(() => {
      if (asOfGroups?.key === key) asOfGroups = null; // a failed download can be retried
    });
    asOfGroups = { key, ready };
    asOfLast = null;
  }
  const { core, index } = await asOfGroups.ready;
  if (asOfLast?.asof !== asof) asOfLast = { asof, table: screenAsOfTable(core, index, asof) };
  return asOfLast.table;
};

// A rule ETF replays the filters at every filing date, so it needs every
// as-of year at once - not the three a single date reaches. That is the
// whole published index (a few MB, cached like the rest), loaded once.
let ruleGroups = null;
const ruleIndex = () =>
  (ruleGroups ??= Promise.all([data.screenAsOfYears(), screenRows(false)])
    .then(async ([years, core]) => {
      if (!years.length) throw new Error(t('static.ruleNoIndex'));
      return { core, index: screenAsOfIndex(await Promise.all(years.map((y) => data.screenAsOfShard(y)))), years };
    })
    .catch((err) => {
      ruleGroups = null; // a failed download can be retried
      throw err;
    }));

const api = {
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
  async quarters(id, year) {
    const c = await companyOf(id);
    return buildQuarterly(loadFiling, c, Number(year));
  },
  async indicators(id, params) {
    const c = await companyOf(id);
    const year = Number(params.year);
    const period = String(params.period || 'FY').toUpperCase();
    const mode = ['year', 'same'].includes(params.mode) ? params.mode : 'quarter';
    const n = Math.min(mode === 'quarter' ? 40 : 10, Math.max(1, Number(params.n) || (mode === 'quarter' ? 20 : 5)));
    const basis = params.basis === 'ttm' ? 'ttm' : 'x4';
    return buildIndicators(loadFiling, c, { year, period, n, basis, mode });
  },
  // the valuation page from saved filings and shipped bars: parsed cover
  // shares travel inside each filing (buildValuation indexes them itself);
  // this empty provider is only for pre-cover-share historical filings. No
  // split events or FX rates are shipped.
  async valuation(id, params) {
    const c = await companyOf(id);
    const year = Number(params.year);
    const period = String(params.period || 'FY').toUpperCase();
    if (!year || !/^(Q[1-4]|FY)$/.test(period)) throw new Error('year and period (Q1-Q4 or FY) required');
    const n = Math.min(40, Math.max(4, Number(params.n) || 20));
    const adr = Math.max(0.0001, Number(params.adr) || 1);
    return buildValuation(c, { year, period, n, adr }, {
      load: loadFiling,
      shares: async () => ({ version: 2, byAccn: {}, list: [] }),
      prices: async (ticker) => {
        const b = await api.bars(ticker);
        return { symbol: b.symbol, source: b.source, currency: b.currency, days: b.days.map((d) => ({ date: d.date, close: d.close })), splits: null, fetchedAt: b.fetchedAt, headMissing: b.headMissing };
      },
      fx: async () => null,
    });
  },
  // an index the idle prefetcher warms after start-up (api.warmup on the
  // page lists them in order; here what each key loads - it stays here)
  async warm(key) {
    if (!WARM[key]) throw new Error(`unknown warmup ${key}`);
    await WARM[key]();
  },
  async status() {
    const m = await data.meta();
    return { static: true, meta: m, store: { filings: m.filings, scores: m.scores }, crawler: { enabled: false } };
  },
  async screenFields() {
    const [m, years] = await Promise.all([data.meta(), data.screenAsOfYears()]);
    // the screener's date can go back as far as the oldest as-of file
    return { fields: SCREEN_FIELDS, divisions: SIC.divisions, filer: FILER_STATUS, market: m.market, asof: { min: years.length ? `${years.at(-1)}-01-01` : null } };
  },
  async screen(params) {
    const asof = asOfDate(params.asof);
    const [rows, m] = await Promise.all([asof ? screenAsOfRows(asof) : screenRows(wantsHistory(params)), data.meta()]);
    return { ...screenQuery(rows, params), scored: rows.length, asof, market: m.market };
  },
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
    const where = f.scoreFile && data.storeUrl(await data.meta(), f.scoreFile, f.off);
    if (where) return (await data.readZst('scores', where)).score;
    const s = await scoreFilingOf(loadFiling, c, f);
    if (!s) throw new Error('Cannot score this filing');
    return s;
  },
  // browse pages (the counts come precomputed; the company lists from the universe)
  async browseSic() {
    const b = await data.browse();
    return { updatedAt: b.updatedAt, datasets: b.datasets, ...b.sic };
  },
  async browseFiler() {
    const b = await data.browse();
    return { updatedAt: b.updatedAt, datasets: b.datasets, categories: b.filer };
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
    const tk = String(ticker).toUpperCase();
    if (!e.holdings.includes(tk)) throw new Error(t('static.onlyEtfs', { list: e.popular.join(t('sep')) }));
    return data.etfHoldings(tk);
  },
  async etfLive(ticker) {
    // the N-PORT snapshot of the build stands in for the issuer's daily file
    const h = await api.etfHoldings(ticker);
    return {
      etf: h.etf,
      source: `N-PORT (${h.filing?.reportDate || '—'})`,
      asOf: h.filing?.reportDate || null,
      holdings: h.holdings.filter((x) => x.symbol && x.pctVal > 0 && x.assetCat === 'EC').map((x) => ({ symbol: x.symbol, name: x.name, weight: x.pctVal, shares: x.balance ?? null, cik: x.cik })),
      nport: true,
      note: 'static build: the N-PORT holdings of the build stand in for the issuer daily file',
      fallbackErrors: [],
      fetchedAt: null,
    };
  },
  // custom ETF charts: the bars the build shipped (data/bars, TradingView's
  // to the build's day), else only TradingView's own widget
  async quotesStatus() {
    const m = await data.meta();
    return { static: true, bars: m.bars || null, builtAt: m.builtAt, tv: { enabled: false, connected: false }, ib: { enabled: false, connected: false }, source: 'TradingView', tvLibrary: false };
  },
  async tvSymbol(ticker) {
    const t = String(ticker).toUpperCase().replace(/\./g, '-');
    const m = (await data.tvSymbols())[t];
    return m ? { ticker: t, ...m, known: true } : { ticker: t, symbol: t.replace(/-/g, '.'), exchange: null, known: false };
  },
  ibConnect: () => unavailable('static.whatTws'),
  // ten years of daily bars from the files the build shipped: the finished
  // years (immutable, cached for good) plus this year's head, split
  // adjustments applied - the same series the server hands out
  async bars(symbol) {
    const m = await data.meta();
    if (!m.bars) return unavailable('static.whatBars');
    const s = String(symbol).toUpperCase().replace(/[^A-Z0-9.\-=^]/gi, '_');
    const dir = `/data/bars/tv2/${s}`;
    let meta;
    try {
      meta = await data.readBarsMeta(`${dir}/meta.json`);
    } catch (err) {
      throw new Error(err.status === 404 ? t('static.noBars', { s }) : err.message);
    }
    const [years, head] = await Promise.all([
      Promise.all((meta.years || []).map((y) => data.readBarsZst(`${dir}/${y}.zst`, { immutable: true }))),
      data.readBarsZst(`${dir}/head.zst`).catch(() => null),
    ]);
    const raw = years.flatMap(decodeBars).concat(head ? decodeBars(head) : []);
    if (!raw.length) throw new Error(t('static.noBars', { s }));
    // headMissing: the build shipped no head.zst for it - the series stops at last year's end
    return { symbol: s, source: meta.source || 'TradingView', currency: meta.currency || 'USD', resolved: meta.resolved || null, fetchedAt: head?.fetchedAt || null, headMissing: !head, days: adjusted(raw, meta.adjust || []) };
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
  // a rule ETF: the same replay the server does, over the as-of index files
  // the build shipped (ruleEtf.js). The bars are the ones beside them, so
  // the whole thing runs here - with no server there is no other way.
  async ruleEtf(body) {
    return this.ruleEtfStream(body, null);
  },
  async ruleEtfStream(body, onEvent, signal) {
    const req = ruleRequest(body);
    const { core, index, years } = await ruleIndex();
    const schedule = replaySchedule(core, index, req.params);
    if (schedule.members.length > RULE_MAX_MEMBERS) throw new Error(t('rule.tooMany', { n: schedule.members.length, max: RULE_MAX_MEMBERS }));
    onEvent?.({ type: 'schedule', members: schedule.members.length, events: schedule.events.length, skipped: schedule.skipped, tested: schedule.tested, first: schedule.first, last: schedule.last });
    const m = await data.meta();
    const r = await runRuleEtf(schedule, req, (t) => api.bars(t), { emit: onEvent, signal, extra: { static: true, ib: false, tv: false, asOf: m.builtAt, from: `${years.at(-1)}-01-01` } });
    if (r) onEvent?.({ type: 'series', ...r });
    return r;
  },
};

const WARM = {
  'idx:tickers': data.tickers,
  'idx:scores': data.scoresMin,
  'idx:companies': data.companies,
  'idx:documentation': data.documentation,
  'idx:tvsymbols': data.tvSymbols,
  'idx:browse': data.browse,
  'idx:universe': data.universe,
  'idx:etfs': data.etfs,
  'idx:screen': () => screenRows(false),
  'idx:screen-history': () => screenRows(true),
};

// download progress -> the page (busy.js), at most every 150 ms per file
const reported = new Map(); // path -> time of the last report
data.setProgress((path, loaded, total, done) => {
  const now = Date.now();
  if (!done && loaded > 0 && now - (reported.get(path) || 0) < 150) return;
  if (done) reported.delete(path);
  else reported.set(path, now);
  self.postMessage({ progress: { path, loaded, total, done } });
});

// ---- the message loop ----
// page -> worker  { id, method, args, locale }   call api[method](...args)
//                 { id, abort: true }            cancel that call (a streaming one)
// worker -> page  { id, result } | { id, error: { message, status } }
//                 { id, event }                  a streamed event (the method's onEvent)
// A streaming method (STREAMED) is called with its onEvent / signal made
// here: the page sends only the body, and the events go back as they happen.
const STREAMED = new Set(['basketStream', 'ruleEtfStream']);
const inflight = new Map(); // id -> AbortController
self.onmessage = async ({ data: msg }) => {
  if (msg.abort) return inflight.get(msg.id)?.abort();
  const { id, method, args } = msg;
  locale = msg.locale || locale;
  const ctrl = new AbortController();
  inflight.set(id, ctrl);
  try {
    const fn = api[method];
    if (typeof fn !== 'function') throw new Error(`unknown method ${method}`);
    const emit = (event) => self.postMessage({ id, event });
    const result = await (STREAMED.has(method) ? fn.call(api, args[0], emit, ctrl.signal) : fn.apply(api, args));
    self.postMessage({ id, result: result === undefined ? null : result });
  } catch (err) {
    self.postMessage({ id, error: { message: err?.message || String(err), status: err?.status ?? null } });
  } finally {
    inflight.delete(id);
  }
};
