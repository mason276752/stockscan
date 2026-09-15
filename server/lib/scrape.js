// Fetch one filing and turn it into the statements JSON.

import { parseInlineXbrl } from './ixbrl.js';
import { loadTaxonomy } from './taxonomy.js';
import { buildStatements } from './statements.js';

const FILING_TTL = 24 * 3600 * 1000; // a filed document never changes

// MetaLinks.json (written by EDGAR's renderer) carries the standard label and
// the taxonomy definition of every concept used in the filing.
async function loadConceptMeta(client, folderUrl, folderFiles) {
  if (!folderFiles.includes('MetaLinks.json')) return {};
  try {
    const meta = await client.json(`${folderUrl}/MetaLinks.json`, { ttlMs: FILING_TTL });
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

export async function scrapeFiling(client, filing, company = null) {
  const doc = parseInlineXbrl(await client.text(filing.documentUrl, { ttlMs: FILING_TTL }));
  const folder = await client.json(`${filing.folderUrl}/index.json`, { ttlMs: FILING_TTL });
  const folderFiles = folder.directory.item.map((i) => i.name);
  const tax = await loadTaxonomy(
    { text: (url) => client.text(url, { ttlMs: FILING_TTL }) },
    filing.folderUrl,
    doc.schemaRef,
    folderFiles,
  );
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
