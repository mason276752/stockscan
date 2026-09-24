import test from 'node:test';
import assert from 'node:assert/strict';
import { basketRequest, basketSeries } from '../server/lib/basket.ts';
import type { BasketMember, IsoDate } from '../server/lib/types.ts';

// January 2020, as a trading calendar
const DAYS = ['2020-01-02', '2020-01-03', '2020-01-06', '2020-01-07', '2020-01-08', '2020-01-09', '2020-01-10', '2020-01-13', '2020-01-14', '2020-01-15', '2020-01-16', '2020-01-17', '2020-01-20', '2020-01-21', '2020-01-22', '2020-01-23', '2020-01-24', '2020-01-27', '2020-01-28', '2020-01-29', '2020-01-30', '2020-01-31'];
// a member whose close on each day is price(date), flat bars so the arithmetic is readable
const member = (symbol: string, price: (d: IsoDate) => number, days: readonly IsoDate[] = DAYS): BasketMember => ({ symbol, weight: 1, source: 'test', days: days.map((date) => ({ date, open: price(date), high: price(date), low: price(date), close: price(date), volume: 100 })) });
const A = member('A', (d) => (d < '2020-01-08' ? 10 : 20)); // doubles on the 8th
const B = member('B', () => 5);
const C = member('C', () => 10, DAYS.slice(0, 7)); // its prices stop on the 10th

test('a window is base 100 on its own first session and ends where it is told', () => {
  const r = basketSeries([A, B], { from: '2020-01-03', to: '2020-01-09' });
  assert.deepEqual(r.bars.map((b) => [b.time, b.close]), [
    ['2020-01-03', 100], // 50 into A at 10 (5 units), 50 into B at 5 (10 units)
    ['2020-01-06', 100],
    ['2020-01-07', 100],
    ['2020-01-08', 150], // A doubles
    ['2020-01-09', 150],
  ]);
  assert.equal(r.start, '2020-01-03');
  assert.equal(r.end, '2020-01-09');
  assert.equal(r.stats!.total, 0.5);
  const a = r.constituents!.find((c) => c.symbol === 'A')!;
  assert.deepEqual([a.startClose, a.endClose, a.return], [10, 20, 1], "each constituent's return is what it did inside the window");
  // either end of the window on its own is a window too
  assert.equal(basketSeries([A, B], { to: '2020-01-09' }).end, '2020-01-09');
  assert.equal(basketSeries([A, B], { from: '2020-01-08' }).start, '2020-01-08');
  // and without one it is the whole of what the bars cover (the preset range reaches further back than they do)
  const all = basketSeries([A, B], { range: '5y' });
  assert.deepEqual([all.start, all.end], ['2020-01-02', '2020-01-31']);
});

test('a name still trading is not delisted just because the window ends in the past', () => {
  const inside = basketSeries([A, C], { from: '2020-01-02', to: '2020-01-09' });
  assert.equal(inside.constituents!.find((c) => c.symbol === 'C')!.delisted, false, 'its prices run past the end of the window');
  const whole = basketSeries([A, C], { range: '5y' });
  assert.equal(whole.constituents!.find((c) => c.symbol === 'C')!.delisted, true, 'three weeks behind the others: gone');
});

test('a window shorter than a week still has an index in it', () => {
  // the "only a few days of prices" rule is about a name with fewer days
  // than the window, not about a window that is only a few days long
  const r = basketSeries([A, B], { from: '2020-01-07', to: '2020-01-09' });
  assert.deepEqual(r.bars.map((b) => b.close), [100, 150, 150]);
  assert.equal(r.notes.some((n) => n.code === 'fewDays'), false);
});

test("the request carries the window as typed, and a window wins over the preset range", () => {
  const body = { constituents: [{ ticker: 'AAPL' }], range: '3y' };
  assert.deepEqual(basketRequest(body).range, '3y');
  const w = basketRequest({ ...body, from: '2019-01-01', to: '2020-12-31' });
  assert.deepEqual([w.range, w.from, w.to], ['custom', '2019-01-01', '2020-12-31']);
  const back = basketRequest({ ...body, from: '2020-12-31', to: '2019-01-01' });
  assert.deepEqual([back.from, back.to], ['2019-01-01', '2020-12-31'], 'typed back to front: turned round');
  const junk = basketRequest({ ...body, from: 'last year', to: '2020-02-30' });
  assert.deepEqual([junk.range, junk.from, junk.to], ['3y', null, null], 'a date that is not one is ignored, not guessed at');
});
