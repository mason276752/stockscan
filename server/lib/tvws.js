// TradingView's chart websocket (the one tradingview.com's own chart uses):
// daily bars for a symbol - or a spread such as 0.5*AAPL+0.5*MSFT - from
// TradingView's data (US stocks: Cboe One, split-adjusted). Unofficial and
// undocumented, so it is the first choice with IBKR and Yahoo behind it; the
// whole thing can be turned off with TV_ENABLED=0.
//
// Protocol: frames are "~m~<len>~m~<json>", the server pings "~h~<n>" which
// must be echoed. One connection carries many chart sessions; a free
// (unauthorized) session holds one series, so each request gets its own
// session: chart_create_session -> resolve_symbol -> create_series, bars
// arrive in timescale_update, series_completed ends it.

const URL = 'wss://data.tradingview.com/socket.io/websocket?from=chart%2F&type=chart';
const HEADERS = { Origin: 'https://www.tradingview.com', 'User-Agent': 'Mozilla/5.0' };
const BARS = 2600; // ~10 years of daily bars
const TIMEOUT = 25_000;
const MAX_INFLIGHT = 8;

export const TV = { enabled: !/^(0|false|no|off)$/i.test(process.env.TV_ENABLED || '1') };

let ws = null;
let opening = null;
let seq = 0;
let requests = 0;
let lastError = null;
let connectedAt = null;
const sessions = new Map(); // session id -> { resolve, reject, bars: Map<i, bar>, timer, symbol }
const waiting = []; // requests queued while MAX_INFLIGHT sessions are open

const enc = (m) => `~m~${Buffer.byteLength(m)}~m~${m}`;
const send = (m, p) => ws.send(enc(JSON.stringify({ m, p })));

export const tvConnected = () => ws?.readyState === 1;
export function tvStatus() {
  return { enabled: TV.enabled, connected: tvConnected(), connectedAt, requests, lastError };
}

function connect() {
  if (tvConnected()) return Promise.resolve();
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    const sock = new WebSocket(URL, { headers: HEADERS });
    const t = setTimeout(() => {
      sock.close();
      reject(new Error('TradingView websocket: connect timeout'));
    }, 10_000).unref();
    sock.onopen = () => {
      clearTimeout(t);
      ws = sock;
      connectedAt = new Date().toISOString();
      lastError = null;
      send('set_auth_token', ['unauthorized_user_token']);
      resolve();
    };
    sock.onerror = (e) => {
      lastError = e?.message || 'websocket error';
    };
    sock.onclose = (e) => {
      clearTimeout(t);
      if (ws === sock) ws = null;
      // whoever was waiting on this socket is told; they fall back to IBKR / Yahoo
      for (const [id, s] of sessions) {
        clearTimeout(s.timer);
        s.reject(new Error(`TradingView websocket closed (${e.code})`));
        sessions.delete(id);
      }
      reject(new Error(`TradingView websocket closed (${e.code})${lastError ? `: ${lastError}` : ''}`));
    };
    sock.onmessage = (ev) => onMessage(sock, String(ev.data));
  }).finally(() => {
    opening = null;
  });
  return opening;
}

function onMessage(sock, raw) {
  for (const part of raw.split(/~m~\d+~m~/)) {
    if (!part) continue;
    if (/^~h~\d+$/.test(part)) {
      sock.send(enc(part));
      continue;
    }
    let j;
    try {
      j = JSON.parse(part);
    } catch {
      continue;
    }
    if (!j.m || !Array.isArray(j.p)) continue;
    const s = sessions.get(j.p[0]);
    if (!s) continue;
    if (j.m === 'timescale_update' || j.m === 'du') {
      const upd = j.p[1] || {};
      for (const v of Object.values(upd)) for (const b of v?.s || []) s.bars.set(b.i, b.v);
    } else if (j.m === 'symbol_resolved') {
      s.info = j.p[2] || null;
    } else if (j.m === 'series_completed') {
      finish(j.p[0]);
    } else if (j.m === 'symbol_error' || j.m === 'series_error' || j.m === 'critical_error' || j.m === 'protocol_error') {
      const msg = j.m === 'symbol_error' ? `unknown symbol ${s.symbol}` : `${j.m}: ${j.p.slice(1).filter((x) => typeof x === 'string').join(' ')}`;
      fail(j.p[0], Object.assign(new Error(`TradingView: ${msg}`), { status: j.m === 'symbol_error' || /resolve error/.test(msg) ? 404 : 502 }));
    }
  }
}

