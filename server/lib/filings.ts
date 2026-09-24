// Filing-list helpers with no I/O (the browser build of the app uses them
// too): which forms count, where a filing's documents live on EDGAR, the
// fiscal year / period label of a period end, and picking a filing.

const ARCHIVES = 'https://www.sec.gov/Archives/edgar/data';

export const DEFAULT_FORMS = ['10-K', '10-Q', '20-F', '40-F', '10-K/A', '10-Q/A', '20-F/A'];

export function filingUrls(cik, accession, primaryDocument) {
  const nodash = accession.replace(/-/g, '');
  const folderUrl = `${ARCHIVES}/${cik}/${nodash}`;
  return {
    folderUrl,
    documentUrl: `${folderUrl}/${primaryDocument}`,
    viewerUrl: `https://www.sec.gov/ix?doc=/Archives/edgar/data/${cik}/${nodash}/${primaryDocument}`,
    indexUrl: `${folderUrl}/${accession}-index.html`,
  };
}

// Fiscal year / period label derived from the period end date and the
// company's fiscal-year-end (MMDD). Report dates are month ends give or take
// a few days (52/53-week years), so only the month is used.
export function fiscalLabel(form, reportDate, fiscalYearEnd) {
  if (!reportDate) return { fiscalYear: null, fiscalPeriod: null };
  const [y, m, d] = reportDate.split('-').map(Number);
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
// (screen.js: a score row has the coverage, not the flag).
//
// Each period keeps the place its newest filing had, so a list that came in
// newest-first stays newest-first.
export const filingPeriodKey = (f) => `${String(f.form || '').toUpperCase().replace(/\/A$/, '')}@${f.periodEnd || f.reportDate || ''}`;

export function collapseAmendments(filings, thin = null) {
  const periodOf = filingPeriodKey;
  const isThin = (f) => (thin ? !!thin(f) : !!f.thin);
  const isAmend = (f) => /\/A$/i.test(f.form || '');
  // the latest filing of the period that has numbers in it; if none has, the
  // latest of them. An amendment is by definition later than its original,
  // which settles it where the filing dates are not known (the store's
  // filing index has none).
  const better = (a, b) => {
    if (isThin(a) !== isThin(b)) return !isThin(a);
    if ((a.filingDate || '') !== (b.filingDate || '')) return (a.filingDate || '') > (b.filingDate || '');
    return isAmend(a) && !isAmend(b);
  };
  const out = [];
  const at = new Map();
  for (const f of filings) {
    if (!f) continue;
    const key = periodOf(f);
    const i = at.get(key);
    if (i === undefined) at.set(key, out.push(f) - 1);
    else if (better(f, out[i])) out[i] = f;
  }
  return out;
}

export function pickFiling(filings, { year, period, form, thin = null } = {}) {
  let list = filings;
  if (form) list = list.filter((f) => f.form.toUpperCase() === form.toUpperCase());
  if (year) list = list.filter((f) => f.fiscalYear === Number(year));
  if (period) list = list.filter((f) => f.fiscalPeriod === period.toUpperCase());
  return collapseAmendments(list, thin)[0] || null;
}


// The store's file names of a filing and its score (store.js's naming, here
// so the static build and its browser can derive them instead of shipping
// 30,000 paths in the company index): a form's slash becomes '~'.
const safeName = (s) => String(s ?? '-').replace(/\//g, '~').replace(/[^A-Za-z0-9.~-]/g, '_') || '-';
export const filingFile = (cik, f, version) => `filings/${cik}/${f.accession}__${safeName(f.reportDate)}__${safeName(f.form)}__v${version}.json.zst`;
export const scoreFile = (cik, f, version) => `scores/${cik}/${f.accession}__${safeName(f.reportDate)}__v${version}.json.zst`;
