// The four statements rebuilt from SEC's Financial Statement Data Sets,
// for the filings the Inline XBRL parser cannot reach.
//
//   https://www.sec.gov/dera/data/financial-statement-data-sets.html
//
// One zip per calendar quarter, back to 2009q1 - ten years before Inline
// XBRL, which is all ixbrl.js can read (a pre-2019 filing tags its numbers
// in a separate instance document, not in the HTML). Four tab-separated
// files, keyed by `adsh`, the accession (2026q2 is grouped by it, but the
// quarters SEC re-published in 2024 are sorted by tag - so a filing's rows
// can be anywhere in the file):
//
//   sub.txt  one row per submission: adsh (the accession), cik, name, sic,
//            form, period, fy, fp, filed, instance
//   num.txt  every number: adsh, tag, version, ddate, qtrs, uom, segments,
//            coreg, value. `qtrs` says what the number covers - 0 is a
//            balance at ddate, 1 a quarter, 2 a half year, 4 a year.
//   pre.txt  where each number is presented: adsh, report, line, stmt
//            (BS / IS / CF / EQ / CI / UN), inpth (parenthetical), tag,
//            version, plabel (the filer's own label), negating
//   tag.txt  every tag with its datatype, standard label and SEC's definition
//
// What this rebuild has, and what the Inline XBRL parse has that it does not:
//
//   has     every line of the four statements in the filer's own order with
//           the filer's own label, the numbers, the sign flag, the standard
//           label and SEC's definition of every standard concept
//   lacks   the headings ("Operating expenses:") and with them the indent
//           hierarchy - pre.txt carries no abstract rows at all, so every
//           line sits at depth 0 (quarters.js already has a path for a
//           statement presented flat); the filer's own statement titles,
//           synthesised here from `stmt`; the cover page (dei), so no share
//           count for the valuation page; and the dimensional columns of
//           every statement but the equity roll-forward, because pre.txt
//           does not say which axes a statement declares (see `dimensional`).
//
// Measured against the crawler's own parse of the same filings (2026q2,
// 6,001 of them, `ingest-dera.mjs --compare`): 6,000 rebuilt, and scoring
// each side the same way gives the identical score 95.4% of the time, a
// score within 2 points 96.7% of the time and within 5 points 98.7%.
//
// Dates: ddate and sub.period are rounded to the nearest month end, while
// the app keys a filing by EDGAR's exact period end - a 52/53-week filer
// ends its quarter on 2026-03-28, not 2026-03-31, and two spellings of one
// period would look like two periods (filings.js filingPeriodKey). So every
// date is snapped back onto a period end the company really filed, by the
// snapper the caller builds from EDGAR's own filing list (dateSnapper).

import { DEFAULT_FORMS } from './filings.ts';
import { classify, pickPrimary } from './statementTypes.ts';
import { compareContexts, pruneColumns } from './statements.ts';
import { zhFor } from './zh.ts';

// The forms the app keeps (filings.js). 10-KT / 10-QT transition reports and
// everything else in the datasets (S-1, 8-K, 11-K …) are left alone.
export const DERA_FORMS = DEFAULT_FORMS;

// `stmt` -> the app's statement type, with a title that classify() maps back
// to that same type: reclassify() re-runs the title classifier on every load,
// so a title it read differently would move the statement to another slot.
const STATEMENTS = {
  BS: ['balance_sheet', 'CONSOLIDATED BALANCE SHEETS'],
  IS: ['income_statement', 'CONSOLIDATED STATEMENTS OF OPERATIONS'],
  CF: ['cash_flow', 'CONSOLIDATED STATEMENTS OF CASH FLOWS'],
  EQ: ['equity', "CONSOLIDATED STATEMENTS OF SHAREHOLDERS' EQUITY"],
  CI: ['comprehensive_income', 'CONSOLIDATED STATEMENTS OF COMPREHENSIVE INCOME'],
};
for (const [stmt, [type, title]] of Object.entries(STATEMENTS)) {
  if (classify(title) !== type) throw new Error(`dera: the title for ${stmt} classifies as ${classify(title)}, not ${type}`);
}

