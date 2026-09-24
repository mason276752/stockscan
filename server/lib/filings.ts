// Filing-list helpers with no I/O (the browser build of the app uses them
// too): which forms count, where a filing's documents live on EDGAR, the
// fiscal year / period label of a period end, and picking a filing.

import type { IsoDate } from './types.ts';

const ARCHIVES = 'https://www.sec.gov/Archives/edgar/data';

export const DEFAULT_FORMS = ['10-K', '10-Q', '20-F', '40-F', '10-K/A', '10-Q/A', '20-F/A'];

/** Where the documents of one filing live on EDGAR. */
export interface FilingUrls {
  folderUrl: string;
  documentUrl: string;
  viewerUrl: string;
  indexUrl: string;
}

export function filingUrls(cik: number | string, accession: string, primaryDocument: string): FilingUrls {
  const nodash = accession.replace(/-/g, '');
  const folderUrl = `${ARCHIVES}/${cik}/${nodash}`;
  return {
    folderUrl,
    documentUrl: `${folderUrl}/${primaryDocument}`,
    viewerUrl: `https://www.sec.gov/ix?doc=/Archives/edgar/data/${cik}/${nodash}/${primaryDocument}`,
    indexUrl: `${folderUrl}/${accession}-index.html`,
  };
}

/** The fiscal year and period a report date falls in. */
export interface FiscalLabel {
  fiscalYear: number | null;
  fiscalPeriod: string | null;
}

// Fiscal year / period label derived from the period end date and the
// company's fiscal-year-end (MMDD). Report dates are month ends give or take
// a few days (52/53-week years), so only the month is used.
export function fiscalLabel(form: string, reportDate: IsoDate | null | undefined, fiscalYearEnd?: string | null): FiscalLabel {
  if (!reportDate) return { fiscalYear: null, fiscalPeriod: null };
  const [y, m, d] = reportDate.split('-').map(Number) as [number, number, number];
  let month = d <= 7 ? m - 1 : m; // Jan 2 is really a December period end
  let year = y;
  if (month === 0) {
    month = 12;
    year -= 1;
  }
  const fyeMonth = fiscalYearEnd && /^\d{4}$/.test(fiscalYearEnd) ? Number(fiscalYearEnd.slice(0, 2)) : 12;
  const fiscalYear = month <= fyeMonth ? year : year + 1;
  const base = form.toUpperCase().replace(/\/A$/, '');
  if (base !== '10-Q') return { fiscalYear, fiscalPeriod: 'FY' };
  const monthsIntoYear = ((((month - fyeMonth - 1) % 12) + 12) % 12) + 1;
  return { fiscalYear, fiscalPeriod: `Q${Math.ceil(monthsIntoYear / 3)}` };
}

/**
 * What the amendment rules read off a filing. Both the store's filing list
 * and the screener's score rows satisfy it, so the helpers below stay
 * generic over whichever kind of row the caller holds.
 */
export interface AmendableFiling {
  form?: string | null;
  periodEnd?: IsoDate | null;
  reportDate?: IsoDate | null;
  filingDate?: IsoDate | null;
  thin?: boolean | number;
}

// A period can reach EDGAR more than once: the original, and then an
// amendment (10-K/A, 10-Q/A, 20-F/A). The amendment is the corrected
// filing - it is what the company now says those numbers are - so it is the
// one to read, and the original is superseded rather than an extra period.
//
// The catch: more than half of all amendments carry no statements at all.
// The classic 10-K/A adds Part III (director and executive pay) when the
// proxy was late, and restates nothing. Measured over this store: of 804
// amendments 373 have the numbers and 431 have none (426 of those have not
// one statement in them). Those correct nothing, so their original stands.
//
// `thin(f)` answers "this one has no numbers in it". Without it the filing's
// own `thin` flag is read - the server stamps it from the saved score's
// coverage, the static build writes it into companies.json - so most
// callers need pass nothing. The score side passes its own test instead
// (screen.ts: a score row has the coverage, not the flag).
//
// Each period keeps the place its newest filing had, so a list that came in
// newest-first stays newest-first.
// Remembered per filing: a rule ETF replays a company's whole filing list
// once per filing date it has (pickAsOf), so the same filing is keyed
// dozens of times over - tens of millions of string operations across a
// replay. The key is a function of `form` and the period alone and nothing
// rewrites those on a filing once it is built.
const periodKeys = new WeakMap<AmendableFiling, string>();
export function filingPeriodKey(f: AmendableFiling): string {
  let key = periodKeys.get(f);
  if (key === undefined) periodKeys.set(f, (key = `${String(f.form || '').toUpperCase().replace(/\/A$/, '')}@${f.periodEnd || f.reportDate || ''}`));
  return key;
}

export function collapseAmendments<T extends AmendableFiling>(filings: readonly (T | null | undefined)[], thin: ((f: T) => boolean) | null = null): T[] {
  const periodOf = filingPeriodKey;
  const isThin = (f: T) => (thin ? !!thin(f) : !!f.thin);
  const isAmend = (f: T) => /\/A$/i.test(f.form || '');
  // the latest filing of the period that has numbers in it; if none has, the
  // latest of them. An amendment is by definition later than its original,
  // which settles it where the filing dates are not known (the store's
  // filing index has none).
  const better = (a: T, b: T) => {
    if (isThin(a) !== isThin(b)) return !isThin(a);
    if ((a.filingDate || '') !== (b.filingDate || '')) return (a.filingDate || '') > (b.filingDate || '');
    return isAmend(a) && !isAmend(b);
  };
  const out: T[] = [];
  const at = new Map<string, number>();
  for (const f of filings) {
    if (!f) continue;
    const key = periodOf(f);
    const i = at.get(key);
    if (i === undefined) at.set(key, out.push(f) - 1);
    else if (better(f, out[i]!)) out[i] = f;
  }
  return out;
}

/** A filing row that also carries the fiscal labels the picker filters on. */
export interface PickableFiling extends AmendableFiling {
  fiscalYear?: string | number | null;
  fiscalPeriod?: string | null;
}

export interface PickFilingOptions<T> {
  year?: string | number | null;
  period?: string | null;
  form?: string | null;
  thin?: ((f: T) => boolean) | null;
}

export function pickFiling<T extends PickableFiling>(filings: readonly T[], { year, period, form, thin = null }: PickFilingOptions<T> = {}): T | null {
  let list = filings;
  if (form) list = list.filter((f) => String(f.form).toUpperCase() === form.toUpperCase());
  if (year) list = list.filter((f) => f.fiscalYear === Number(year));
  if (period) list = list.filter((f) => f.fiscalPeriod === period.toUpperCase());
  return collapseAmendments(list, thin)[0] || null;
}

/** The fields the store's file naming needs off a filing. */
export interface NamedFiling {
  accession: string;
  reportDate?: IsoDate | null;
  form?: string | null;
}

// The store's file names of a filing and its score (store.ts's naming, here
// so the static build and its browser can derive them instead of shipping
// 30,000 paths in the company index): a form's slash becomes '~'.
const safeName = (s: string | null | undefined) => String(s ?? '-').replace(/\//g, '~').replace(/[^A-Za-z0-9.~-]/g, '_') || '-';
export const filingFile = (cik: number | string, f: NamedFiling, version: number): string =>
  `filings/${cik}/${f.accession}__${safeName(f.reportDate)}__${safeName(f.form)}__v${version}.json.zst`;
export const scoreFile = (cik: number | string, f: NamedFiling, version: number): string =>
  `scores/${cik}/${f.accession}__${safeName(f.reportDate)}__v${version}.json.zst`;
