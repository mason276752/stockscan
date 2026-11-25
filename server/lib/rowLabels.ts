// What a row of a financial statement is called, and which XBRL concept rows
// called that usually carry. A prospectus has no tags (prospectus.ts): its
// statements are HTML tables, and all there is to go on is the row's label
// and where on the statement it stands. The answers come from the filings
// that *are* tagged - server/tools/build-labels.mts counts, over the saved
// store, which concept each label was given and writes server/data/labels.json.
//
// The same label means different things in different places ("Deferred
// revenue" is current above "Total current liabilities" and noncurrent below
// it; "Other" is anything at all), so a label is looked up within its section
// of the statement first. The section is read off the labels alone, by the
// same code when the dictionary is built and when a prospectus is read.

import type { Concept } from './types.ts';

/** The statements the dictionary covers. */
export type LabelledType = 'balance_sheet' | 'income_statement' | 'cash_flow';

/** The part of a statement a row stands in. */
export type Section = 'ca' | 'nca' | 'cl' | 'ncl' | 'eq' | 'is' | 'eps' | 'sh' | 'op' | 'inv' | 'fin' | 'end' | 'sup';

// A label as the dictionary spells it: no case, no punctuation, no note
// references or footnote marks, and nothing from the par value on (a stock line goes on to
// recite the authorised and issued share counts, different in every filing).
export const normLabel = (label: string | null | undefined): string =>
  (label || '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/'s\b/g, '')
    .replace(/\((?:see )?notes?[^)]*\)/g, ' ')
    .replace(/\((?:\d{1,2}|[a-z])\)/g, ' ')
    .replace(/[,;:]?\s*\(?(?:no par|(?:us)?\$\s*[\d.,]+|[\d.]+ par|par value|without par).*$/, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export const firstSection = (type: LabelledType): Section => (type === 'balance_sheet' ? 'ca' : type === 'cash_flow' ? 'op' : 'is');

// The section a row stands in, and the one the rows after it do. `label` is
// normalised.
export function sectionOf(type: LabelledType, at: Section, label: string): [own: Section, next: Section] {
  if (type === 'balance_sheet') {
    if (/^total current assets/.test(label)) return ['ca', 'nca'];
    if (/^total assets/.test(label)) return ['nca', 'cl'];
    if (/^total current liabilities/.test(label)) return ['cl', 'ncl'];
    if (/^total (liabilities|equity) .*(equity|deficit|deficiency|capital|liabilities)/.test(label)) return ['eq', 'eq'];
    if (/^total liabilities$/.test(label)) return ['ncl', 'eq'];
    if (/^(total )?(stockholders?|shareholders?|members?|partners?|owners).*(equity|deficit|deficiency|capital)( deficit)?$/.test(label)) return ['eq', 'eq'];
    return [at, at];
  }
  if (type === 'cash_flow') {
    if (/net cash.*operating/.test(label)) return ['op', 'inv'];
    if (/net cash.*investing/.test(label)) return ['inv', 'fin'];
    if (/net cash.*financing/.test(label)) return ['fin', 'end'];
    if (/operating activities/.test(label)) return ['op', 'op'];
    if (/investing activities/.test(label)) return ['inv', 'inv'];
    if (/financing activities/.test(label)) return ['fin', 'fin'];
    if (/supplement|non ?cash (investing|financing|activit|transaction)/.test(label)) return ['sup', 'sup'];
    return [at, at];
  }
  // "Basic" and "Diluted" under "Net loss per share" are amounts, under
  // "Weighted-average shares" they are counts
  // ("Weighted-average shares used to compute net loss per share" counts too)
  const perShare = /\bper (\w+ ){0,3}(share|unit|ads)\b/.test(label);
  if (/weighted average|shares (used|outstanding)|number of (common |ordinary )?shares/.test(label) && !/^(basic |diluted |and )*(net )?(loss|income|earnings|profit)( \w+)? per\b/.test(label)) return ['sh', 'sh'];
  if (perShare) return ['eps', 'eps'];
  return [at, at];
}

/** What the dictionary says about one label. */
export interface LabelEntry {
  concept: Concept;
  /** filers of this row show the raw value with its sign flipped */
  negated: boolean;
  /** the raw value of this concept is (all but) never negative */
  positive: boolean;
}

/** labels.json: taxonomy prefix -> `<type>|<section>|<label>` -> `<concept><flags>`. */
export type LabelFile = Record<string, Record<string, string>>;

// 'PaymentsToAcquirePropertyPlantAndEquipment-+': the flags follow the name
const FLAGGED = /^([A-Za-z0-9]+)(-?)(\+?)$/;
export const packEntry = (name: string, negated: boolean, positive: boolean): string => `${name}${negated ? '-' : ''}${positive ? '+' : ''}`;

export function lookupLabel(dict: LabelFile, taxonomy: string, type: LabelledType, section: Section, label: string): LabelEntry | null {
  const own = dict[taxonomy];
  const packed = own?.[`${type}|${section}|${label}`] ?? own?.[`${type}||${label}`];
  const m = packed && FLAGGED.exec(packed);
  return m ? { concept: `${taxonomy}:${m[1]}`, negated: !!m[2], positive: !!m[3] } : null;
}