// num.txt / pre.txt name a tag by (tag, version): 'us-gaap/2025' for a
// standard one, the accession itself for the filer's own extension. The app
// spells a concept prefix:Tag, and what SEC calls 'ifrs' the app (and the
// filings themselves) call 'ifrs-full'.
const NAMESPACE = { ifrs: 'ifrs-full' };
export function conceptOf(tag, version, ownPrefix) {
  const i = version.indexOf('/');
  if (i < 0) return `${ownPrefix}:${tag}`;
  const ns = version.slice(0, i);
  return `${NAMESPACE[ns] || ns}:${tag}`;
}

// The prefix the filer's own extension tags get: the instance document is
// named after it ('aapl-20260328_htm.xml', 'aapl-20111231.xml').
export const ownPrefixOf = (instance) => (/^([A-Za-z][A-Za-z0-9_.-]*?)-\d{8}/.exec(instance || '')?.[1] || 'ext').toLowerCase();

// num.txt gives the unit of measure but not the kind of number; tag.txt's
// datatype does. The app reads a unit with a '/' as per-share (not scalable,
// only approximately subtractable) and 'shares' / 'pure' as counts and
// ratios (quarters.js subtractability, StatementTable scalable), so the two
// have to be spelled the way the Inline XBRL parse spells them.
const UNIT_OF = {
  perShare: (uom) => `${uom}/shares`,
  perUnit: (uom) => `${uom}/unit`,
  shares: () => 'shares',
  percent: () => 'pure',
  pure: () => 'pure',
  decimal: () => 'pure',
  integer: () => 'pure',
};
export const unitOf = (uom, datatype) => (UNIT_OF[datatype] ? UNIT_OF[datatype](uom) : uom || null);

// 'BusinessSegments=AmericasSegment;ConsolidationItems=OperatingSegments;'
// SEC drops the namespace prefixes and the Axis / Member suffixes; they go
// back on (under a 'dera:' prefix, since the real ones are not recoverable)
// so the column groups and reads like any other. null = unparseable, which
// is what a segments string too long for the field looks like once SEC has
// truncated it: that column is dropped rather than guessed at.
export function parseSegments(s) {
  if (!s) return {};
  const out = {};
  for (const part of s.split(';')) {
    if (!part) continue;
    const i = part.indexOf('=');
    if (i <= 0) return null;
    out[`dera:${part.slice(0, i)}Axis`] = `dera:${part.slice(i + 1)}Member`;
  }
  return out;
}

const iso = (yyyymmdd) => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
const addDay = (d) => new Date(new Date(`${d}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);
const subDay = (d) => new Date(new Date(`${d}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);
// the month end `quarters` quarters before a month end (ddate is always one)
function monthEndBack(yyyymmdd, quarters) {
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6));
  return new Date(Date.UTC(y, m - quarters * 3, 0)).toISOString().slice(0, 10);
}

