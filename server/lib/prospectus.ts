// The financial statements of a company that has only just gone public, read
// out of its prospectus.
//
// The first 10-Q or 10-K of an IPO is months away - a registration statement
// that carries the third quarter makes the 10-K of the next spring the first
// periodic report - and until then the only statements there are stand in
// the prospectus (424B4, or the S-1 / F-1 before it). SEC does not ask for
// XBRL in an initial registration statement: EDGAR flags such an S-1 as
// Inline XBRL, but what is tagged is the filing-fee exhibit. So there is
// nothing for ixbrl.ts to read, and the statements are read here the way
// they are printed: as HTML tables.
//
// What that takes, in order:
//
//   1. find them. The same headings stand all over a prospectus (summary
//      data, MD&A, pro forma); the real ones follow the index of the
//      financial statements that precedes the auditor's report.
//   2. read the grid: which cells are numbers, which column they are in, and
//      what period the headings above that column say it covers. A column
//      that says no period (or says "pro forma") is not read.
//   3. name the rows. The dictionary built from tagged filings (rowLabels.ts)
//      gives the concept, whether its filers show it with the sign flipped,
//      and whether it can be negative at all; a row it does not know keeps
//      its label under an extension concept, as a filer would tag it.
//   4. check the result against the arithmetic every statement obeys. A
//      balance sheet that does not balance, a cash flow whose parts do not
//      sum, an income statement whose bottom line is not the cash flow's top
//      one were misread somewhere: better no statement than a wrong one.
//
// One prospectus reports several periods (two or three years and an interim
// one); each that has a balance sheet becomes a filing of its own, cut to
// the columns a 10-K or 10-Q of that period would show.

import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { filingUrls, fiscalLabel, periodAccession } from './filings.ts';
import { firstSection, lookupLabel, normLabel, sectionOf } from './rowLabels.ts';
import type { LabelEntry, LabelFile, LabelledType, Section } from './rowLabels.ts';
import { pickPrimary } from './statementTypes.ts';
import { zhFor } from './zh.ts';
import type { Concept, FactValue, IsoDate, LineItem, ScrapeResult, Statement, StatementColumn } from './types.ts';

// ---- the document: tables, and the lines of text between them ----

/** A cell: its text and the grid columns it covers. */
interface Cell {
  text: string;
  from: number;
  to: number;
  /** points of left padding, which is how a filer shows the hierarchy */
  indent: number;
}

/** A table and the text since the one before it. */
interface Block {
  html: string;
  /** its text, for a look at what it is before the grid is built */
  text: string;
  before: string[];
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', minus: '−', euro: '€', pound: '£', yen: '¥', thinsp: ' ', ensp: ' ', emsp: ' ', zwnj: '', shy: '' };
const decode = (s: string): string =>
  s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? all;
    const code = e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    // &#146; and its like are windows-1252, whatever the page says it is in
    if (code >= 128 && code < 160) return new TextDecoder('windows-1252').decode(Uint8Array.of(code));
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
  });
const squash = (s: string): string => s.replace(/[\s  -​ ﻿]+/g, ' ').trim();
// A block ends a line. An inline tag does not even end a word: the anchor a
// table of contents points at stands inside the heading ("B<a …></a>alance
// Sheets").
const linesOf = (html: string): string[] =>
  decode(html.replace(/[\r\n]+/g, ' ').replace(/<\/?(?:p|div|table|tr|td|th|h\d|br|hr|li|title)\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, ''))
    .split('\n')
    .map(squash)
    .filter(Boolean);
const plain = (html: string): string => linesOf(html).join(' ');

// Only the outermost tables: a few filer agents wrap a page in one.
function blocksOf(html: string): Block[] {
  const out: Block[] = [];
  const re = /<(\/?)table\b[^>]*>/gi;
  let depth = 0;
  let start = 0;
  let end = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (!m[1]) {
      if (depth++ === 0) start = m.index;
    } else if (depth > 0 && --depth === 0) {
      const table = html.slice(start, re.lastIndex);
      out.push({ html: table, text: plain(table), before: linesOf(html.slice(end, start)) });
      end = re.lastIndex;
    }
  }
  return out;
}

function gridOf(html: string): Cell[][] {
  const $ = cheerio.load(html);
  $('sup, script, style').remove();
  $('br').replaceWith(' ');
  $('p, div').append(' ');
  const rows: Cell[][] = [];
  $('tr').each((_, tr) => {
    const row: Cell[] = [];
    let at = 0;
    $(tr)
      .children('td, th')
      .each((_i, td) => {
        const span = Math.max(1, Number($(td).attr('colspan')) || 1);
        const text = squash($(td).text());
        if (text) {
          const styles = [$(td).attr('style'), ...$(td).find('[style]').slice(0, 3).map((_j, x) => $(x).attr('style')).get()].join(';');
          // a hanging indent (padding and a negative text-indent) is no indent
          const pad = [...styles.matchAll(/(?:(?:padding|margin)-left|text-indent):\s*(-?[\d.]+)(pt|px|em)/gi)].reduce((s, p) => s + Number(p[1]) * (p[2] === 'em' ? 10 : p[2] === 'px' ? 0.75 : 1), 0);
          row.push({ text, from: at, to: at + span - 1, indent: Math.max(0, pad) });
        }
        at += span;
      });
    if (row.length) rows.push(row);
  });
  return rows;
}

// ---- numbers ----

const CURRENCY_SIGN = /(?:US|HK|NT|A|C|S|R|CA|AU)?\$|[€£¥₩₪₹]|\b(?:RMB|USD|EUR|GBP|CHF|SEK|NOK|DKK|NIS|CAD|AUD|JPY|KRW|TWD|HKD|INR|BRL|ILS)\b/g;

// The number a cell shows: undefined when it shows none. A dash is a zero,
// and a percentage is not an amount.
export function cellNumber(text: string): number | undefined {
  const s = text.replace(CURRENCY_SIGN, '').replace(/\s+/g, ' ').trim();
  if (/^\(?\s*[-–—−‒]+\s*\)?$/.test(s)) return 0;
  const m = /^(\()?\s*([-–−])?\s*(\(?)\s*((?:\d{1,3}(?:[, ]\d{3})+|\d+)(?:\.\d+)?|\.\d+)\s*\)*$/.exec(s);
  if (!m) return undefined;
  const value = Number(m[4]!.replace(/[, ]/g, ''));
  if (!Number.isFinite(value)) return undefined;
  return m[1] || m[2] || m[3] ? (value ? -value : 0) : value;
}
const isYear = (text: string): boolean => /^(?:FY\s?)?(?:19|20)\d\d$/.test(text.replace(CURRENCY_SIGN, '').replace(/[()*]/g, '').trim());

// ---- what a column covers ----

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH = '(jan(?:uary|\\.)?|feb(?:ruary|\\.)?|mar(?:ch|\\.)?|apr(?:il|\\.)?|may|june?\\.?|july?\\.?|aug(?:ust|\\.)?|sept?(?:ember|\\.)?|oct(?:ober|\\.)?|nov(?:ember|\\.)?|dec(?:ember|\\.)?)';
const MDY = new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:\\s*,?\\s*((?:19|20)\\d\\d)\\b)?`, 'gi');
const DMY = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}\\b(?:\\s*,?\\s*((?:19|20)\\d\\d)\\b)?`, 'gi');
const YEAR = /\b((?:19|20)\d\d)\b/;

/** A day, with the year when the text gives one. */
interface PartialDate {
  month: number;
  day: number;
  year: number | null;
}
const pad2 = (n: number) => String(n).padStart(2, '0');
const isoOf = (y: number, m: number, d: number): IsoDate => `${y}-${pad2(m)}-${pad2(Math.min(d, new Date(Date.UTC(y, m, 0)).getUTCDate()))}`;
const addDays = (d: IsoDate, n: number): IsoDate => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// The date a text names: one with its year rather than one without, and the
// last of those - a heading reads from the general to the column's own.
function dateIn(text: string): PartialDate | null {
  const all = [
    ...[...text.matchAll(MDY)].map((a) => ({ month: a[1]!, day: a[2]!, year: a[3], at: a.index })),
    ...[...text.matchAll(DMY)].map((b) => ({ month: b[2]!, day: b[1]!, year: b[3], at: b.index })),
  ].sort((a, b) => a.at - b.at);
  const m = all.filter((x) => x.year).at(-1) ?? all.at(-1);
  if (!m) return null;
  const month = MONTHS.findIndex((x) => x.startsWith(m.month.toLowerCase().replace('.', '').slice(0, 3))) + 1;
  const day = Number(m.day);
  return month && day >= 1 && day <= 31 ? { month, day, year: m.year ? Number(m.year) : null } : null;
}

