// Fetch one filing and turn it into the statements JSON.

import { mergeInlineDocs, parseInlineXbrl } from './ixbrl.ts';
import { loadTaxonomy } from './taxonomy.ts';
import { buildStatements, reclassify } from './statements.ts';
import { store, requireVersion } from './store.ts';
import { applyZh } from './zh.ts';
import type { Fetcher } from './secClient.ts';
import type { Company, Concept, ConceptMeta, EdgarFiling, FilingRef, ScrapeResult } from './types.ts';

/** A filing the scraper can fetch: the list entry plus its resolved URLs. */
export type ScrapableFiling = EdgarFiling;

// Bump whenever the parser / statement builder output changes: saved filings
// from older versions are discarded at startup and re-parsed on demand.
export const SCRAPE_VERSION = 2;

const FILING_TTL = 24 * 3600 * 1000; // a filed document never changes

export const emptyStatements = (saved: Pick<ScrapeResult, 'allStatements'>): boolean => (saved.allStatements || []).length > 0 && (saved.allStatements || []).every((st) => !st.columns?.length);

// Parsed filings are cached by accession (small); the raw SEC responses are
// not kept, so a company's multi-year history does not pin tens of MB.
const RESULT_TTL = 24 * 3600 * 1000;
const RESULT_CAP = 400;
const results = new Map<string, { expires: number; promise: Promise<ScrapeResult> }>();

// MetaLinks.json (written by EDGAR's renderer) carries the standard label and
// the taxonomy definition of every concept used in the filing.
/** The slice of MetaLinks.json this reads. */
interface MetaLinks {
  instance?: Record<string, { tag?: Record<string, { lang?: Record<string, { role?: Record<string, string> }> }> }>;
}

async function loadConceptMeta(client: Fetcher, folderUrl: string, folderFiles: readonly string[]): Promise<Record<Concept, ConceptMeta>> {
  if (!folderFiles.includes('MetaLinks.json')) return {};
  try {
    const meta = await client.json<MetaLinks>(`${folderUrl}/MetaLinks.json`);
    const out: Record<Concept, ConceptMeta> = {};
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

export function isCached(accession: string): boolean {
  const hit = results.get(accession);
  return !!hit && hit.expires > Date.now();
}

export function scrapeFiling(client: Fetcher, filing: ScrapableFiling, company: Company | null = null): Promise<ScrapeResult> {
  const hit = results.get(filing.accession);
  if (hit && hit.expires > Date.now()) return hit.promise;
  const promise = loadOrScrape(client, filing, company).catch((err) => {
    results.delete(filing.accession);
    throw err;
  });
  results.set(filing.accession, { expires: Date.now() + RESULT_TTL, promise });
  if (results.size > RESULT_CAP) results.delete(results.keys().next().value!);
  return promise;
}

// A filing rebuilt from SEC's quarterly datasets (server/lib/dera.js) stands
// in for one this cannot parse: it has the numbers, but not the headings,
// the indent hierarchy or the cover page. It is not the final word - the
// moment something can parse the document itself, the parse replaces it.
// EDGAR's isInlineXBRL flag is what says so.
export const isStandIn = (accession: string): boolean => store.filingHeader(accession)?.source === 'dera';
export const upgradable = (filing: FilingRef | null | undefined): boolean => !!filing?.isInlineXBRL && isStandIn(filing.accession);

// For the background crawler: parse and save a filing without pinning the
// result in the in-memory cache. Returns true when something was downloaded.
export async function ensureStored(client: Fetcher, filing: ScrapableFiling, company: Company | null): Promise<boolean> {
  if (store.hasFiling(filing.accession) && !upgradable(filing)) return false;
  const result = await scrapeUncached(client, filing, company);
  store.putFiling(filing.accession, filing.cik, result, SCRAPE_VERSION);
  return true;
}

async function loadOrScrape(client: Fetcher, filing: ScrapableFiling, company: Company | null): Promise<ScrapeResult> {
  const saved = store.getFiling(filing.accession);
  // a stand-in and the document is Inline XBRL: whoever opened this page gets
  // the real parse, and the store keeps it. The stand-in still answers if the
  // parse fails - it is what the page would have shown anyway.
  const standIn = saved?.filing?.source === 'dera' && !!filing.isInlineXBRL;
  // a saved result with no statements, or statements without a single column
  // (the financial statements were in a second Inline XBRL file), came from
  // a parser gap: parse it again
  if (saved && !standIn && saved.stats?.statementRoles > 0 && !emptyStatements(saved)) return applyZh(reclassify(saved));
  let result: ScrapeResult;
  try {
    result = await scrapeUncached(client, filing, company);
  } catch (err) {
    if (!standIn) throw err;
    console.warn(`scrape ${filing.accession}: ${(err as Error).message} - keeping the rebuilt copy`);
    return applyZh(reclassify(saved!));
  }
  store.putFiling(filing.accession, filing.cik, result, SCRAPE_VERSION);
  return result;
}

// The other Inline XBRL files of a multi-document filing: EDGAR's
// FilingSummary.xml lists them as InputFiles; failing that, files named
// <primary>_d2.htm, _d3.htm ... next to the primary document.
async function siblingDocuments(client: Fetcher, filing: ScrapableFiling, folderFiles: readonly string[]): Promise<string[]> {
  const primary = filing.primaryDocument;
  const base = primary.replace(/\.htm[l]?$/i, '');
  let names: string[] = [];
  if (folderFiles.includes('FilingSummary.xml')) {
    try {
      const xml = await client.text(`${filing.folderUrl}/FilingSummary.xml`);
      const block = /<InputFiles>([\s\S]*?)<\/InputFiles>/.exec(xml)?.[1] || '';
      names = [...block.matchAll(/<File[^>]*>([^<]+\.htm[l]?)<\/File>/gi)].map((m) => m[1]!.trim());
    } catch {
      /* fall through to the name pattern */
    }
  }
  if (!names.length) names = folderFiles.filter((f) => new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_d\\d+\\.htm[l]?$`, 'i').test(f));
  return names.filter((f) => f !== primary && folderFiles.includes(f));
}

/** EDGAR's index.json for a filing folder. */
interface FolderIndex {
  directory: { item: { name: string }[] };
}

async function scrapeUncached(client: Fetcher, filing: ScrapableFiling, company: Company | null): Promise<ScrapeResult> {
  const folder = await client.json<FolderIndex>(`${filing.folderUrl}/index.json`, { ttlMs: FILING_TTL });
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