function close(id) {
  const s = sessions.get(id);
  if (!s) return;
  clearTimeout(s.timer);
  sessions.delete(id);
  if (tvConnected()) {
    try {
      send('chart_delete_session', [id]);
    } catch {
      /* socket already gone */
    }
  }
  const next = waiting.shift();
  if (next) next();
}
function finish(id) {
  const s = sessions.get(id);
  if (!s) return;
  const days = [...s.bars.values()]
    .filter((v) => Array.isArray(v) && typeof v[4] === 'number' && v[4] > 0)
    .map((v) => ({ date: new Date(v[0] * 1000).toISOString().slice(0, 10), open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] ?? null }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const info = s.info || {};
  s.resolve({ days, resolved: info.pro_name || info.full_name || null, exchange: info.exchange || null, description: info.description || null, currency: info.currency_code || null });
  close(id);
}
function fail(id, err) {
  const s = sessions.get(id);
  if (!s) return;
  s.reject(err);
  close(id);
}

// TradingView spells share classes with a dot (BRK.B); EDGAR uses a dash.
export const tvSymbol = (ticker) => String(ticker).toUpperCase().replace(/-/g, '.');

// A bare ticker may resolve to another country's listing (COCO -> IDX:COCO,
// Indonesia, instead of NASDAQ:COCO): EDGAR tickers are US listings, so a
// non-US answer is retried with the US exchanges.
const US_EXCHANGES = ['NASDAQ', 'NYSE', 'AMEX', 'OTC', 'CBOE', 'BATS', 'ARCA'];
const isUS = (r) => !r.resolved || US_EXCHANGES.includes(String(r.resolved).split(':')[0]);
const isSpread = (symbol) => /[*+\/-]/.test(String(symbol).replace(/-/g, ''));

export async function tvDailyBars(symbol, opts = {}) {
  const r = await tvRequest(symbol, opts);
  if (isSpread(symbol) || isUS(r)) return r;
  let lastErr = null;
  for (const ex of US_EXCHANGES.slice(0, 4)) {
    try {
      return await tvRequest(`${ex}:${tvSymbol(symbol)}`, opts);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || Object.assign(new Error(`TradingView: ${symbol} only found as ${r.resolved}`), { status: 404 });
}

// Daily bars of a symbol or spread, oldest first:
// { days: [{ date, open, high, low, close, volume }], resolved, exchange, description, currency }
async function tvRequest(symbol, { bars = BARS } = {}) {
  if (!TV.enabled) throw Object.assign(new Error('TradingView source disabled'), { status: 503 });
  await connect();
  if (sessions.size >= MAX_INFLIGHT) await new Promise((r) => waiting.push(r));
  if (!tvConnected()) await connect();
  requests++;
  const id = `cs_${(++seq).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(id, Object.assign(new Error(`TradingView: no answer for ${symbol} within ${TIMEOUT / 1000}s`), { status: 504 })), TIMEOUT);
    sessions.set(id, { resolve, reject, bars: new Map(), timer, symbol, info: null });
    try {
      send('chart_create_session', [id, '']);
      send('resolve_symbol', [id, 'sym', `=${JSON.stringify({ symbol: tvSymbol(symbol), adjustment: 'splits', session: 'regular' })}`]);
      send('create_series', [id, 's1', 's1', 'sym', '1D', bars, '']);
    } catch (err) {
      fail(id, err);
    }
  });
}

export function tvDisconnect() {
  if (ws) ws.close();
}
