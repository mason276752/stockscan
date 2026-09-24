import test from 'node:test';
import assert from 'node:assert/strict';
import { adjusted, decimals, decimalsFor, decodeBars, diffSeries, encodeBars, mergeDays, round, unadjust } from '../server/lib/barFormat.ts';

const bars = (...prices) => prices.map((p, i) => ({ date: `2020-01-${String(i + 1).padStart(2, '0')}`, open: p, high: p, low: p, close: p, volume: 100 }));

test('how many decimals a price needs is read off its exponential form', () => {
  assert.equal(decimals(1.5), 1);
  assert.equal(decimals(123), 0);
  assert.equal(decimals(0.0001), 4);
  // JavaScript prints these in exponential form - there is no '.' to count from
  assert.equal(decimals(4e-7), 7);
  assert.equal(decimals(1.5e-7), 8);
  assert.equal(decimals(1e21), 0);
  assert.equal(decimals(0), 0);
});

test('a sub-cent quote survives the file format', () => {
  const days = bars(4e-7, 4.5e-7, 1e-8);
  assert.equal(decimalsFor(days), 8);
  assert.deepEqual(
    decodeBars(encodeBars(days)).map((b) => b.close),
    [4e-7, 4.5e-7, 1e-8],
    'an OTC quote below a millionth of a dollar used to be stored as 0, which divides an index by zero',
  );
});

test('a price of billions does not cost the cents beside it', () => {
  // a stock through enough reverse splits: TradingView adjusts its 2016 close to $41 billion
  const days = bars(1.767, 41472000000.000015, 12.5);
  const out = decodeBars(encodeBars(days)).map((b) => b.close);
  assert.equal(out[0], 1.767);
  assert.equal(out[2], 12.5);
  assert.ok(Math.abs(out[1] / 41472000000.000015 - 1) < 1e-12);
});

test('the decimals asked for are the price’s, not a float’s noise', () => {
  assert.equal(decimalsFor(bars(0.30000000000000004, 1.1)), 1, 'twelve significant digits is where a price ends');
  assert.equal(decimalsFor(bars(2.4084, 1018967040000)), 4, 'the largest price does not decide it either');
  assert.equal(decimalsFor(bars(1, 2, 3)), 0);
});

test('a split factor is applied without rounding a sub-cent price away', () => {
  assert.equal(round(1.7670000000000002), 1.767, 'the float noise of a multiply goes');
  assert.equal(round(4e-7), 4e-7, 'the price does not');
  const split = [{ date: '2020-01-03', price: 0.5, volume: null }];
  const raw = bars(8e-7, 8e-7, 3);
  const view = adjusted(raw, split);
  assert.deepEqual(
    view.map((b) => b.close),
    [4e-7, 4e-7, 3],
  );
  assert.deepEqual(
    view.map((b) => unadjust(b, split).close),
    [8e-7, 8e-7, 3],
    'and back',
  );
});

test('a one-factor shift of every earlier bar is read as a split', () => {
  const saved = bars(10, 10, 10, 20, 20);
  const incoming = saved.map((b) => (b.date < '2020-01-04' ? { ...b, close: b.close * 4, volume: b.volume / 4 } : b));
  const { split } = diffSeries(saved, incoming);
  assert.deepEqual(split, { date: '2020-01-04', price: 4, volume: null });
  // and a series that simply moved on is not a split
  assert.equal(diffSeries(saved, bars(10, 10, 10, 20, 30)).split, null);
});

test('a tail that no longer lines up is not spliced on', () => {
  const saved = bars(10, 10, 10);
  assert.equal(mergeDays(saved, [{ ...saved[2], close: 40 }]), null, 'a split since the last fetch: refetch the lot');
  assert.equal(mergeDays(saved, [{ ...saved[2] }, { ...saved[2], date: '2020-01-04' }]).length, 4);
});

test('a split that lands while the last bar is still forming is dated after it', () => {
  const saved = bars(0.3, 0.29, 0.28);
  const scale = (b, k) => ({ ...b, open: b.open * k, high: b.high * k, low: b.low * k, close: b.close * k, volume: b.volume / k });
  const incoming = [...saved.map((b) => scale(b, 25)), { ...scale(bars(6.9)[0], 1), date: '2020-01-04' }];
  const { split, dates } = diffSeries(saved, incoming, '2020-01-03');
  assert.deepEqual(split, { date: '2020-01-04', price: 25, volume: null }, 'the bar still forming moved by the same factor: it is on the old basis too');
  assert.deepEqual(dates, [], 'so it is not a bar to rewrite either');
});

test('a bar still forming that moved on its own is not part of a split', () => {
  const saved = bars(10, 10, 10);
  const { split, dates } = diffSeries(saved, [saved[0], saved[1], { ...saved[2], close: 11 }], '2020-01-03');
  assert.equal(split, null);
  assert.deepEqual(dates, ['2020-01-03'], 'just a bar to rewrite');
});
