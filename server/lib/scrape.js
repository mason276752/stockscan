// Fetch one filing and turn it into the statements JSON.

import { parseInlineXbrl } from './ixbrl.js';
import { loadTaxonomy } from './taxonomy.js';
import { buildStatements } from './statements.js';

const FILING_TTL = 24 * 3600 * 1000; // a filed document never changes

// Parsed filings are cached by accession (small); the raw SEC responses are
// not kept, so a company's multi-year history does not pin tens of MB.
const RESULT_TTL = 24 * 3600 * 1000;
const RESULT_CAP = 400;
const results = new Map(); // accession -> { expires, promise }

// MetaLinks.json (written by EDGAR's renderer) carries the standard label and
// the taxonomy definition of every concept used in the filing.
async function loadConceptMeta(client, folderUrl, folderFiles) {
  if (!folderFiles.includes('MetaLinks.json')) return {};
  try {
    const meta = await client.json(`${folderUrl}/MetaLinks.json`);
    const out = {};
    for (const inst of Object.values(meta.instance || {})) {
      for (const [key, tag] of Object.entries(inst.tag || {})) {
        const i = key.indexOf('_');
        const concept = i > 0 ? `${key.slice(0, i)}:${key.slice(i + 1)}` : key;
        const roles = tag.lang?.['en-us']?.role || {};
        out[concept] = { label: roles.label || null, documentation: roles.documentation || null };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function scrapeFiling(client, filing, company = null) {
  const hit = results.get(filing.accession);
  if (hit && hit.expires > Date.now()) return hit.promise;
  const promise = scrapeUncached(client, filing, company).catch((err) => {
    results.delete(filing.accession);
    throw err;
  });
  results.set(filing.accession, { expires: Date.now() + RESULT_TTL, promise });
  if (results.size > RESULT_CAP) results.delete(results.keys().next().value);
  return promise;
}

async function scrapeUncached(client, filing, company) {
  const doc = parseInlineXbrl(await client.text(filing.documentUrl));
  const folder = await client.json(`${filing.folderUrl}/index.json`, { ttlMs: FILING_TTL });
  const folderFiles = folder.directory.item.map((i) => i.name);
  const tax = await loadTaxonomy({ text: (url) => client.text(url) }, filing.folderUrl, doc.schemaRef, folderFiles);
  const concepts = await loadConceptMeta(client, filing.folderUrl, folderFiles);
  const { statements, allStatements } = buildStatements(doc, tax, concepts);
  return {
    fetchedAt: new Date().toISOString(),
    filing: {
      cik: filing.cik,
      companyName: company?.name || doc.dei.EntityRegistrantName || null,
      form: filing.form || doc.dei.DocumentType || null,
      filingDate: filing.filingDate || null,
      periodEnd: filing.reportDate || doc.dei.DocumentPeriodEndDate || null,
      fiscalYear: doc.dei.DocumentFiscalYearFocus || (filing.fiscalYear ? String(filing.fiscalYear) : null),
      fiscalPeriod: doc.dei.DocumentFiscalPeriodFocus || filing.fiscalPeriod || null,
      accession: filing.accession,
      primaryDocument: filing.primaryDocument,
      documentUrl: filing.documentUrl,
      viewerUrl: filing.viewerUrl,
      indexUrl: filing.indexUrl,
      taxonomyFiles: tax.files,
    },
    dei: doc.dei,
    units: doc.units,
    statements,
    allStatements,
    stats: { facts: doc.facts.length, contexts: Object.keys(doc.contexts).length, statementRoles: allStatements.length },
  };
}
