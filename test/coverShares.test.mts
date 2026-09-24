import test from 'node:test';
import assert from 'node:assert/strict';
import { coverSharesOf, parseInlineXbrl } from '../server/lib/ixbrl.ts';
import { coverSharesFor, indexCoverShares, mergeCoverShareIndexes } from '../server/lib/coverShares.ts';
import type { Concept, IsoDate, XbrlContext, XbrlFact } from '../server/lib/types.ts';

const context = (id: string, { entity = '0001652044', instant = '2026-07-15', dimensions = {} }: { entity?: string; instant?: IsoDate; dimensions?: Record<Concept, Concept> } = {}): XbrlContext => ({ id, entity, instant, start: null, end: null, dimensions });
const fact = (contextRef: string, value: number, name: Concept = 'dei:EntityCommonStockSharesOutstanding') => ({ name, contextRef, unitRef: 'shares', numeric: true, value }) as XbrlFact;

const shares = (contexts: Record<string, XbrlContext>, facts: XbrlFact[]) => coverSharesOf({ contexts, units: { shares: 'shares' }, facts });

test('parser retains a scaled cover class sum as compact metadata', () => {
  const doc = parseInlineXbrl(`<html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL" xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:xbrldi="http://xbrl.org/2006/xbrldi" xmlns:dei="http://x">
    <xbrli:context id="a"><xbrli:entity><xbrli:identifier>0001652044</xbrli:identifier><xbrli:segment><xbrldi:explicitMember dimension="dei:EntityCommonStockClassAxis">dei:ClassAMember</xbrldi:explicitMember></xbrli:segment></xbrli:entity><xbrli:period><xbrli:instant>2026-07-15</xbrli:instant></xbrli:period></xbrli:context>
    <xbrli:context id="b"><xbrli:entity><xbrli:identifier>0001652044</xbrli:identifier><xbrli:segment><xbrldi:explicitMember dimension="dei:EntityCommonStockClassAxis">dei:ClassBMember</xbrldi:explicitMember></xbrli:segment></xbrli:entity><xbrli:period><xbrli:instant>2026-07-15</xbrli:instant></xbrli:period></xbrli:context>
    <xbrli:unit id="shares"><xbrli:measure>shares</xbrli:measure></xbrli:unit>
    <ix:nonFraction name="dei:EntityCommonStockSharesOutstanding" contextRef="a" unitRef="shares" scale="6">5,868</ix:nonFraction>
    <ix:nonFraction name="dei:EntityCommonStockSharesOutstanding" contextRef="b" unitRef="shares" scale="6">835</ix:nonFraction>
  </html>`);
  assert.equal(doc.coverShares[0].value, 6703000000);
  assert.equal(doc.coverShares[0].basis, 'class-sum');
});

test('cover shares prefers an undimensioned aggregate', () => {
  const contexts = {
    total: context('total'),
    a: context('a', { dimensions: { 'dei:EntityCommonStockClassAxis': 'dei:ClassAMember' } }),
    b: context('b', { dimensions: { 'dei:EntityCommonStockClassAxis': 'dei:ClassBMember' } }),
  };
  assert.deepEqual(shares(contexts, [fact('total', 120), fact('a', 70), fact('b', 50)]), [{ end: '2026-07-15', entity: '0001652044', value: 120, concept: 'dei:EntityCommonStockSharesOutstanding', basis: 'aggregate', classes: 1 }]);
});

test('cover shares safely sums Alphabet-like stock classes', () => {
  const contexts = {
    a: context('a', { dimensions: { 'dei:EntityCommonStockClassAxis': 'dei:ClassAMember' } }),
    b: context('b', { dimensions: { 'dei:EntityCommonStockClassAxis': 'dei:ClassBMember' } }),
    c: context('c', { dimensions: { 'dei:EntityCommonStockClassAxis': 'dei:ClassCMember' } }),
  };
  const out = shares(contexts, [fact('a', 5868000000), fact('b', 835000000), fact('c', 5527000000)]);
  assert.equal(out[0].value, 12230000000);
  assert.equal(out[0].basis, 'class-sum');
  assert.equal(out[0].classes, 3);
});

test('cover shares rejects ambiguous or non-class dimensions', () => {
  const contexts = {
    a: context('a', { dimensions: { 'dei:EntityCommonStockClassAxis': 'dei:ClassAMember' } }),
    twice: context('twice', { dimensions: { 'dei:EntityCommonStockClassAxis': 'dei:ClassAMember' } }),
    product: context('product', { dimensions: { 'srt:ProductOrServiceAxis': 'x:WidgetMember' } }),
  };
  assert.deepEqual(shares(contexts, [fact('a', 70), fact('twice', 70), fact('product', 50)]), []);
});

test('parser DEI cover facts beat same-filing GAAP balance-sheet facts', () => {
  const index = indexCoverShares([
    { accession: 'q2', end: '2026-06-30', value: 12088000000, source: 'cover', concept: 'us-gaap:CommonStockSharesOutstanding', basis: 'aggregate' },
    { accession: 'q2', end: '2026-07-15', value: 12230000000, source: 'cover', concept: 'dei:EntityCommonStockSharesOutstanding', basis: 'class-sum' },
  ]);
  const selected = coverSharesFor(index, { sources: ['q2'], periodEnd: '2026-06-30' })!;
  assert.equal(selected.value, 12230000000);
  assert.equal(selected.concept, 'dei:EntityCommonStockSharesOutstanding');
});

test('exact accession ignores a comparative companyconcept fact', () => {
  const index = indexCoverShares([
    { accession: 'q2', end: '2025-12-31', value: 12088000000, source: 'companyconcept' },
    { accession: 'q2', end: '2026-06-30', value: 12230000000, source: 'companyconcept' },
  ]);
  assert.equal(coverSharesFor(index, { sources: ['q2'], periodEnd: '2026-06-30' })!.value, 12230000000);
});

test('share index prefers parsed records and refuses a conflicting date fallback', () => {
  const parsed = indexCoverShares([{ accession: 'a', end: '2026-07-15', value: 120, source: 'cover', basis: 'class-sum' }]);
  const api = indexCoverShares([{ accession: 'a', end: '2026-07-15', value: 70, source: 'companyconcept', basis: 'dei' }]);
  const index = mergeCoverShareIndexes(parsed, api);
  assert.equal(coverSharesFor(index, { sources: ['a'], periodEnd: '2026-06-30' })!.value, 120);
  const conflict = indexCoverShares([
    { accession: 'b', end: '2026-07-15', value: 120, source: 'cover' },
    { accession: 'c', end: '2026-07-15', value: 70, source: 'cover' },
  ]);
  assert.equal(coverSharesFor(conflict, { sources: [], periodEnd: '2026-06-30' }), null);
});