const COUNTS: Record<string, number> = { three: 3, six: 6, nine: 9, twelve: 12, '3': 3, '6': 6, '9': 9, '12': 12 };
const WEEKS: Record<string, number> = { twelve: 12, thirteen: 13, sixteen: 16, 'twenty-four': 24, 'twenty-six': 26, 'twenty-eight': 28, 'thirty-six': 36, 'thirty-nine': 39, forty: 40, 'fifty-two': 52, 'fifty-three': 53 };

// how long a duration ends with the given date runs, as the heading words it
function lengthIn(text: string): { months?: number; weeks?: number } | null {
  const mo = /\b(three|six|nine|twelve|3|6|9|12)[- ]months?\b/i.exec(text);
  if (mo) return { months: COUNTS[mo[1]!.toLowerCase()]! };
  const wk = /\b(\d{2}|[a-z]+(?:-[a-z]+)?)[- ]weeks?\b/i.exec(text);
  const weeks = wk ? Number(wk[1]) || WEEKS[wk[1]!.toLowerCase()] : undefined;
  if (weeks) return weeks >= 52 ? { months: 12, weeks } : { weeks };
  if (/\bquarters?\s+ended\b/i.test(text)) return { months: 3 };
  if (/\bhalf[- ]years?\b/i.test(text)) return { months: 6 };
  if (/\byears?[- ]+end(?:ed|ing)\b|\b(?:fiscal|financial) years?\b|\bfiscal\s+(?:19|20)\d\d\b|\bfor the years?\b|\byears?\b(?=[^a-z]*(?:19|20)\d\d)/i.test(text)) return { months: 12 };
  return null;
}

const startOf = (end: IsoDate, months: number): IsoDate => {
  const [y, m, d] = end.split('-').map(Number) as [number, number, number];
  if (d === new Date(Date.UTC(y, m, 0)).getUTCDate()) return new Date(Date.UTC(y, m - months, 1)).toISOString().slice(0, 10);
  // a year that ends on a weekday, not a month end: whole weeks
  return addDays(end, 1 - Math.round((months * 30.4375) / 7) * 7);
};

// columns that are somebody's arithmetic, not a reported period
const NOT_REPORTED = /pro[\s-]*forma|as adjusted|adjustments?\b|\bchanges?\b|variance|increase|decrease|%|convenience|translat|eliminat|consolidating|\bpercent/i;

type Period = StatementColumn['period'];

// The period a column's heading names. `context` is what the statement says
// above the table ("For the years ended December 31, 2025 and 2024"), for a
// heading that is only a year; `instant` is whether the statement is one of
// balances. `ends` are the balance sheet dates printed before it: a 52/53-week
// filer may head its years with the year alone.
export function periodIn(heading: string, context: string, instant: boolean, ends: readonly IsoDate[] = []): Period | null {
  if (NOT_REPORTED.test(heading)) return null;
  // "Period from March 5, 2025 (inception) through December 31, 2025"
  const span = /\bfrom\b(.*?)\b(?:through|to|until)\b(.*)$/i.exec(heading);
  const from = span && dateIn(span[1]!);
  const to = span && dateIn(span[2]!);
  if (from && to) {
    const year = to.year ?? Number(YEAR.exec(span![2]!)?.[1] || 0);
    const first = from.year ?? year;
    return year ? (instant ? { instant: isoOf(year, to.month, to.day) } : { start: isoOf(first, from.month, from.day), end: isoOf(year, to.month, to.day) }) : null;
  }
  const own = dateIn(heading);
  const date = own ?? dateIn(context);
  // a date in the heading carries its own year; otherwise the last year named
  const year = own?.year ?? Number([...heading.matchAll(/\b((?:19|20)\d\d)\b/g)].at(-1)?.[1] || 0);
  if (!year) return null;
  if (!date) {
    // the fiscal year of a date is that of the fortnight before it
    const len = lengthIn(heading) ?? lengthIn(context);
    if (instant || len?.months !== 12) return null;
    const known = ends.map((d) => ({ d, y: Number(addDays(d, -15).slice(0, 4)) })).sort((a, b) => Math.abs(a.y - year) - Math.abs(b.y - year))[0];
    if (!known || Math.abs(known.y - year) > 2) return null;
    const end = known.y === year ? known.d : /-(?:12-31|0[1-9]-3[01]|1[0-2]-3[01])$/.test(known.d) ? isoOf(Number(known.d.slice(0, 4)) + year - known.y, Number(known.d.slice(5, 7)), Number(known.d.slice(8))) : addDays(known.d, (year - known.y) * 364);
    return { start: startOf(end, 12), end };
  }
  const end = isoOf(year, date.month, date.day);
  if (instant) return { instant: end };
  const len = lengthIn(heading) ?? lengthIn(context);
  if (!len) return null;
  return { start: len.weeks ? addDays(end, 1 - len.weeks * 7) : startOf(end, len.months!), end };
}

// ---- units ----

