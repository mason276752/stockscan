import test from 'node:test';
import assert from 'node:assert/strict';
import { collapseAmendments, filingPeriodKey, pickFiling } from '../server/lib/filings.ts';
import type { FilingRef, IsoDate } from '../server/lib/types.ts';

// a company's filings as EDGAR lists them: newest filing date first
const f = (accession: string, form: string, filingDate: IsoDate, periodEnd: IsoDate, extra: Partial<FilingRef> = {}): FilingRef => ({
  accession,
  form,
  filingDate,
  periodEnd,
  reportDate: periodEnd,
  fiscalYear: form.startsWith('10-Q') ? 2026 : 2025,
  fiscalPeriod: form.startsWith('10-Q') ? 'Q1' : 'FY',
  ...extra,
});

test('an amendment supersedes the original of its period', () => {
  const list = [f('a2', '10-K/A', '2026-08-14', '2025-12-31'), f('a1', '10-K', '2026-03-01', '2025-12-31'), f('q1', '10-Q', '2026-05-01', '2026-03-31')];
  const kept = collapseAmendments(list);
  assert.deepEqual(kept.map((x) => x.accession), ['a2', 'q1'], 'one filing per period, the corrected one');
  assert.equal(kept.length, 2, 'the original is not a second period');
  assert.equal(pickFiling(list, { year: 2025, period: 'FY' })!.accession, 'a2');
});

test('an amendment with no statements in it corrects nothing', () => {
  // the Part III-only 10-K/A: the build and the server flag it `thin`
  const list = [f('a2', '10-K/A', '2026-08-14', '2025-12-31', { thin: 1 }), f('a1', '10-K', '2026-03-01', '2025-12-31')];
  assert.deepEqual(collapseAmendments(list).map((x) => x.accession), ['a1']);
  assert.equal(pickFiling(list, { year: 2025, period: 'FY' })!.accession, 'a1');
  // the caller can answer it its own way instead (screen.ts passes a score's coverage)
  assert.deepEqual(collapseAmendments(list, () => false).map((x) => x.accession), ['a2'], 'a test that trusts them all');
});

test('two amendments: the last one that has the numbers', () => {
  const list = [f('a3', '10-K/A', '2026-09-01', '2025-12-31', { thin: 1 }), f('a2', '10-K/A', '2026-08-14', '2025-12-31'), f('a1', '10-K', '2026-03-01', '2025-12-31')];
  assert.deepEqual(collapseAmendments(list).map((x) => x.accession), ['a2']);
});

test('with no filing dates the amendment still wins - it can only be the later one', () => {
  // the store's filing index (store.filingIndex) has the form and the period, no dates
  const list = [
    { accession: 'a1', form: '10-K', periodEnd: '2025-12-31' },
    { accession: 'a2', form: '10-K/A', periodEnd: '2025-12-31' },
  ];
  assert.deepEqual(collapseAmendments(list).map((x) => x.accession), ['a2']);
  assert.deepEqual(collapseAmendments([...list].reverse()).map((x) => x.accession), ['a2'], 'whichever order they come in');
});

test('a period is a form and a period end, so a 10-Q and a 10-K do not collapse together', () => {
  assert.equal(filingPeriodKey({ form: '10-K/A', periodEnd: '2025-12-31' }), filingPeriodKey({ form: '10-K', periodEnd: '2025-12-31' }));
  assert.notEqual(filingPeriodKey({ form: '10-Q', periodEnd: '2025-12-31' }), filingPeriodKey({ form: '10-K', periodEnd: '2025-12-31' }));
  assert.notEqual(filingPeriodKey({ form: '10-K', periodEnd: '2024-12-31' }), filingPeriodKey({ form: '10-K', periodEnd: '2025-12-31' }));
  // the store's records call it reportDate, EDGAR's call it periodEnd
  assert.equal(filingPeriodKey({ form: '10-K', reportDate: '2025-12-31' }), filingPeriodKey({ form: '10-K', periodEnd: '2025-12-31' }));
});

test('the list keeps its order, so a newest-first list stays newest-first', () => {
  const list = [f('q1', '10-Q', '2026-05-01', '2026-03-31'), f('a2', '10-K/A', '2026-04-14', '2025-12-31'), f('a1', '10-K', '2026-03-01', '2025-12-31')];
  assert.deepEqual(collapseAmendments(list).map((x) => x.accession), ['q1', 'a2']);
});
