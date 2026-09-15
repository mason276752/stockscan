async function get(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
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
  status: () => get('/api/status'),
  // browse pages
  browseSic: () => get('/api/browse/sic'),
  browseFiler: () => get('/api/browse/filer'),
  browseCompanies: (params) => get(`/api/browse/companies?${new URLSearchParams(params)}`),
  browseEtfs: (q = '') => get(`/api/browse/etf${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  etfHoldings: (ticker) => get(`/api/browse/etf/${encodeURIComponent(ticker)}`),
  etfHoldingsUrl: (ticker) => `/api/browse/etf/${encodeURIComponent(ticker)}`,
};
