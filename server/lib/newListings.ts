// The first statements of a company that has only just gone public: which of
// its prospectuses to read, and saving what was read. The reading itself is
// in prospectus.ts (no I/O).

import { SCRAPE_VERSION } from './scrape.ts';
import { store } from './store.ts';
import { isMergerForm, isProspectusForm } from './filings.ts';
import { PROSPECTUS_PARSER, prospectusResults } from './prospectus.ts';
import type { Fetcher } from './secClient.ts';
import type { CompanyWithFilings } from './edgar.ts';

const TRIES = 3; // documents of one company: each is megabytes
const FAILED_KEY = 'prospectus:failed'; // accession -> the parser that gave up on it

/** The periods one prospectus gave. */
export interface SavedProspectus {
  form: string;
  accessions: string[];
}

// Read and save the best prospectus of a company that has reported nothing
// else. null when there is none, none could be read, or the best one that
// can be is saved already. What an older version of the reader made of it is
// not believed: it is read again and replaced - or just removed, when this
// version finds nothing in it.
export async function saveProspectus(client: Fetcher, company: CompanyWithFilings): Promise<SavedProspectus | null> {
  const failed: Record<string, number> = store.getKV<Record<string, number>>(FAILED_KEY)?.value || {};
  const stale = new Set(store.filingIndex(company.cik).filter((r) => isProspectusForm(r.form) && store.filingHeader(r.accession)?.parser !== PROSPECTUS_PARSER).map((r) => r.accession));
  for (const f of (company.prospectuses || []).filter((x) => failed[x.accession] !== PROSPECTUS_PARSER).slice(0, TRIES)) {
    if (store.hasFiling(f.accession) && !stale.has(f.accession)) return null;
    const results = prospectusResults(await client.text(f.documentUrl), { cik: f.cik, accession: f.accession, form: f.form, filingDate: f.filingDate!, primaryDocument: f.primaryDocument }, company, { ownOnly: isMergerForm(f.form) });
    if (results.length) {
      for (const accession of stale) store.dropFiling(accession);
      for (const r of results) store.putFiling(r.filing.accession, f.cik, r, SCRAPE_VERSION);
      return { form: f.form, accessions: results.map((r) => r.filing.accession) };
    }
    failed[f.accession] = PROSPECTUS_PARSER;
    store.putKV(FAILED_KEY, failed);
  }
  for (const accession of stale) store.dropFiling(accession);
  return null;
}
