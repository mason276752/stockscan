// The first statements of a company that has only just gone public: which of
// its prospectuses to read, and saving what was read. The reading itself is
// in prospectus.ts (no I/O).

import { SCRAPE_VERSION } from './scrape.ts';
import { store } from './store.ts';
import { isMergerForm } from './filings.ts';
import { prospectusResults } from './prospectus.ts';
import type { Fetcher } from './secClient.ts';
import type { CompanyWithFilings } from './edgar.ts';

const TRIES = 3; // documents of one company: each is megabytes
// A prospectus nothing could be read out of will not read any better
// tomorrow; with a better parser it may. Bump it when the parser improves.
const PARSER = 1;
const FAILED_KEY = 'prospectus:failed'; // accession -> the parser that gave up on it

/** The periods one prospectus gave. */
export interface SavedProspectus {
  form: string;
  accessions: string[];
}

// Read and save the best prospectus of a company that has reported nothing
// else. null when there is none, none could be read, or the best one that
// can be is saved already.
export async function saveProspectus(client: Fetcher, company: CompanyWithFilings): Promise<SavedProspectus | null> {
  const failed: Record<string, number> = store.getKV<Record<string, number>>(FAILED_KEY)?.value || {};
  for (const f of (company.prospectuses || []).filter((x) => failed[x.accession] !== PARSER).slice(0, TRIES)) {
    if (store.hasFiling(f.accession)) return null;
    const results = prospectusResults(await client.text(f.documentUrl), { cik: f.cik, accession: f.accession, form: f.form, filingDate: f.filingDate!, primaryDocument: f.primaryDocument }, company, { ownOnly: isMergerForm(f.form) });
    if (results.length) {
      for (const r of results) store.putFiling(r.filing.accession, f.cik, r, SCRAPE_VERSION);
      return { form: f.form, accessions: results.map((r) => r.filing.accession) };
    }
    failed[f.accession] = PARSER;
    store.putKV(FAILED_KEY, failed);
  }
  return null;
}
