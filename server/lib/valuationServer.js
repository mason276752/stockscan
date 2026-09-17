// The valuation page on the server: buildValuation (shared with the static
// build) fed with what only the server can fetch - filings scraped from SEC,
// shares outstanding from SEC's companyconcept API, prices from the bar
// sources, FX rates from Yahoo.
import { scrapeFiling } from './scrape.js';
import { store } from './store.js';
import { history } from './prices.js';
import { priceSeries } from './priceSeries.js';
import { buildValuation } from './valuation.js';

const CONCEPT_API = 'https://data.sec.gov/api/xbrl/companyconcept/';
const SHARES_TTL = 24 * 3600 * 1000;

// Shares outstanding per filing (accession) from the cover page, via companyconcept.
async function sharesByAccession(client, cik) {
  const key = `shares:${cik}`;
  const saved = store.getKV(key);
  if (saved && saved.ageMs < SHARES_TTL) return saved.value;
  const padded = String(cik).padStart(10, '0');
  const out = { byAccn: {}, list: [] };
  for (const [tax, concept] of [
    ['dei', 'EntityCommonStockSharesOutstanding'],
    ['us-gaap', 'CommonStockSharesOutstanding'],
  ]) {
    try {
      const j = await client.json(`${CONCEPT_API}CIK${padded}/${tax}/${concept}.json`);
      for (const f of j.units?.shares || []) {
        if (typeof f.val !== 'number' || f.val <= 0) continue;
        if (!out.byAccn[f.accn]) out.byAccn[f.accn] = f.val;
        out.list.push({ end: f.end, val: f.val, accn: f.accn });
      }
      if (out.list.length) break; // dei found: no need for the balance-sheet concept
    } catch (err) {
      if (err.status !== 404) console.warn(`companyconcept ${concept} for CIK ${cik}: ${err.message}`);
    }
  }
  out.list.sort((a, b) => (a.end < b.end ? -1 : 1));
  store.putKV(key, out);
  return out;
}

export const serverValuation = (client, company, opts) =>
  buildValuation(company, opts, {
    load: (f) => scrapeFiling(client, f, company),
    shares: (cik) => sharesByAccession(client, cik),
    prices: priceSeries,
    fx: history,
  });
