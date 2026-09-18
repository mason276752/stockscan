// Fetch one filing and turn it into the statements JSON.

import { mergeInlineDocs, parseInlineXbrl } from './ixbrl.js';
import { loadTaxonomy } from './taxonomy.js';
import { buildStatements, reclassify } from './statements.js';
import { store, requireVersion } from './store.js';
import { applyZh } from './zh.js';

// Bump whenever the parser / statement builder output changes: saved filings
// from older versions are discarded at startup and re-parsed on demand.
export const SCRAPE_VERSION = 2;

const FILING_TTL = 24 * 3600 * 1000; // a filed document never changes

export const emptyStatements = (saved) => (saved.allStatements || []).length > 0 && (saved.allStatements || []).every((st) => !st.columns?.length);

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

export function isCached(accession) {
  const hit = results.get(accession);
  return !!hit && hit.expires > Date.now();
}

export function scrapeFiling(client, filing, company = null) {
  const hit = results.get(filing.accession);
  if (hit && hit.expires > Date.now()) return hit.promise;
  const promise = loadOrScrape(client, filing, company).catch((err) => {
    results.delete(filing.accession);
    throw err;
  });
  results.set(filing.accession, { expires: Date.now() + RESULT_TTL, promise });
  if (results.size > RESULT_CAP) results.delete(results.keys().next().value);
  return promise;
}

// For the background crawler: parse and save a filing without pinning the
// result in the in-memory cache. Returns true when something was downloaded.
export async function ensureStored(client, filing, company) {
  if (store.hasFiling(filing.accession)) return false;
  const result = await scrapeUncached(client, filing, company);
  store.putFiling(filing.accession, filing.cik, result, SCRAPE_VERSION);
  return true;
}

async function loadOrScrape(client, filing, company) {
  const saved = store.getFiling(filing.accession);
  // a saved result with no statements, or statements without a single column
  // (the financial statements were in a second Inline XBRL file), came from
  // a parser gap: parse it again
  if (saved && saved.stats?.statementRoles > 0 && !emptyStatements(saved)) return applyZh(reclassify(saved));
  const result = await scrapeUncached(client, filing, company);
  store.putFiling(filing.accession, filing.cik, result, SCRAPE_VERSION);
  return result;
}

// The other Inline XBRL files of a multi-document filing: EDGAR's
// FilingSummary.xml lists them as InputFiles; failing that, files named
// <primary>_d2.htm, _d3.htm ... next to the primary document.
async function siblingDocuments(client, filing, folderFiles) {
  const primary = filing.primaryDocument;
  const base = primary.replace(/\.htm[l]?$/i, '');
  let names = [];
  if (folderFiles.includes('FilingSummary.xml')) {
    try {
      const xml = await client.text(`${filing.folderUrl}/FilingSummary.xml`);
      const block = /<InputFiles>([\s\S]*?)<\/InputFiles>/.exec(xml)?.[1] || '';
      names = [...block.matchAll(/<File[^>]*>([^<]+\.htm[l]?)<\/File>/gi)].map((m) => m[1].trim());
    } catch {
      /* fall through to the name pattern */
    }
  }
  if (!names.length) names = folderFiles.filter((f) => new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_d\\d+\\.htm[l]?$`, 'i').test(f));
  return names.filter((f) => f !== primary && folderFiles.includes(f));
}

async function scrapeUncached(client, filing, company) {
  const folder = await client.json(`${filing.folderUrl}/index.json`, { ttlMs: FILING_TTL });
  const folderFiles = folder.directory.item.map((i) => i.name);
  const docs = [parseInlineXbrl(await client.text(filing.documentUrl))];
  for (const name of await siblingDocuments(client, filing, folderFiles)) docs.push(parseInlineXbrl(await client.text(`${filing.folderUrl}/${name}`)));
  const doc = mergeInlineDocs(docs);
  const tax = await loadTaxonomy({ text: (url) => client.text(url) }, filing.folderUrl, doc.schemaRef, folderFiles);
  const concepts = await loadConceptMeta(client, filing.folderUrl, folderFiles);
  const { statements, allStatements } = buildStatements(doc, tax, concepts);
  return {
    fetchedAt: new Date().toISOString(),
    documents: docs.length,
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
    // Compact parser-derived cover facts; raw facts and contexts are not kept.
    coverShares: doc.coverShares || [],
    units: doc.units,
    statements,
    allStatements,
    stats: { facts: doc.facts.length, contexts: Object.keys(doc.contexts).length, statementRoles: allStatements.length },
  };
}
