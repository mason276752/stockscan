import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../server/lib/store.ts';
import { barStore, openBarStore } from '../server/lib/barStore.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stockscan-bars-'));
openStore(path.join(tmp, 'store'));
openBarStore(path.join(tmp, 'bars'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// 2020, so the bars land in a finished year file rather than the running head
const DAYS = ['2020-03-09', '2020-03-10', '2020-03-11', '2020-03-12', '2020-03-13', '2020-03-16'];
const series = (prices, fetchedAt, vol = 1000) => ({ symbol: 'TEST', source: 'test', currency: 'USD', fetchedAt, days: DAYS.map((date, i) => ({ date, open: prices[i], high: prices[i], low: prices[i], close: prices[i], volume: vol })) });
const closes = (src, symbol) => barStore.get(src, symbol).days.map((b) => b.close);

test('a reverse split is one line of meta, and the series still reads back as the source sends it', () => {
  const before = [0.4, 0.42, 0.39, 0.4, 0.41, 0.4];
  barStore.put('t1', 'TEST', series(before, '2020-03-17T00:00:00Z'));
  const after = before.map((p) => p * 25);
  barStore.put('t1', 'TEST', series(after, '2020-03-18T00:00:00Z', 40)); // a split scales the volume the other way
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'bars', 't1', 'TEST', 'meta.json'), 'utf8')).adjust, [{ date: '2020-03-17', price: 25, volume: null }], 'the history files are not rewritten - the factor is');
  assert.deepEqual(closes('t1', 'TEST'), after);
});

test('a bar the split factor does not reproduce is written out rather than left 25x wrong', () => {
  // the last bar was saved while its session was still running, so it went in
  // on the old basis; the source now sends the whole series on the new one
  const before = [0.4, 0.42, 0.39, 0.4, 0.41, 0.4];
  barStore.put('t2', 'TEST', series(before, '2020-03-16T18:00:00Z'));
  const after = before.map((p) => p * 25);
  barStore.put('t2', 'TEST', series(after, '2020-03-18T00:00:00Z', 40));
  const { adjust } = JSON.parse(fs.readFileSync(path.join(tmp, 'bars', 't2', 'TEST', 'meta.json'), 'utf8'));
  assert.equal(adjust[0].date, '2020-03-17', 'the new basis starts after the forming bar, not before it');
  assert.deepEqual(closes('t2', 'TEST'), after, 'every bar, the one either side of the factor included');
});

test('a data revision that is not one factor rewrites the years it touches', () => {
  const before = [0.4, 0.42, 0.39, 0.4, 0.41, 0.4];
  barStore.put('t3', 'TEST', series(before, '2020-03-17T00:00:00Z'));
  const fixed = [0.4, 0.42, 0.5, 0.4, 0.41, 0.4]; // one bar corrected
  barStore.put('t3', 'TEST', series(fixed, '2020-03-18T00:00:00Z'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'bars', 't3', 'TEST', 'meta.json'), 'utf8')).adjust, []);
  assert.deepEqual(closes('t3', 'TEST'), fixed);
});
