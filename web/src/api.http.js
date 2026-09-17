import { url } from './base';

async function get(path) {
  const res = await fetch(url(path));
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

async function post(path, body) {
  const res = await fetch(url(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

export const api = {
  isStatic: false,
  search: (q) => get(`/api/search?q=${encodeURIComponent(q)}`),
  company: (id, { refresh = false } = {}) => get(`/api/company/${encodeURIComponent(id)}${refresh ? '?refresh=1' : ''}`),
  filing: (cik, accession, view = 'all') => get(`/api/filing/${cik}/${accession}${view === 'current' ? '?view=current' : ''}`),
  filingUrl: (cik, accession, view = 'all') => url(`/api/filing/${cik}/${accession}${view === 'current' ? '?view=current' : ''}`),
  quarters: (id, year) => get(`/api/company/${encodeURIComponent(id)}/quarters?year=${year}`),
  quartersUrl: (id, year) => url(`/api/company/${encodeURIComponent(id)}/quarters?year=${year}`),
  indicators: (id, params) => get(`/api/company/${encodeURIComponent(id)}/indicators?${new URLSearchParams(params)}`),
  indicatorsUrl: (id, params) => url(`/api/company/${encodeURIComponent(id)}/indicators?${new URLSearchParams(params)}`),
  valuation: (id, params) => get(`/api/company/${encodeURIComponent(id)}/valuation?${new URLSearchParams(params)}`),
  valuationUrl: (id, params) => url(`/api/company/${encodeURIComponent(id)}/valuation?${new URLSearchParams(params)}`),
  warmup: () => [], // the server holds the indexes; nothing to warm
  status: () => get('/api/status'),
  screenFields: () => get('/api/screen/fields'),
  screen: (params) => get(`/api/screen?${new URLSearchParams(params)}`),
  screenUrl: (params) => url(`/api/screen?${new URLSearchParams(params)}`),
  scores: (ciks) => get(`/api/score?ciks=${ciks.join(',')}`),
  score: (cik, accession) => get(`/api/score/${cik}/${accession}`),
  // browse pages
  browseSic: () => get('/api/browse/sic'),
  browseFiler: () => get('/api/browse/filer'),
  browseCompanies: (params) => get(`/api/browse/companies?${new URLSearchParams(params)}`),
  browseEtfs: (q = '') => get(`/api/browse/etf${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  etfHoldings: (ticker) => get(`/api/browse/etf/${encodeURIComponent(ticker)}`),
  etfHoldingsUrl: (ticker) => url(`/api/browse/etf/${encodeURIComponent(ticker)}`),
  etfLive: (ticker) => get(`/api/browse/etf/${encodeURIComponent(ticker)}/live`),
  // custom ETF charts
  quotesStatus: () => get('/api/quotes/status'),
  tvSymbol: (ticker) => get(`/api/quotes/tv-symbol/${encodeURIComponent(ticker)}`),
  ibConnect: () => post('/api/quotes/ib/connect', {}),
  bars: (symbol) => get(`/api/bars/${encodeURIComponent(symbol)}`),
  basket: (body) => post('/api/basket', body),
  basketStream: (body, onEvent, signal) => stream('/api/basket/stream', body, onEvent, signal),
};

// POST returning NDJSON: one JSON object per line, handed to onEvent as each
// line arrives (the basket index streams progress and interim results)
async function stream(path, body, onEvent, signal) {
  const res = await fetch(url(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `${res.status} ${res.statusText}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
  if (buf.trim()) onEvent(JSON.parse(buf));
}