// DERA rounds every date to a month end. `snap` puts it back on the period
// end the company really filed when one is within a fortnight (rounding can
// move a date by at most half a month), else leaves it as it is.
export function dateSnapper(periodEnds, days = 15) {
  const list = [...new Set(periodEnds.filter(Boolean))].sort();
  if (!list.length) return (d) => d;
  const ms = list.map((d) => Date.parse(`${d}T00:00:00Z`));
  const window = days * 86400000;
  return (d) => {
    const t = Date.parse(`${d}T00:00:00Z`);
    let lo = 0;
    let hi = ms.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ms[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    let best = null;
    for (const i of [lo - 1, lo, lo + 1]) {
      if (i < 0 || i >= ms.length) continue;
      const gap = Math.abs(ms[i] - t);
      if (gap <= window && (!best || gap < best.gap)) best = { gap, date: list[i] };
    }
    return best ? best.date : d;
  };
}

// A cash-flow or equity statement lists the same balance twice, once as the
// opening and once as the closing figure. Inline XBRL says which is which
// with a preferred label; DERA does not, so the filer's own wording decides,
// and buildStatement's rule then keeps only the instants that open (resp.
// close) one of the statement's own duration columns.
const PERIOD_START = /\b(beginning|start)\s+(of|balance)|\bbeginning\b.*\bperiod\b|^beginning/i;
const PERIOD_END = /\bend(ing)?\s+(of|balance)|\bend\b.*\bperiod\b|\bclosing balance/i;
function periodRole(label) {
  if (PERIOD_START.test(label || '')) return 'periodStartLabel';
  if (PERIOD_END.test(label || '')) return 'periodEndLabel';
  return null;
}

// buildStatement's own rule, on the columns this statement kept: an opening
// balance is dated the day *before* a duration column starts.
function trimRollForward(lineItems, used) {
  const durations = Object.values(used).filter((c) => !c.instant);
  if (!durations.length) return;
  const starts = new Set(durations.map((c) => subDay(c.start)));
  const ends = new Set(durations.map((c) => c.end));
  for (const item of lineItems) {
    const want = item.preferredLabel === 'periodStartLabel' ? starts : item.preferredLabel === 'periodEndLabel' ? ends : null;
    if (!want) continue;
    item.values = Object.fromEntries(Object.entries(item.values).filter(([id]) => !used[id]?.instant || want.has(used[id].instant)));
    if (item.labelZh) item.labelZh += want === starts ? '（期初）' : '（期末）';
  }
}

const IN_CURRENCY = new Set(['monetary', 'perShare', 'perUnit']); // datatypes whose unit of measure is a currency

// The currency the filing reports in. A foreign private issuer often adds a
// convenience translation of its latest year into USD - the same rows, the
// same period, a second currency - and a statement here (like the parsed
// kind) holds one value per row and column, with no room for the second. So
// whichever currency most of the filing's money is in is the one kept, and
// the translation is dropped. null when there is no money in it at all.
export function mainCurrency(num, tagOf) {
  const by = new Map();
  for (const r of num) {
    if (r.coreg || tagOf(r.tag, r.version)?.datatype !== 'monetary') continue;
    by.set(r.uom, (by.get(r.uom) || 0) + 1);
  }
  let best = null;
  for (const [uom, count] of by) if (!best || count > best.count) best = { uom, count };
  return best?.uom ?? null;
}

// One filing's statements, in the shape scrape.js produces and store.js saves.
//
//   filing   EDGAR's own record of the filing (accession, form, filingDate,
//            reportDate, primaryDocument and the URLs) - the authority for
//            everything but the numbers
//   sub      its sub.txt row: { name, instance, fy, fp }
//   pre      its pre.txt rows: { report, line, stmt, inpth, tag, version,
//            plabel, negating }, any order
//   num      its num.txt rows: { tag, version, ddate, qtrs, uom, segments,
//            coreg, value }, any order
//   tagOf    (tag, version) -> { datatype, tlabel, doc } from tag.txt
//   snap     a dateSnapper over the company's real period ends
//
// Returns null when the submission presents none of the four statements
// (a filing that only amends the exhibits, say): there is nothing to save.
export function deraResult({ filing, sub, pre, num, tagOf, snap = (d) => d, dataset = null, fetchedAt = new Date().toISOString() }) {
  const own = ownPrefixOf(sub.instance);
  const currency = mainCurrency(num, tagOf);

  // ---- the columns, and every number in one of them ----
  const contexts = new Map(); // ddate|qtrs|segments -> context
  const facts = new Map(); // concept -> [{ ctx, value, unit, nil }]
  let factCount = 0;
  for (const r of num) {
    if (r.coreg) continue; // a co-registrant's own figures, not this filer's
    if (currency && r.uom !== currency && IN_CURRENCY.has(tagOf(r.tag, r.version)?.datatype)) continue;
    const key = `${r.ddate}|${r.qtrs}|${r.segments}`;
    let ctx = contexts.get(key);
    if (ctx === undefined) {
      const dims = parseSegments(r.segments);
      const end = snap(iso(r.ddate));
      ctx = dims && {
        id: `c${contexts.size + 1}`,
        dimensions: dims,
        ...(r.qtrs === 0 ? { instant: end } : { start: addDay(snap(monthEndBack(r.ddate, r.qtrs))), end }),
      };
      contexts.set(key, ctx || null);
    }
    if (!ctx) continue;
    const concept = conceptOf(r.tag, r.version, own);
    const info = tagOf(r.tag, r.version);
    const unit = unitOf(r.uom, info?.datatype);
    const cell = r.value === '' ? { ctx, value: null, unit, nil: true } : { ctx, value: Number(r.value), unit };
    if (cell.value !== null && !Number.isFinite(cell.value)) continue;
    const list = facts.get(concept);
    if (list) list.push(cell);
    else facts.set(concept, [cell]);
    factCount++;
  }

  // ---- one statement per `report` ----
  const byReport = new Map();
  for (const p of pre) {
    if (!STATEMENTS[p.stmt]) continue; // UN: the notes, which the app never shows as statements
    const list = byReport.get(p.report);
    if (list) list.push(p);
    else byReport.set(p.report, [p]);
  }

  const all = [];
  for (const report of [...byReport.keys()].sort((a, b) => a - b)) {
    const rows = byReport.get(report).sort((a, b) => a.line - b.line);
    const [type, baseTitle] = STATEMENTS[rows[0].stmt];
    const parenthetical = rows[0].inpth === 1;
    // Which statement declares which axis is in the presentation linkbase,
    // which the datasets do not carry - so a dimensional number would land
    // on every statement that names its concept (segment revenue on the
    // income statement, for one). Only the equity roll-forward, which is
    // dimensional by construction, takes them.
    const dimensional = type === 'equity';

    const used = {};
    const lineItems = [];
    for (const row of rows) {
      const concept = conceptOf(row.tag, row.version, own);
      const info = tagOf(row.tag, row.version);
      const item = {
        concept,
        label: row.plabel || info?.tlabel || row.tag,
        labelStandard: info?.tlabel || null,
        documentation: info?.doc || null,
        ...zhFor(concept),
        preferredLabel: periodRole(row.plabel),
        negated: row.negating === 1,
        depth: 0,
        abstract: false,
        values: {},
      };
      const cells = facts.get(concept) || [];
      const plain = dimensional ? cells : cells.filter((f) => !Object.keys(f.ctx.dimensions).length);
      // A filer that tags a line only per segment or per share class shows no
      // total for it; quarters.js adds the members up instead (rolledUp),
      // which it can only do if the member columns are there. So a row with
      // nothing undimensioned keeps its dimensional numbers - and only such
      // a row does, or the segment note would land on the income statement.
      for (const f of plain.length ? plain : cells) {
        used[f.ctx.id] = f.ctx;
        item.values[f.ctx.id] = f.nil ? { value: null, unit: f.unit, nil: true } : { value: f.value, unit: f.unit };
      }
      if (Object.keys(item.values).length) lineItems.push(item);
    }
    if (!lineItems.length) continue;

    trimRollForward(lineItems, used);

    const axes = {};
    for (const c of Object.values(used)) for (const [a, m] of Object.entries(c.dimensions)) (axes[a] ||= new Set()).add(m);
    const counts = Object.fromEntries(Object.keys(used).map((id) => [id, 0]));
    for (const item of lineItems) for (const id of Object.keys(item.values)) counts[id]++;
    const columns = pruneColumns(Object.values(used).sort(compareContexts), counts);
    const keep = new Set(columns.map((c) => c.id));
    for (const item of lineItems) item.values = Object.fromEntries(Object.entries(item.values).filter(([id]) => keep.has(id)));

    all.push({
      type,
      title: parenthetical ? `${baseTitle} (PARENTHETICAL)` : baseTitle,
      role: `dera:report${report}`,
      parenthetical,
      axes: Object.fromEntries(Object.entries(axes).map(([a, m]) => [a, [...m].sort()])),
      columns: columns.map((c) => ({
        id: c.id,
        period: c.instant ? { instant: c.instant } : { start: c.start, end: c.end },
        dimensions: c.dimensions,
      })),
      lineItems,
    });
  }
  if (!all.length) return null;

  return {
    fetchedAt,
    filing: {
      // where these numbers came from. It sits in the header because that is
      // the part the store can read back without unpacking the statements
      // (store.filingHeader), and the crawler asks the question of every
      // filing it walks past: a rebuild is a stand-in, to be replaced the
      // moment something can parse the document itself.
      source: 'dera',
      dataset,
      cik: filing.cik,
      companyName: sub.name || null,
      form: filing.form,
      filingDate: filing.filingDate || null,
      periodEnd: filing.reportDate || null,
      fiscalYear: sub.fy || null,
      fiscalPeriod: sub.fp || null,
      accession: filing.accession,
      primaryDocument: filing.primaryDocument || null,
      documentUrl: filing.documentUrl || null,
      viewerUrl: filing.viewerUrl || null,
      indexUrl: filing.indexUrl || null,
    },
    dei: {},
    coverShares: [],
    units: {},
    statements: pickPrimary(all),
    allStatements: all,
    stats: {
      facts: factCount,
      contexts: contexts.size,
      statementRoles: all.length,
    },
  };
}