/** What one printed unit stands for. */
interface Units {
  money: number;
  shares: number;
  currency: string;
  /** the document says so, rather than leaves it to the other statements */
  given: boolean;
}
const SCALE: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9 };
const scaleIn = (s: string): number | null => {
  const m = /\b(thousand|million|billion)s?\b/i.exec(s) || /(?:['’]000|\b000)s?\b/.exec(s);
  return m ? (m[1] ? SCALE[m[1].toLowerCase()]! : 1e3) : null;
};
const CURRENCIES: [string, RegExp][] = [
  ['USD', /US\s?\$|U\.S\.\s+dollars?|\bUSD\b|United States dollars?/i],
  ['CNY', /\bRMB\b|Renminbi|\bCNY\b/i],
  ['TWD', /NT\s?\$|New Taiwan/i],
  ['HKD', /HK\s?\$|\bHKD\b|Hong Kong dollars?/i],
  ['CAD', /\bCA?D?\s?\$|Canadian dollars?|\bCAD\b/i],
  ['AUD', /\bAU?\s?\$|Australian dollars?|\bAUD\b/i],
  ['EUR', /€|\bEUR\b|\beuros?\b/i],
  ['GBP', /£|\bGBP\b|pounds sterling/i],
  ['JPY', /¥|\bJPY\b|\byen\b/i],
  ['KRW', /₩|\bKRW\b|Korean won/i],
  ['ILS', /₪|\bNIS\b|\bILS\b|shekels?/i],
  ['CHF', /\bCHF\b|Swiss francs?/i],
  ['SEK', /\bSEK\b|Swedish kron/i],
  ['NOK', /\bNOK\b|Norwegian kron/i],
  ['DKK', /\bDKK\b|Danish kron/i],
  ['INR', /₹|\bINR\b|Indian rupees?/i],
  ['BRL', /R\$|\bBRL\b|Brazilian rea/i],
  ['SGD', /S\$|\bSGD\b|Singapore dollars?/i],
];
const currencyIn = (s: string): string | null => CURRENCIES.find(([, re]) => re.test(s))?.[0] ?? null;

// "(In millions, except share amounts which are in thousands, and per share
// data)": the first scale is the money's. Shares go by the same one unless
// the line excepts them - and then by their own when it gives one.
export function unitsIn(lines: readonly string[]): Units {
  const line = lines.find((l) => scaleIn(l) != null && (/\bin\b|amounts?|express|stated|['’]000|\bunits?\b/i.test(l) || /^\(?(?:us\$|u\.s\. dollars?|\$|€|£)?\s*(?:thousand|million|billion)s?\b/i.test(l))) || '';
  const money = scaleIn(line) ?? 1;
  const [, except = ''] = /\b(?:except|other than)\b(.*)$/i.exec(line) || [];
  const own = /\bshares?\b[^,;)]*?\b(?:thousand|million)s?\b/i.exec(except)?.[0];
  const excepted = /\bshares?\b|\bunits?\b/i.test(except.replace(/\b(?:per|loss per|earnings per)[- ](?:ordinary |common )?(?:share|unit|ads)s?\b/gi, ''));
  const shares = own ? scaleIn(own)! : excepted ? 1 : money;
  return { money, shares, currency: currencyIn(line) ?? lines.map(currencyIn).find(Boolean) ?? 'USD', given: !!line };
}

// ---- one statement as printed ----

/** A printed row: its label, and its number in each column that has one. */
interface PrintedRow {
  label: string;
  indent: number;
  /** by column; empty for a heading */
  values: (number | undefined)[];
}

/** A statement as the document prints it, before its rows have names. */
interface Printed {
  type: LabelledType;
  title: string;
  /** the lines above its heading: whose statement this is */
  context: string[];
  /** the heading and the lines below it: the period, the units */
  under: string[];
  periods: (Period | null)[];
  units: Units;
  rows: PrintedRow[];
}

const LEAD = '(?:(?:un)?audited|condensed|interim|consolidated|combined|carve[- ]?out|abbreviated|group|the|and|\\s)*';
const TITLES: [LabelledType | 'other', RegExp][] = [
  ['cash_flow', new RegExp(`^${LEAD}statements? of ${LEAD}cash[- ]?flows?\\b|^${LEAD}cash[- ]?flow statements?\\b`, 'i')],
  ['balance_sheet', new RegExp(`^${LEAD}balance[- ]sheets?\\b|^${LEAD}statements? of ${LEAD}(?:financial (?:position|condition)|assets and liabilities)\\b`, 'i')],
  ['other', new RegExp(`^${LEAD}statements? of ${LEAD}(?:other )?comprehensive (?:income|loss|\\(loss\\)|earnings)(?!.*\\b(?:operations|profit)\\b)`, 'i')],
  ['other', new RegExp(`^${LEAD}statements? of ${LEAD}(?:changes|redeemable|convertible|mezzanine|temporary|stockholders|shareholders|members|partners|equity|owners)`, 'i')],
  ['income_statement', new RegExp(`^${LEAD}statements? of ${LEAD}(?:net )?(?:operations|income|loss|\\(loss\\)|earnings|profit)|^${LEAD}income statements?\\b`, 'i')],
];
const CONTINUED = /\bcontinued\b/i;
const NOT_A_TITLE = /\bdata\b|percentage|selected|summary|parenthetical|schedule|\.{4}|\bF-\d+\s*$|\bnotes? to\b/i;

/** What a line is the heading of; 'other' is a statement that is not read. */
interface Title {
  type: LabelledType | 'other';
  title: string;
}

// a heading, not a sentence that happens to start with the same words
function titleOf(line: string): Title | null {
  if (line.length > 170 || !/^[A-Z(]/.test(line) || NOT_A_TITLE.test(line.replace(/\((?!parenthetical)[^)]*(?:\)|$)/gi, ''))) return null;
  // "ACME, INC. AND SUBSIDIARIES CONSOLIDATED BALANCE SHEETS"
  const named = /^.{0,90}?\b(?:INC\.?|CORP\.?|LTD\.?|LLC|L\.?P\.?|PLC|COMPANY|SUBSIDIARIES|SUBSIDIARY)\W+((?:CONSOLIDATED|CONDENSED|COMBINED|UNAUDITED|BALANCE|STATEMENT)\b.*)$/.exec(line)?.[1];
  if (named) return titleOf(named);
  const hit = TITLES.find(([, re]) => re.test(line));
  if (!hit) return null;
  // "… of operations in the period they are incurred": prose goes on in lower case
  const rest = line.replace(hit[1], '').replace(/\(.*?\)/g, '');
  if (/\b(?:is|are|was|were|have|has|been|which|that|within|included|recorded|recognized|as a)\b/.test(rest) || /[.;:]$/.test(line)) return null;
  return { type: hit[0], title: line };
}

// The nearest heading to the end of some lines, which may be set over two of
// them ("Consolidated Statements" / "of Financial Position").
function lastTitle(lines: readonly string[]): (Title & { at: number }) | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const own = titleOf(lines[i]!);
    if (own) return { ...own, at: i };
    const two = i > 0 && lines[i - 1]!.length < 60 ? titleOf(`${lines[i - 1]} ${lines[i]}`) : null;
    if (two) return { ...two, at: i - 1 };
  }
  return null;
}

const CONTENT: Record<LabelledType, RegExp> = {
  balance_sheet: /\btotal assets\b|total liabilities|\bassets\b.*\bcash\b/i,
  income_statement: /\bnet (?:income|loss|\(loss\)|earnings|profit|\(income\))|(?:loss|profit|income|\(loss\))[^.]{0,25} for the (?:year|period|financial)|operating (?:expenses|loss|income)|formation and operating costs|\bincome tax/i,
  cash_flow: /operating activities|financing activities|end of (?:the )?(?:year|period)/i,
};

// the notes follow the statements: nothing under their heading carries one on
const NOTES = /^(?:[a-z]+ )?notes to (?:the )?(?:(?:un)?audited |condensed |consolidated |combined |interim )*financial statements/i;

// A statement of comprehensive income that starts at the revenue is the
// income statement; one that starts at the net result is not read.
const WHOLE_INCOME = /\brevenues?\b|\bsales\b|operating (?:expenses|loss|profit|income|costs)|research and development|general and administrative|administrative expenses/i;
// the registrant alone, without its subsidiaries: a schedule in the notes
const PARENT_ONLY = /parent[- ]company|parent[- ]only|\(parent\)|financial information of (?:the )?(?:registrant|company|parent)/i;

const UNIT_LABEL = /^\(?(?:\s*(?:amounts?|all|stated|expressed|presented|in|us|u\.s\.|dollars?|\$|€|£)\b.*)?(?:thousands?|millions?)|^\(?(?:un)?audited\)?$|^\(?in\b.*\)?$/i;
const PERIOD_WORDS = new RegExp(`\\b${MONTH}\\s+\\d|\\b(?:ended|ending)\\b|\\bas (?:of|at)\\b|\\bmonths?\\b|\\bfiscal\\b|pro forma|unaudited|\\bnotes?\\b|\\bperiod from\\b|successor|predecessor|^years?\\b`, 'i');

// the cells of a row that are numbers: "$", "(" and ")" may each have a cell
// of their own, and a label never counts
function numbersOf(row: readonly Cell[]): { cell: Cell; value: number }[] {
  const out: { cell: Cell; value: number }[] = [];
  row.forEach((cell, i) => {
    if (i === 0 && cell.from === 0 && !/^[\d($—–-]/.test(cell.text)) return;
    const value = cellNumber(cell.text);
    if (value === undefined) return;
    // the parenthesis of a negative in the cell before
    out.push({ cell, value: row[i - 1]?.text === '(' && value > 0 ? -value : value });
  });
  return out;
}

const isHeaderRow = (row: readonly Cell[]): boolean => {
  const nums = row.filter((c) => cellNumber(c.text) !== undefined);
  if (nums.length && nums.every((c) => isYear(c.text))) return true;
  if (nums.some((c) => !isYear(c.text))) return false;
  if (row.some((c) => c.from > 0 && PERIOD_WORDS.test(c.text))) return true;
  return row.every((c) => UNIT_LABEL.test(c.text) || PERIOD_WORDS.test(c.text) || currencyIn(c.text) === null ? UNIT_LABEL.test(c.text) || PERIOD_WORDS.test(c.text) : c.text.length < 12);
};

// The table as columns and rows; null when it is not a table of numbers.
function readTable(type: LabelledType, html: string, context: readonly string[], cols: number | null, ends: readonly IsoDate[]): { periods: (Period | null)[]; headings: string[]; rows: PrintedRow[] } | null {
  const grid = gridOf(html);
  // the headings end with the last of them above the first number; between
  // the two stand the headings of the statement's own sections
  let first = 0;
  for (let i = 0; i < grid.length; i++) {
    if (isHeaderRow(grid[i]!)) first = i + 1;
    else if (numbersOf(grid[i]!).length) break;
  }
  const head = grid.slice(0, first).filter((row) => row.length > 1 || !titleOf(row[0]!.text));
  const notes = head.flat().filter((c) => /^notes?\.?$/i.test(c.text));
  const body = grid.slice(first).map((row) => ({ row, nums: numbersOf(row).filter(({ cell }) => !notes.some((x) => cell.from <= x.to && cell.to >= x.from)) }));

  // The columns: where the fullest rows have their numbers.
  const counts = new Map<number, number>();
  for (const { nums } of body) if (nums.length) counts.set(nums.length, (counts.get(nums.length) || 0) + 1);
  if (!counts.size) return null;
  const rowsWith = [...counts.values()].reduce((a, b) => a + b, 0);
  const width = [...counts].filter(([, c]) => c >= Math.max(2, rowsWith * 0.15) || counts.size === 1).map(([k]) => k);
  const n = Math.max(...(width.length ? width : [...counts.keys()]));
  const full = body.filter((b) => b.nums.length === n);
  const at = Array.from({ length: n }, (_, k) => {
    const xs = full.map((b) => b.nums[k]!.cell.to).sort((a, b) => a - b);
    return xs[Math.floor(xs.length / 2)]!;
  });

  // What stands above each column, top to bottom. A row of as many headings
  // as there are columns is one each, a single heading is everybody's, and
  // one that spans covers the columns below it, wherever the number sits in
  // its span. (A column of its own date still goes by that: dateIn.)
  const headings: string[] = Array.from({ length: n }, () => '');
  const left = at[0]! - 1;
  for (const row of head) {
    const cells = row.filter((c) => c.to >= Math.min(left, at[0]!) && !(c.from === 0 && c.to < left - 1));
    if (!cells.length) continue;
    if (cells.length === n) {
      cells.forEach((c, k) => (headings[k] += ` ${c.text}`));
      continue;
    }
    const gap = (c: Cell, x: number) => (x < c.from ? c.from - x : x > c.to ? x - c.to : 0);
    for (let k = 0; k < n; k++) {
      const over = cells.reduce((best, c) => (gap(c, at[k]!) < gap(best, at[k]!) ? c : best));
      if (cells.length === 1 || gap(over, at[k]!) <= 3) headings[k] += ` ${over.text}`;
    }
    // too few headings over the columns they belong to (no colspan): share
    // the columns out evenly
    if (cells.length < n && n % cells.length === 0 && !cells.some((c) => at.some((x) => gap(c, x) <= 3))) {
      for (let k = 0; k < n; k++) headings[k] += ` ${cells[Math.floor((k * cells.length) / n)]!.text}`;
    }
  }
  const ctx = context.join(' · ');
  const single = n === 1 ? ctx : '';
  let periods = headings.map((h) => periodIn(h || single, ctx, type === 'balance_sheet', ends));
  // a column of note references, and a translation for the reader's convenience
  const foreign = headings.map((h) => currencyIn(h));
  const kept = foreign.find((c) => c && c !== 'USD');
  periods = periods.map((p, k) => (/\bnotes?\b/i.test(headings[k]!) && !dateIn(headings[k]!) ? null : kept && foreign[k] === 'USD' ? null : p));
  // the same period twice is a pro forma column that does not say so
  const told = periods.map((p) => (p ? JSON.stringify(p) : null));
  periods = periods.map((p, k) => (p && told.indexOf(told[k]!) === k ? p : null));
  // a continuation may repeat no headings: the caller has the columns
  if (!periods.some(Boolean) && cols !== n) return null;

  const indents = [...new Set(body.map((b) => Math.round(b.row[0]!.indent)))].sort((a, b) => a - b);
  const rows: PrintedRow[] = [];
  for (const { row, nums } of body) {
    const label = squash(
      row
        // the label; not a currency sign or a list of notes ("4,24,31") after it
        .filter((c, i) => (nums.length ? c.to < nums[0]!.cell.from : true) && cellNumber(c.text) === undefined && (i === 0 ? /[a-z]/i.test(c.text) : /[a-z]{3}/i.test(c.text)))
        .map((c) => c.text)
        .join(' '),
    );
    const values: (number | undefined)[] = Array.from({ length: n }, () => undefined);
    if (nums.length === n) nums.forEach((x, k) => (values[k] = x.value));
    else {
      for (const x of nums) {
        let best = 0;
        for (let k = 1; k < n; k++) if (Math.abs(at[k]! - x.cell.to) < Math.abs(at[best]! - x.cell.to)) best = k;
        values[best] ??= x.value;
      }
    }
    const indent = indents.indexOf(Math.round(row[0]!.indent));
    if (!label && nums.length && rows.length && !rows.at(-1)!.values.some((v) => v !== undefined)) {
      // the numbers of a label broken over two rows
      rows.at(-1)!.values = values;
    } else if (label || nums.length) rows.push({ label, indent, values });
  }
  return { periods, headings, rows };
}

// Every statement of the document's financial pages, in the order printed.
// A statement broken over pages is put back together.
export function printedStatements(html: string): Printed[] {
  const blocks = blocksOf(html);
  // the financial pages: from the last index of financial statements before
  // the first auditor's report (interim statements may come first)
  const opinion = blocks.findIndex((b) => b.before.some((l) => /^opinions? on the (?:\w+ )?financial statements?/i.test(l)) || /\bopinions? on the (?:consolidated |combined )?financial statements\b/i.test(b.text.slice(0, 4000)));
  const index = (b: Block) => b.before.some((l) => /^index to\b.*\bfinancial (?:statements|information)/i.test(l)) || /^index to\b.*\bfinancial (?:statements|information)/i.test(b.text);
  let from = 0;
  if (opinion > 0) for (let i = opinion; i >= 0; i--) if (index(blocks[i]!)) {
    from = i;
    break;
  }
  if (!from) from = Math.max(0, opinion < 0 ? blocks.findIndex(index) : opinion - 12);

  const out: Printed[] = [];
  let open = null as Printed | null;
  let recent: string[] = [];
  let ends: IsoDate[] = []; // the balance sheet dates of the set being read
  for (const b of blocks.slice(from)) {
    const notes = b.before.findLastIndex((l) => NOTES.test(l));
    // prose between two tables: the second does not carry the first one on
    if (notes >= 0 || b.before.reduce((n, l) => n + l.length, 0) > 700) open = null;
    recent = [...(notes >= 0 ? [] : recent), ...b.before.slice(notes + 1)].slice(-40);
    const top = linesOf(b.html.slice(0, 20000)).slice(0, 12);
    // the nearest heading: in the text above, else in the table's own first rows
    const above = lastTitle(recent);
    const inside = above ? null : lastTitle(top);
    let title: Title | null = above || inside;
    if (title?.type === 'other' && /comprehensive/i.test(title.title) && WHOLE_INCOME.test(b.text)) title = { type: 'income_statement', title: title.title };
    // a table with no heading since the last one carries that statement on
    const type: LabelledType | 'other' | null = title ? title.type : (open?.type ?? null);
    const layout = () => {
      if (b.text.length < 400 && !/\d[\d,]{3}/.test(b.text.replace(/\b(?:19|20)\d\d\b/g, ''))) recent.push(...linesOf(b.html).slice(0, 10));
      else recent = [];
    };
    if (!type || type === 'other') {
      if (title) open = null;
      layout();
      continue;
    }
    // whose statement it is stands above the heading; what it covers and in
    // what units stands in the heading and below it
    const over = title ? (above ? recent.slice(Math.max(0, above.at - 4), above.at) : recent.slice(-4)) : open!.context;
    const under: string[] = title ? (above ? recent.slice(above.at) : top) : open!.under;
    if (!CONTENT[type].test(b.text) && !(open?.type === type && /\d/.test(b.text))) {
      // a logo, a page header, the heading itself: keep reading
      if (b.text.length >= 400) open = null;
      layout();
      continue;
    }
    // under its heading again a statement goes on over the page; without one,
    // only until its last line (what follows is a footnote's table)
    const last = out.at(-1)?.type === type ? out.at(-1)! : null;
    const going: Printed | null = title ? (open === last || last?.title === title.title || CONTINUED.test(title.title) ? last : null) : open && !ended(open) ? open : null;
    const read = readTable(type, b.html, under, going ? going.periods.length : null, ends);
    recent = [];
    if (!read || PARENT_ONLY.test([...over, ...under].join(' '))) {
      if (!going) open = null;
      continue;
    }
    const onto = going && columnsOnto(going.periods, read.periods);
    if (going && onto) {
      going.rows.push(...read.rows.map((r) => ({ ...r, values: onto.map((k) => (k < 0 ? undefined : r.values[k])) })));
      continue;
    }
    if (!read.periods.some(Boolean) || !title) {
      open = null;
      continue;
    }
    open = { type, title: title.title, context: over, under, periods: read.periods, units: unitsIn([...under, ...top, ...over]), rows: read.rows };
    const currency = read.headings.map(currencyIn).find((c, k) => c && read.periods[k]);
    if (currency) open.units.currency = currency;
    if (type === 'balance_sheet') ends = read.periods.flatMap((p) => p?.instant ?? []);
    out.push(open);
  }
  return out;
}

// "Total liabilities, redeemable convertible preferred stock, and
// stockholders' deficit" (or the equity first)
const TOTAL_LE_LINE = /^total (?:liabilities\b.*\b(?:equity|deficit|deficiency|capital|investment)\b|(?:equity|shareholders|stockholders|members|net parent|parent)\b.*\bliabilities\b)/;
const endOf = (p: Period): IsoDate => (p.instant ?? p.end)!;
// which of a continuation's columns is each of the statement's: by the
// periods it heads them with, or in order when it repeats no headings
function columnsOnto(open: readonly (Period | null)[], more: readonly (Period | null)[]): number[] | null {
  if (!more.some(Boolean)) return open.length === more.length ? open.map((_, k) => k) : null;
  const keys = more.map((p) => (p ? JSON.stringify(p) : null));
  const onto = open.map((p) => (p ? keys.indexOf(JSON.stringify(p)) : -1));
  const want = open.filter(Boolean).length;
  return onto.filter((k) => k >= 0).length === want && keys.filter(Boolean).length === want ? onto : null;
}
const hasValue = (r: PrintedRow): boolean => r.values.some((v) => v !== undefined);
const ended = (p: Printed): boolean => p.rows.some((r) => hasValue(r) && LAST_LINE[p.type].test(normLabel(r.label)));
const LAST_LINE: Record<LabelledType, RegExp> = {
  balance_sheet: TOTAL_LE_LINE,
  income_statement: /\bper (?:\w+ ){0,3}(?:share|unit|ads)\b|^weighted average/,
  cash_flow: /^cash\b.*\bend(?:ing)?\b.*(?:year|period)/,
};

// ---- naming the rows ----


// What the dictionary may not have the exact wording of, and nothing
// downstream works without.
const FALLBACK: Record<string, [LabelledType, Section | null, RegExp, string][]> = {
  'us-gaap': [
    ['balance_sheet', null, /^total assets$/, 'Assets+'],
    ['balance_sheet', null, /^total current assets$/, 'AssetsCurrent+'],
    ['balance_sheet', null, /^total current liabilities$/, 'LiabilitiesCurrent+'],
    ['balance_sheet', null, /^total liabilities$/, 'Liabilities+'],
    ['balance_sheet', 'ca', /^cash and cash equivalents/, 'CashAndCashEquivalentsAtCarryingValue+'],
    ['balance_sheet', 'ca', /^(?:accounts|trade) receivable/, 'AccountsReceivableNetCurrent+'],
    ['balance_sheet', null, /^property (?:plant )?(?:and )?equipment.* net/, 'PropertyPlantAndEquipmentNet+'],
    ['balance_sheet', 'cl', /^accounts payable(?: and)? accrued/, 'AccountsPayableAndAccruedLiabilitiesCurrent+'],
    ['balance_sheet', null, /subject to possible redemption|^(?:series .*)?redeemable|^convertible preferred stock|redeemable convertible/, 'TemporaryEquityCarryingAmountAttributableToParent+'],
    ['balance_sheet', null, /^additional paid in capital/, 'AdditionalPaidInCapital+'],
    ['balance_sheet', null, /^(?:accumulated deficit|retained earnings)/, 'RetainedEarningsAccumulatedDeficit'],
    ['balance_sheet', 'eq', /^total (?:stockholders|shareholders|members|partners|owners).*(?:equity|deficit|deficiency|capital)/, 'StockholdersEquity'],
    ['balance_sheet', 'eq', /^total (?:equity|deficit)$/, 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
    ['income_statement', 'is', /^(?:total )?(?:net )?(?:revenues?|sales)(?: net)?$|^total (?:net )?(?:revenues?|sales)/, 'Revenues'],
    ['income_statement', 'is', /^(?:total )?costs? of (?:net )?(?:revenues?|sales|goods sold|goods and services)(?: sold)?(?: (?:exclusive|inclusive|excluding|including|exclud|includ).*)?$/, 'CostOfRevenue+'],
    ['income_statement', 'is', /^gross (?:profit|loss|margin)/, 'GrossProfit'],
    ['income_statement', 'is', /^total operating expenses/, 'OperatingExpenses+'],
    ['income_statement', 'is', /^total costs and expenses/, 'CostsAndExpenses+'],
    ['income_statement', 'is', /^(?:net )?(?:loss|income|profit|income loss|loss income)(?: from operations)$|^(?:total )?operating (?:loss|income|profit|income loss|loss income)$/, 'OperatingIncomeLoss'],
    ['income_statement', 'is', /^(?:net )?(?:loss|income|earnings|income loss|loss income|profit)\b.*\bbefore\b.*\b(?:tax|taxes)\b/, 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest'],
    ['income_statement', 'is', /^(?:total )?(?:provision|benefit|expense|income tax).*\b(?:tax|taxes|provision|expense|benefit)\b/, 'IncomeTaxExpenseBenefit'],
    ['income_statement', 'is', /^net (?:loss|income|earnings|income loss|loss income|profit)(?: and comprehensive (?:loss|income|income loss|loss income))?$/, 'NetIncomeLoss'],
    ['income_statement', 'eps', /\bper\b.*\bbasic and diluted\b|\bbasic and diluted\b.*\bper\b/, 'EarningsPerShareBasicAndDiluted'],
    ['income_statement', 'eps', /\bdiluted\b/, 'EarningsPerShareDiluted'],
    ['income_statement', 'eps', /\bbasic\b/, 'EarningsPerShareBasic'],
    ['income_statement', 'sh', /\bbasic and diluted\b/, 'WeightedAverageNumberOfShareOutstandingBasicAndDiluted+'],
    ['income_statement', 'sh', /\bdiluted\b/, 'WeightedAverageNumberOfDilutedSharesOutstanding+'],
    ['income_statement', 'sh', /\bbasic\b/, 'WeightedAverageNumberOfSharesOutstandingBasic+'],
    ['cash_flow', 'op', /^net cash.*operating activities/, 'NetCashProvidedByUsedInOperatingActivities'],
    ['cash_flow', 'inv', /^net cash.*investing activities/, 'NetCashProvidedByUsedInInvestingActivities'],
    ['cash_flow', 'fin', /^net cash.*financing activities/, 'NetCashProvidedByUsedInFinancingActivities'],
    ['cash_flow', 'op', /^net (?:loss|income|earnings|income loss|loss income)$/, 'NetIncomeLoss'],
    ['cash_flow', 'op', /^depreciation/, 'DepreciationDepletionAndAmortization+'],
    ['cash_flow', 'op', /^(?:stock|share|equity) based compensation/, 'ShareBasedCompensation+'],
    ['cash_flow', 'inv', /^(?:purchases?|acquisitions?|additions?) (?:of|to) (?:property|fixed assets|equipment)|^capital expenditures?/, 'PaymentsToAcquirePropertyPlantAndEquipment-+'],
    ['cash_flow', 'fin', /^proceeds from (?:the )?(?:issuance|sale|issuance and sale) of (?:class \w+ )?common (?:stock|shares)(?: net.*)?$/, 'ProceedsFromIssuanceOfCommonStock+'],
  ],
  'ifrs-full': [
    ['balance_sheet', null, /^total assets$/, 'Assets+'],
    ['balance_sheet', null, /^total current assets$/, 'CurrentAssets+'],
    ['balance_sheet', null, /^total non current assets$/, 'NoncurrentAssets+'],
    ['balance_sheet', null, /^total current liabilities$/, 'CurrentLiabilities+'],
    ['balance_sheet', null, /^total non current liabilities$/, 'NoncurrentLiabilities+'],
    ['balance_sheet', null, /^total liabilities$/, 'Liabilities+'],
    ['balance_sheet', null, /^cash and cash equivalents/, 'CashAndCashEquivalents+'],
    ['balance_sheet', null, /^inventor(?:y|ies)/, 'Inventories+'],
    ['balance_sheet', null, /^property plant and equipment/, 'PropertyPlantAndEquipment+'],
    ['balance_sheet', null, /^total (?:shareholders |stockholders )?(?:equity|deficit|capital deficiency)(?: deficit)?$/, 'Equity'],
    ['income_statement', 'is', /^(?:total )?(?:net )?(?:revenues?|sales)(?: from contracts with customers)?$/, 'Revenue+'],
    ['income_statement', 'is', /^costs? of (?:revenues?|sales|goods sold)/, 'CostOfSales+'],
    ['income_statement', 'is', /^gross (?:profit|loss|margin)/, 'GrossProfit'],
    ['income_statement', 'is', /^operating (?:loss|income|profit|profit loss|loss profit|result)$|^(?:loss|profit|profit loss) from operat/, 'ProfitLossFromOperatingActivities'],
    ['income_statement', 'is', /^(?:net )?(?:loss|income|profit|result|profit loss|loss profit|income loss|loss income)\b.*\bbefore\b.*\b(?:tax|taxes|taxation)\b/, 'ProfitLossBeforeTax'],
    ['income_statement', 'is', /^(?:income )?tax(?:ation|es)?\b|^income tax/, 'IncomeTaxExpenseContinuingOperations'],
    ['income_statement', 'is', /^(?:net )?(?:loss|profit|income|results?|profit loss|loss profit|income loss|loss income)(?: for the (?:year|period|financial).*| from continuing operations)?$/, 'ProfitLoss'],
    ['income_statement', 'eps', /\bdiluted\b/, 'DilutedEarningsLossPerShare'],
    ['income_statement', 'eps', /\bbasic\b/, 'BasicEarningsLossPerShare'],
    ['cash_flow', 'op', /^net cash.*operating activities/, 'CashFlowsFromUsedInOperatingActivities'],
    ['cash_flow', 'inv', /^net cash.*investing activities/, 'CashFlowsFromUsedInInvestingActivities'],
    ['cash_flow', 'fin', /^net cash.*financing activities/, 'CashFlowsFromUsedInFinancingActivities'],
    ['cash_flow', 'inv', /^(?:purchases?|acquisitions?|additions?) (?:of|to) (?:property|fixed assets|equipment)|^capital expenditures?/, 'PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities-+'],
  ],
};

let labelFile: LabelFile | null = null;
const labels = (): LabelFile => (labelFile ??= JSON.parse(fs.readFileSync(new URL('../data/labels.json', import.meta.url), 'utf8')) as LabelFile);

function nameOf(taxonomy: string, type: LabelledType, section: Section, label: string): LabelEntry | null {
  if (type === 'balance_sheet' && TOTAL_LE_LINE.test(label)) return { concept: `${taxonomy}:${taxonomy === 'us-gaap' ? 'LiabilitiesAndStockholdersEquity' : 'EquityAndLiabilities'}`, negated: false, positive: true };
  const known = lookupLabel(labels(), taxonomy, type, section, label);
  if (known) return known;
  const f = FALLBACK[taxonomy]!.find(([t, s, re]) => t === type && (!s || s === section) && re.test(label));
  const m = f && /^(\w+?)(-?)(\+?)$/.exec(f[3]);
  return m ? { concept: `${taxonomy}:${m[1]}`, negated: !!m[2], positive: !!m[3] } : null;
}

// the extension a filer would make for a row of its own, from its label
function extensionOf(prefix: string, label: string): Concept {
  const words = normLabel(label).split(' ').filter(Boolean);
  const name = words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join('').slice(0, 90);
  return `${prefix}:${name || `Row${createHash('sha1').update(label).digest('hex').slice(0, 8)}`}`;
}

/** A named row: the concept, and how far the printed number is from the raw one. */
interface NamedRow extends PrintedRow {
  key: string; // normalised label
  section: Section;
  concept: Concept;
  flip: boolean;
  kind: 'money' | 'perShare' | 'shares';
  role: 'periodStartLabel' | 'periodEndLabel' | null;
}

const PERIOD_START = /\bbeginning\b|\bstart of\b|\bopening\b/;
const PERIOD_END = /\bend of\b|\bend\b.*\b(?:period|year)\b|\bending\b|\bclosing\b/;

function nameRows(p: Printed, taxonomy: string, prefix: string): NamedRow[] {
  let at = firstSection(p.type);
  const seen = new Set<string>();
  return p.rows.map((r) => {
    const key = normLabel(r.label);
    const [section, next] = sectionOf(p.type, at, key);
    at = next;
    const role = p.type === 'cash_flow' && /cash/.test(key) ? (PERIOD_START.test(key) ? 'periodStartLabel' as const : PERIOD_END.test(key) ? 'periodEndLabel' as const : null) : null;
    const entry = hasValue(r) ? nameOf(taxonomy, p.type, section, key) : null;
    let concept = entry?.concept ?? extensionOf(prefix, r.label);
    // one row per concept, but for the balance a cash flow opens and closes with
    const slot = `${concept}|${role ?? ''}`;
    if (hasValue(r)) {
      if (seen.has(slot)) {
        const own = extensionOf(prefix, r.label);
        concept = own;
        for (let i = 2; seen.has(`${concept}|${role ?? ''}`); i++) concept = `${own}${i}`;
      }
      seen.add(`${concept}|${role ?? ''}`);
    }
    const kind = p.type !== 'income_statement' ? ('money' as const) : section === 'eps' ? ('perShare' as const) : section === 'sh' ? ('shares' as const) : ('money' as const);
    const shown = r.values.filter((v): v is number => !!v);
    const below = shown.filter((v) => v < 0).length;
    const standard = entry && concept === entry.concept ? entry : null;
    // a figure that is never negative and is printed in parentheses is one
    // the filer subtracts; for the rest the filers of that row decide
    const flip = standard ? (standard.positive ? below > shown.length / 2 : standard.negated) : false;
    return { ...r, key, section, concept, flip, kind, role };
  });
}

// ---- the statements of one filing ----

/** What the arithmetic of a set of statements is checked with. */
const near = (a: number, b: number, unit: number, slack = 2): boolean => Math.abs(a - b) <= Math.max(unit * slack, Math.abs(b) * 1e-6) + 1e-9;
const rowBy = (rows: readonly NamedRow[], ...names: string[]): NamedRow | undefined => names.map((n) => rows.find((r) => hasValue(r) && r.concept.endsWith(`:${n}`))).find(Boolean);
const rowLike = (rows: readonly NamedRow[], re: RegExp): NamedRow | undefined => rows.find((r) => hasValue(r) && re.test(r.key));

// a line of the income statement's end: net income, before or after tax, all
// of it or the owners' share
const isBottom = (r: NamedRow): boolean => hasValue(r) && r.kind === 'money' && (NET_INCOME.some((x) => r.concept.endsWith(`:${x}`)) || /^(?:consolidated )?net (?:loss|income|earnings|profit|result)|^(?:total )?(?:loss|profit|income(?! tax)|results?|earnings)\b.*\b(?:year|period|tax|taxes|taxation|attributable|continuing operations)\b/.test(r.key));
const NET_INCOME = ['NetIncomeLoss', 'ProfitLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic'];

// Does column k of this statement add up? `income` is the other statements'
// net income for the same period, where they have it.
function adds(p: Printed, rows: readonly NamedRow[], k: number): boolean {
  const v = (r: NamedRow | undefined) => r?.values[k];
  if (p.type === 'balance_sheet') {
    const assets = v(rowBy(rows, 'Assets') ?? rowLike(rows, /^total assets/));
    const both = v(rowBy(rows, 'LiabilitiesAndStockholdersEquity', 'EquityAndLiabilities'));
    if (assets === undefined || !assets) return false;
    if (both !== undefined) return near(both, assets, 1);
    const liabilities = v(rowBy(rows, 'Liabilities'));
    const equity = v(rowBy(rows, 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest', 'StockholdersEquity', 'Equity'));
    return liabilities !== undefined && equity !== undefined && near(liabilities + equity, assets, 1);
  }
  if (p.type === 'cash_flow') {
    const ops = v(rowBy(rows, 'NetCashProvidedByUsedInOperatingActivities', 'CashFlowsFromUsedInOperatingActivities') ?? rowLike(rows, /net cash.*operating|cash.*operating activities$/));
    const inv = v(rowBy(rows, 'NetCashProvidedByUsedInInvestingActivities', 'CashFlowsFromUsedInInvestingActivities') ?? rowLike(rows, /net cash.*investing|cash.*investing activities$/)) ?? 0;
    const fin = v(rowBy(rows, 'NetCashProvidedByUsedInFinancingActivities', 'CashFlowsFromUsedInFinancingActivities') ?? rowLike(rows, /net cash.*financing|cash.*financing activities$/)) ?? 0;
    if (ops === undefined) return false;
    const open = v(rows.find((r) => r.role === 'periodStartLabel' && hasValue(r)));
    const close = v(rows.find((r) => r.role === 'periodEndLabel' && hasValue(r)));
    const fx = rows.filter((r) => hasValue(r) && /exchange|translation/.test(r.key) && r.section === 'end').reduce((s, r) => s + (v(r) ?? 0), 0);
    const net = v(rowLike(rows, /^net (?:change|increase|decrease|\(decrease\)|increase decrease|decrease increase)/) ?? rowLike(rows, /^(?:net )?(?:increase|decrease|change)\b.*\bcash/));
    if (open !== undefined && close !== undefined) return near(open + ops + inv + fin + fx, close, 1, 3) || (net !== undefined && near(open + net, close, 1, 3) && near(ops + inv + fin, net, 1, 3)) || near(open + ops + inv + fin, close, 1, 3);
    return net !== undefined && (near(ops + inv + fin, net, 1, 3) || near(ops + inv + fin + fx, net, 1, 3));
  }
  return rows.some((r) => isBottom(r) && v(r) !== undefined);
}

// The income statement's bottom line is the cash flow's top line. A filer
// that prints its losses as plain numbers ("Net loss 1,531") is put right
// here: the cash flow has the sign.
function reconcile(is: Printed, isRows: NamedRow[], cf: Printed | null, cfRows: readonly NamedRow[]): (k: number) => boolean {
  // the cash flow's top line, when it is one of those (an IFRS filer may
  // start at the profit before tax, or at the cash generated)
  const top = cfRows.slice(0, 12).find((r) => hasValue(r) && (isBottom(r) || /^(?:loss|profit|result)\b/.test(r.key)));
  const bottom = isRows.filter(isBottom);
  const pairs = (): [number, number][] => {
    const out: [number, number][] = [];
    is.periods.forEach((p, i) => cf?.periods.forEach((q, j) => p && q && p.end === q.end && p.start === q.start && out.push([i, j])));
    return out;
  };
  const same = pairs().filter(([, j]) => top?.values[j]);
  const scale = cf ? cf.units.money / is.units.money : 1;
  const opposite = same.length > 0 && same.every(([i, j]) => bottom.some((r) => r.values[i] !== undefined && near(-r.values[i]! , top!.values[j]! * scale, 1, 1)) && !bottom.some((r) => r.values[i] !== undefined && near(r.values[i]!, top!.values[j]! * scale, 1, 1)));
  if (opposite) for (const r of isRows) if (hasValue(r) && /\bloss\b/.test(r.key) && !/\bincome\b|\bgain\b|\bprofit\b/.test(r.key) && r.kind !== 'shares') r.flip = !r.flip;
  return (k) => {
    const hit = same.filter(([i]) => i === k);
    if (!hit.length) return bottom.some((r) => r.values[k] !== undefined);
    return hit.some(([i, j]) => bottom.some((r) => r.values[i] !== undefined && (near(r.values[i]!, top!.values[j]! * scale, 1, 1) || near(-r.values[i]!, top!.values[j]! * scale, 1, 1))));
  };
}

// With a minority in the business "Net loss" is everybody's, and the line
// after the minority's share is the parent's.
function splitNetIncome(rows: NamedRow[], taxonomy: string): void {
  if (taxonomy !== 'us-gaap') return;
  const minority = rows.findIndex((r) => hasValue(r) && r.kind === 'money' && /non ?controlling|minority/.test(r.key));
  if (minority < 0) return;
  const all = rows.slice(0, minority).filter((r) => hasValue(r) && /^(?:consolidated )?net (?:loss|income|earnings|income loss|loss income)$/.test(r.key)).at(-1);
  const parent = rows.slice(minority + 1).find((r) => hasValue(r) && r.kind === 'money' && /^net (?:loss|income|earnings)\b.*\battributable to\b/.test(r.key) && !/preferred|redeemable|non ?controlling/.test(r.key));
  if (all) all.concept = 'us-gaap:ProfitLoss';
  for (const r of rows) if (r !== parent && r.concept === 'us-gaap:NetIncomeLoss') r.concept = r === all ? r.concept : `ext:${r.concept.slice(8)}Before`;
  if (parent) parent.concept = 'us-gaap:NetIncomeLoss';
}

// Whether share counts are printed in full, in thousands or in millions is
// the one thing the units line leaves open most often ("in thousands, except
// per share amounts", over a full count). The statement itself says: the
// result over the per-share amount is the count.
function scaleShares(p: Printed, rows: readonly NamedRow[]): void {
  const count = rows.find((r) => r.kind === 'shares' && r.values.some(Boolean));
  const eps = rows.find((r) => r.kind === 'perShare' && r.values.some(Boolean));
  const net = rows.filter((r) => isBottom(r) && !/before/.test(r.key));
  if (!count || !eps) return;
  let best: { scale: number; off: number } | null = null;
  for (let k = 0; k < p.periods.length; k++) {
    if (!p.periods[k] || !count.values[k] || !eps.values[k]) continue;
    for (const r of net) {
      if (!r.values[k]) continue;
      const implied = Math.abs((r.values[k]! * p.units.money) / eps.values[k]!);
      for (const scale of [1, 1e3, 1e6]) {
        const off = Math.abs(Math.log(implied / (count.values[k]! * scale)));
        if (!best || off < best.off) best = { scale, off };
      }
    }
  }
  if (best && best.off < Math.log(3)) p.units.shares = best.scale;
}

// an income tax the filer prints as a subtraction: pre-tax less tax is net
function signTax(rows: NamedRow[], periods: readonly (Period | null)[]): void {
  const tax = rows.find((r) => hasValue(r) && /:IncomeTaxExpense/.test(r.concept));
  const pre = rows.find((r) => hasValue(r) && /BeforeIncomeTaxes|ProfitLossBeforeTax/.test(r.concept));
  const net = rowBy(rows, 'ProfitLoss', 'NetIncomeLoss');
  if (!tax || !pre || !net) return;
  // the first column that settles it (another line may stand between the two)
  for (let k = 0; k < periods.length; k++) {
    if (!periods[k] || !tax.values[k] || pre.values[k] === undefined || net.values[k] === undefined) continue;
    const [t, b, n] = [tax.values[k]!, pre.values[k]! * (pre.flip ? -1 : 1), net.values[k]! * (net.flip ? -1 : 1)];
    if (near(b - t, n, 1) === near(b + t, n, 1)) continue;
    tax.flip = near(b + t, n, 1);
    return;
  }
}

// ---- the filings of one prospectus ----

/** The document, as EDGAR lists it. */
export interface ProspectusFiling {
  cik: number;
  accession: string;
  form: string;
  filingDate: IsoDate;
  primaryDocument: string;
}

/** Whose prospectus it is. */
export interface ProspectusCompany {
  name?: string | null;
  tickers?: string[];
  fiscalYearEnd?: string | null;
}

const nameKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Whether the lines above a statement name this company. The first word that
// says anything will do: "Anthropic, PBC" over a statement of "Anthropic,
// PBC and subsidiaries".
export function namesCompany(lines: readonly string[], name: string | null | undefined): boolean {
  const words = nameKey(name || '').split(' ').filter((w) => !/^(?:the|inc|corp|co|ltd|plc|llc|holdings?|group|company|limited|sa|ag|nv|ab|se|of|and)$/.test(w));
  const want = words.slice(0, 2).join(' ');
  return !!want && lines.some((l) => nameKey(l).includes(want) || (words[0]!.length >= 5 && nameKey(l).split(' ').includes(words[0]!)));
}

const isIfrs = (html: string, rows: readonly Printed[]): boolean => {
  const gaap = (html.match(/accounting principles generally accepted in the United States|U\.S\. GAAP/g) || []).length;
  const ifrs = (html.match(/International Financial Reporting Standards|IFRS/g) || []).length;
  return ifrs > gaap * 2 && rows.length > 0 && ifrs > 10;
};

/** The statement and the column of it that covers a period. */
interface Located {
  p: Printed;
  rows: NamedRow[];
  ok: (k: number) => boolean;
}

// Every period the prospectus reports, newest first, each as the filing a
// 10-K or 10-Q of it would have been. Empty when nothing in it could be read
// and checked.
export function prospectusResults(html: string, filing: ProspectusFiling, company: ProspectusCompany, { fetchedAt = new Date().toISOString(), ownOnly = false }: { fetchedAt?: string; ownOnly?: boolean } = {}): ScrapeResult[] {
  let printed = printedStatements(html);
  // the statements of a business it bought, or of the shell it merges into,
  // stand in the same pages
  const own = printed.filter((p) => namesCompany([...p.context, ...p.under], company.name));
  if (own.some((p) => p.type === 'balance_sheet')) printed = own;
  else if (ownOnly) return [];
  const taxonomy = isIfrs(html, printed) ? 'ifrs-full' : 'us-gaap';
  const prefix = (company.tickers?.[0] || 'ext').toLowerCase().replace(/[^a-z0-9]/g, '') || 'ext';

  // a date after the filing was read wrong
  for (const p of printed) p.periods = p.periods.map((x) => (x && endOf(x) <= filing.filingDate ? x : null));

  // Statements in sets, as printed (some print the balance sheet first, some
  // the income statement): a set has one of each, with dates in common. The
  // statements of a period are taken from one set, never mixed.
  const sets: Partial<Record<LabelledType, Located>>[] = [];
  for (const p of printed) {
    const rows = nameRows(p, taxonomy, prefix);
    const last = sets.at(-1);
    const ends = new Set(p.periods.flatMap((x) => (x ? [endOf(x)] : [])));
    const fits = last && !last[p.type] && Object.values(last).every((x) => x.p.periods.some((y) => y && ends.has(endOf(y))));
    const set = fits ? last : sets[sets.push({}) - 1]!;
    set[p.type] = { p, rows, ok: (k) => adds(p, rows, k) };
  }
  for (const s of sets) {
    // a statement that does not give its units is in the units of the rest
    const given = Object.values(s).find((x) => x.p.units.given)?.p.units;
    if (given) for (const x of Object.values(s)) if (!x.p.units.given) x.p.units = { ...given };
    const is = s.income_statement;
    if (!is) continue;
    const agrees = reconcile(is.p, is.rows, s.cash_flow?.p ?? null, s.cash_flow?.rows ?? []);
    const base = is.ok;
    is.ok = (k) => base(k) && agrees(k);
    splitNetIncome(is.rows, taxonomy);
    signTax(is.rows, is.p.periods);
    scaleShares(is.p, is.rows);
  }
  // a period is a balance sheet date with an income statement that ends on it
  const dates = new Set<IsoDate>();
  for (const { balance_sheet: b } of sets) b?.p.periods.forEach((p, k) => p?.instant && b.ok(k) && dates.add(p.instant));
  const columnsAt = (at: Located | undefined, date: IsoDate): number[] => (at ? at.p.periods.flatMap((p, k) => (p && endOf(p) === date && at.ok(k) ? [k] : [])) : []);
  const out: ScrapeResult[] = [];
  for (const date of [...dates].sort().reverse()) {
    // the set that tells the most of the period (a shell's statements since
    // it was set up lose to the year of the business it merges with)
    const told = sets
      .map((set) => ({ set, columns: columnsAt(set.income_statement, date), has: columnsAt(set.balance_sheet, date).length > 0 }))
      .filter((x) => x.has && x.columns.length > 0)
      .map((x) => ({ ...x, months: Math.max(...x.columns.map((k) => monthsOf(x.set.income_statement!.p.periods[k]!))) }))
      .sort((a, b) => b.months - a.months)[0];
    if (!told) continue;
    const bs = told.set.balance_sheet!;
    const is = told.set.income_statement!;
    const cf = columnsAt(told.set.cash_flow, date).length ? told.set.cash_flow! : null;
    // the lengths this period is told in (a year; or three and nine months)
    const lengths = new Set(told.columns.map((k) => monthsOf(is.p.periods[k]!)));
    const annual = lengths.has(12);
    // besides the newest period, only whole years: the audit of a shell on the
    // day it was set up is no period anyone compares with
    const label = fiscalLabel(filing.form, date, company.fiscalYearEnd ?? yearEndOf(sets));
    if (!annual && label.fiscalPeriod !== 'FY' && out.length) continue;
    const statements: Statement[] = [
      build(bs, 'balance_sheet', (p) => p.instant! <= date),
      build(is, 'income_statement', (p) => p.end! <= date && (annual ? monthsOf(p) === 12 : lengths.has(monthsOf(p)))),
      ...(cf ? [build(cf, 'cash_flow', (p) => p.end! <= date && (annual ? monthsOf(p) === 12 : monthsOf(p) < 12))] : []),
    ];
    const newest = out.length === 0;
    const urls = filingUrls(filing.cik, filing.accession, filing.primaryDocument, filing.form);
    const facts = statements.reduce((s, st) => s + st.lineItems.reduce((m, li) => m + Object.keys(li.values).length, 0), 0);
    out.push({
      fetchedAt,
      filing: {
        // read off the page, not off tags: the reader is told, and a 10-K or
        // 10-Q of the same period takes its place (filings.ts)
        source: 'prospectus',
        cik: filing.cik,
        companyName: company.name || null,
        form: filing.form,
        filingDate: filing.filingDate,
        periodEnd: date,
        fiscalYear: label.fiscalYear == null ? null : String(label.fiscalYear),
        fiscalPeriod: label.fiscalPeriod,
        accession: newest ? filing.accession : periodAccession(filing.accession, date),
        primaryDocument: filing.primaryDocument,
        documentUrl: urls.documentUrl,
        viewerUrl: urls.viewerUrl,
        indexUrl: urls.indexUrl,
      },
      dei: {},
      coverShares: [],
      units: {},
      statements: pickPrimary(statements),
      allStatements: statements,
      stats: { facts, contexts: new Set(statements.flatMap((st) => st.columns.map((c) => c.id))).size, statementRoles: statements.length },
    });
  }
  return out;
}

const monthsOf = (p: Period): number => Math.round((Date.parse(p.end!) - Date.parse(p.start!)) / 86400000 / 30.4375);

// the fiscal year end the statements themselves show, when EDGAR has none
function yearEndOf(sets: readonly Partial<Record<LabelledType, Located>>[]): string | null {
  for (const s of sets) for (const p of s.income_statement?.p.periods ?? []) if (p?.end && monthsOf(p) === 12) return p.end.slice(5).replace('-', '');
  return null;
}

// A title that the type classifier (statementTypes.ts) reads as the type it
// is: the statements are classified again by title on every load.
const TITLE: Record<LabelledType, string> = {
  balance_sheet: 'CONSOLIDATED BALANCE SHEETS',
  income_statement: 'CONSOLIDATED STATEMENTS OF OPERATIONS',
  cash_flow: 'CONSOLIDATED STATEMENTS OF CASH FLOWS',
};

function build({ p, rows, ok }: Located, type: LabelledType, want: (p: Period) => boolean): Statement {
  const picked = p.periods.map((period, k) => ({ period, k })).filter(({ period, k }) => period && want(period) && ok(k)) as { period: Period; k: number }[];
  picked.sort((a, b) => (endOf(a.period) < endOf(b.period) ? 1 : endOf(a.period) > endOf(b.period) ? -1 : monthsOf(a.period) - monthsOf(b.period)));
  const columns: StatementColumn[] = [];
  const idOf = (period: Period) => (period.instant ? `i${period.instant}` : `d${period.start}_${period.end}`).replace(/-/g, '');
  const instantColumn = (d: IsoDate) => {
    const period: Period = { instant: d };
    const id = idOf(period);
    if (!columns.some((c) => c.id === id)) columns.push({ id, period, dimensions: {} });
    return id;
  };
  for (const { period } of picked) if (!columns.some((c) => c.id === idOf(period))) columns.push({ id: idOf(period), period, dimensions: {} });
  const lineItems: LineItem[] = [];
  const unitOf = (r: NamedRow) => (r.kind === 'perShare' ? `${p.units.currency}/shares` : r.kind === 'shares' ? 'shares' : p.units.currency);
  const scaleOf = (r: NamedRow) => (r.kind === 'perShare' ? 1 : r.kind === 'shares' ? p.units.shares : p.units.money);
  for (const r of rows) {
    const values: Record<string, FactValue> = {};
    for (const { period, k } of picked) {
      const shown = r.values[k];
      if (shown === undefined) continue;
      // the balance a cash flow opens with is dated the day before it starts
      const id = r.role === 'periodStartLabel' ? instantColumn(addDays(period.start!, -1)) : r.role === 'periodEndLabel' ? instantColumn(period.end!) : idOf(period);
      const scaled = shown * scaleOf(r);
      const value = scaled === 0 ? 0 : (r.flip ? -1 : 1) * (Number.isInteger(shown) ? scaled : Number(scaled.toPrecision(15)));
      values[id] ??= { value, raw: null, unit: unitOf(r) };
    }
    const abstract = !hasValue(r);
    if (!abstract && !Object.keys(values).length) continue;
    if (abstract && !r.label) continue;
    const zh = abstract ? {} : zhFor(r.concept);
    lineItems.push({
      concept: abstract ? `${r.concept}Abstract` : r.concept,
      label: r.label,
      labelStandard: null,
      ...zh,
      ...(r.role && 'labelZh' in zh && zh.labelZh ? { labelZh: `${zh.labelZh}${r.role === 'periodStartLabel' ? '（期初）' : '（期末）'}` } : {}),
      preferredLabel: r.role ?? (/^total\b/.test(r.key) ? 'totalLabel' : null),
      negated: r.flip,
      depth: r.indent,
      abstract,
      values,
    });
  }
  return { type, title: TITLE[type], role: `prospectus:${type}`, parenthetical: false, axes: {}, columns, lineItems };
}
