async function get(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

export const api = {
  search: (q) => get(`/api/search?q=${encodeURIComponent(q)}`),
  company: (id) => get(`/api/company/${encodeURIComponent(id)}`),
  filing: (cik, accession) => get(`/api/filing/${cik}/${accession}`),
  filingUrl: (cik, accession) => `/api/filing/${cik}/${accession}`,
  quarters: (id, year) => get(`/api/company/${encodeURIComponent(id)}/quarters?year=${year}`),
  quartersUrl: (id, year) => `/api/company/${encodeURIComponent(id)}/quarters?year=${year}`,
  indicators: (id, params) => get(`/api/company/${encodeURIComponent(id)}/indicators?${new URLSearchParams(params)}`),
  indicatorsUrl: (id, params) => `/api/company/${encodeURIComponent(id)}/indicators?${new URLSearchParams(params)}`,
};
