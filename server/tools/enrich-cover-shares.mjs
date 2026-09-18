// One-shot, non-destructive enrichment for filings saved before parser-derived
// coverShares existed. It queries companyconcept once per CIK and writes only
// an unambiguous exact-accession value; new filings instead get their number
// directly from the parsed cover page. Run with SEC_USER_AGENT set:
//   npm run enrich:cover-shares -- --dry-run --cik 1652044
//   npm run enrich:cover-shares
import { SecClient } from '../lib/secClient.js';
import { coverSharesFor, indexCoverShares } from '../lib/coverShares.js';
import { openStore, store } from '../lib/store.js';

const dryRun = process.argv.includes('--dry-run');
const onlyCik = process.argv.find((x, i, a) => a[i - 1] === '--cik');
// A single stale companyconcept response must not hold up a multi-thousand-CIK migration.
const client = new SecClient({ timeoutMs: 15_000 });
openStore();

const CONCEPT_API = 'https://data.sec.gov/api/xbrl/companyconcept/';
const byCik = new Map();
for (const f of store.allFilings()) {
  const a = byCik.get(f.cik) || [];
  a.push(f);
  byCik.set(f.cik, a);
}
let scanned = 0;
let changed = 0;
let skipped = 0;
let ambiguous = 0;
let failed = 0;

async function companyConcept(cik) {
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
      if (err.status !== 404) throw err;
    }
  }
  return indexCoverShares(rows);
}

for (const [cik, filings] of byCik) {
  if (onlyCik && Number(onlyCik) !== Number(cik)) continue;
  // Decode first so a resumed run does not keep making SEC requests for CIKs
  // whose complete batch was enriched before an interruption.
  const pending = [];
  for (const f of filings) {
    scanned++;
    const result = store.getFiling(f.accession);
    if (!result || result.coverShares?.length) {
      skipped++;
      continue;
    }
    pending.push({ f, result });
  }
  if (!pending.length) continue;
  let shares;
  try {
    shares = await companyConcept(cik);
  } catch (err) {
    failed++;
    console.warn(`enrich-cover-shares ${cik}: ${err.message}`);
    continue;
  }
  for (const { f, result } of pending) {
    const hit = coverSharesFor(shares, { sources: [f.accession], periodEnd: f.reportDate });
    if (!hit) {
      // An accession with rows but no index entry was conflicting, so it is
      // intentionally left empty instead of treating a class as the total.
      if (shares.list.some((x) => x.accession === f.accession)) ambiguous++;
      else skipped++;
      continue;
    }
    result.coverShares = [{ end: hit.end, entity: null, value: hit.value, concept: hit.basis, basis: 'companyconcept', classes: 1, source: 'companyconcept' }];
    if (!dryRun) store.putFiling(f.accession, f.cik, result, f.version, result.fetchedAt);
    changed++;
  }
  if (scanned % 1000 < filings.length) console.log(`enrich-cover-shares: ${scanned} filings, ${changed} ${dryRun ? 'would change' : 'changed'}`);
}
console.log(`enrich-cover-shares: ${scanned} filings, ${changed} ${dryRun ? 'would change' : 'changed'}, ${skipped} skipped, ${ambiguous} ambiguous, ${failed} CIK failures`);
