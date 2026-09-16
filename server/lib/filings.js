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

export function pickFiling(filings, { year, period, form } = {}) {
  let list = filings;
  if (form) list = list.filter((f) => f.form.toUpperCase() === form.toUpperCase());
  if (year) list = list.filter((f) => f.fiscalYear === Number(year));
  if (period) list = list.filter((f) => f.fiscalPeriod === period.toUpperCase());
  // an amendment (10-K/A) is usually just Part III with no statements: prefer the original
  const originals = list.filter((f) => !f.form.toUpperCase().endsWith('/A'));
  return (originals.length ? originals : list)[0] || null;
}

