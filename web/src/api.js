async function get(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

export const api = {
  search: (q) => get(`/api/search?q=${encodeURIComponent(q)}`),
  company: (id, { refresh = false } = {}) => get(`/api/company/${encodeURIComponent(id)}${refresh ? '?refresh=1' : ''}`),
  filing: (cik, accession, view = 'all') => get(`/api/filing/${cik}/${accession}${view === 'current' ? '?view=current' : ''}`),
  filingUrl: (cik, accession, view = 'all') => `/api/filing/${cik}/${accession}${view === 'current' ? '?view=current' : ''}`,
  quarters: (id, year) => get(`/api/company/${encodeURIComponent(id)}/quarters?year=${year}`),
  quartersUrl: (id, year) => `/api/company/${encodeURIComponent(id)}/quarters?year=${year}`,
  indicators: (id, params) => get(`/api/company/${encodeURIComponent(id)}/indicators?${new URLSearchParams(params)}`),
  indicatorsUrl: (id, params) => `/api/company/${encodeURIComponent(id)}/indicators?${new URLSearchParams(params)}`,
  valuation: (id, params) => get(`/api/company/${encodeURIComponent(id)}/valuation?${new URLSearchParams(params)}`),
  valuationUrl: (id, params) => `/api/company/${encodeURIComponent(id)}/valuation?${new URLSearchParams(params)}`,
  status: () => get('/api/status'),
  screenFields: () => get('/api/screen/fields'),
  screen: (params) => get(`/api/screen?${new URLSearchParams(params)}`),
  screenUrl: (params) => `/api/screen?${new URLSearchParams(params)}`,
  scores: (ciks) => get(`/api/score?ciks=${ciks.join(',')}`),
  score: (cik, accession) => get(`/api/score/${cik}/${accession}`),
  // browse pages
  browseSic: () => get('/api/browse/sic'),
  browseFiler: () => get('/api/browse/filer'),
  browseCompanies: (params) => get(`/api/browse/companies?${new URLSearchParams(params)}`),
  browseEtfs: (q = '') => get(`/api/browse/etf${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  etfHoldings: (ticker) => get(`/api/browse/etf/${encodeURIComponent(ticker)}`),
  etfHoldingsUrl: (ticker) => `/api/browse/etf/${encodeURIComponent(ticker)}`,
  etfLive: (ticker) => get(`/api/browse/etf/${encodeURIComponent(ticker)}/live`),
  // custom ETF charts
  quotesStatus: () => get('/api/quotes/status'),
  tvSymbol: (ticker) => get(`/api/quotes/tv-symbol/${encodeURIComponent(ticker)}`),
  ibConnect: () => post('/api/quotes/ib/connect', {}),
  bars: (symbol) => get(`/api/bars/${encodeURIComponent(symbol)}`),
  basket: (body) => post('/api/basket', body),
};
