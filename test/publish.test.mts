import test from 'node:test';
import assert from 'node:assert/strict';
import { inWindow, periodEndOf, publishBudget, publishFrom } from '../server/lib/publish.ts';

const filing = (accession, reportDate, mb) => ({ accession, reportDate, bytes: mb * 1048576, file: `filings/1/${accession}__${reportDate}__10-Q__v2.json.zst` });

test('the site takes the newest filings that fit its budget', () => {
  const filings = [filing('a', '2020-03-31', 3), filing('d', '2026-03-31', 3), filing('b', '2022-03-31', 3), filing('c', '2024-03-31', 3)];
  const fits = publishBudget(filings, 10);
  assert.deepEqual([...fits.accessions], ['d', 'c', 'b'], 'newest first, until the next one would not fit');
  assert.equal(fits.from, '2022-03-31', 'where the site now starts');
  assert.equal(fits.left, 1);
  // a budget that takes everything leaves nothing behind
  const all = publishBudget(filings, 100);
  assert.equal(all.accessions.size, 4);
  assert.equal(all.left, 0);
  assert.equal(all.from, '2020-03-31');
  // and one that takes nothing says so rather than throwing
  const none = publishBudget(filings, 1);
  assert.equal(none.accessions.size, 0);
  assert.equal(none.from, null);
});

test('a filing with no period end never travels', () => {
  const fits = publishBudget([filing('a', '2026-03-31', 1), { accession: 'b', reportDate: null, bytes: 1024 }], 100);
  assert.deepEqual([...fits.accessions], ['a']);
});

test('the data ref window reads the period end off the file name', () => {
  assert.equal(periodEndOf('filings/320193/0000320193-26-000075__2026-06-27__10-Q__v2.json.zst'), '2026-06-27');
  assert.equal(periodEndOf('scores/320193/0000320193-26-000075__2026-06-27__v17.json.zst'), '2026-06-27');
  assert.equal(periodEndOf('filings/1/no-date.json.zst'), null);
  assert.equal(inWindow({ file: 'filings/1/x__2026-06-27__10-Q__v2.json.zst' }, '2023-09-23'), true);
  assert.equal(inWindow({ file: 'filings/1/x__2021-06-27__10-Q__v2.json.zst' }, '2023-09-23'), false);
  assert.equal(inWindow({ reportDate: '2026-06-27' }, '2023-09-23'), true, 'the store index knows it without the name');
  assert.equal(inWindow({ file: 'filings/1/no-date.json.zst' }, '2023-09-23'), false);
});

test('the window is a whole number of years back', () => {
  assert.equal(publishFrom(3, Date.parse('2026-09-23T00:00:00Z')), '2023-09-23');
  assert.equal(publishFrom(1, Date.parse('2024-02-29T00:00:00Z')), '2023-03-01', 'a leap day rolls over, it does not throw');
});
