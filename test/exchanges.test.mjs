import test from 'node:test';
import assert from 'node:assert/strict';
import { isMajorExchange, onMajorExchange, tickerRows } from '../server/lib/edgar.js';

test('only the real exchanges count', () => {
  for (const x of ['Nasdaq', 'NYSE', 'NYSE American', 'NYSEAmer', 'CBOE', 'BATS', 'IEX', 'NYSE Arca']) assert.equal(isMajorExchange(x), true, x);
  for (const x of ['OTC', 'OTC Markets', '', null, undefined]) assert.equal(isMajorExchange(x), false, String(x));
});

test('a blank venue is decided by the company’s own submissions record', () => {
  const venues = { 1: ['Nasdaq'], 2: ['OTC'], 3: ['NYSE', 'OTC'] };
  const of = (cik) => venues[cik];
  assert.equal(onMajorExchange({ cik: 1, exchange: null }, of), true);
  assert.equal(onMajorExchange({ cik: 2, exchange: null }, of), false);
  assert.equal(onMajorExchange({ cik: 3, exchange: null }, of), true, 'one real listing is enough');
  // the record of a company dropped as OTC is dropped with it, so "keep what
  // is unknown" would take it back on the next refresh and drop it again
  assert.equal(onMajorExchange({ cik: 9, exchange: null }, of), false, 'nothing says it is listed anywhere: not covered');
  assert.equal(onMajorExchange({ cik: 2, exchange: 'Nasdaq' }, of), true, 'the table wins when it has an answer');
});

test('company_tickers_exchange.json is read by its field names', () => {
  const rows = tickerRows({
    fields: ['cik', 'name', 'ticker', 'exchange'],
    data: [
      [320193, 'Apple Inc.', 'AAPL', 'Nasdaq'],
      [1, 'Shell Co', 'SHEL', 'OTC'],
      [0, 'No cik', 'X', 'NYSE'],
    ],
  });
  assert.deepEqual(rows, [
    { cik: 320193, name: 'Apple Inc.', ticker: 'AAPL', exchange: 'Nasdaq' },
    { cik: 1, name: 'Shell Co', ticker: 'SHEL', exchange: 'OTC' },
  ]);
});
