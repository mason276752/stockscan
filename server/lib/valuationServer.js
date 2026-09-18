// The valuation page on the server: buildValuation (shared with the static
// build) fed with what only the server can fetch - filings scraped from SEC,
// shares outstanding from SEC's companyconcept API, prices from the bar
// sources, FX rates from Yahoo.
import { scrapeFiling } from './scrape.js';
import { store } from './store.js';
import { history } from './prices.js';
import { priceSeries } from './priceSeries.js';
import { buildValuation } from './valuation.js';
import { indexCoverShares } from './coverShares.js';

const CONCEPT_API = 'https://data.sec.gov/api/xbrl/companyconcept/';
const SHARES_TTL = 24 * 3600 * 1000;

// Cover-share fallback for old filing files. companyconcept does not expose
// the filing contexts needed to prove multiple rows are distinct classes, so
// accept only the index's unambiguous singleton values.
async function sharesByAccession(client, cik) {
  const key = `shares:v2:${cik}`;
  const saved = store.getKV(key);
  if (saved && saved.ageMs < SHARES_TTL && saved.value?.version === 2) return saved.value;
  const padded = String(cik).padStart(10, '0');
  const rows = [];
  for (const [tax, concept] of [
    ['dei', 'EntityCommonStockSharesOutstanding'],
    ['us-gaap', 'CommonStockSharesOutstanding'],
  ]) {
    try {
      const j = await client.json(`${CONCEPT_API}CIK${padded}/${tax}/${concept}.json`);
      rows.push(
        ...(Array.isArray(j.units?.shares) ? j.units.shares : [])
          .filter((f) => typeof f.val === 'number' && Number.isFinite(f.val) && f.val > 0 && f.accn && /^\d{4}-\d{2}-\d{2}$/.test(f.end || ''))
          .map((f) => ({ accession: f.accn, end: f.end, value: f.val, source: 'companyconcept', concept: `${tax}:${concept}`, basis: `${tax}:${concept}` })),
      );
    } catch (err) {
      if (err.status !== 404) console.warn(`companyconcept ${concept} for CIK ${cik}: ${err.message}`);
    }
  }
  const out = indexCoverShares(rows);
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
