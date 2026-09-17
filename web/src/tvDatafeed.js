// Datafeed for TradingView's Advanced Charts library (the licensed
// "charting_library" in web/assets/tradingview/), serving the bars the page
// already computed: the basket index and, as a second symbol, the rebased
// benchmark. Daily only; the library builds weeks / months itself. API per
// https://www.tradingview.com/charting-library-docs/latest/connecting_data/datafeed-api/
const toMs = (d) => Date.parse(`${d}T00:00:00Z`);

export function makeDatafeed({ name, bars, overlayName = '', overlay = () => [] }) {
  const symbols = () => {
    const out = [{ name, description: name, get: bars, kind: 'ohlc' }];
    if (overlayName) out.push({ name: overlayName, description: `${overlayName} (start = 100)`, get: overlay, kind: 'line' });
    return out;
  };
  const info = (s) => ({
    ticker: s.name,
    name: s.name,
    description: s.description,
    type: 'index',
    session: '0930-1600',
    timezone: 'America/New_York',
    exchange: 'stockscan',
    listed_exchange: 'stockscan',
    format: 'price',
    minmov: 1,
    pricescale: 100,
    has_intraday: false,
    has_daily: true,
    daily_multipliers: ['1'],
    has_weekly_and_monthly: false, // built from the daily bars
    supported_resolutions: ['1D', '1W', '1M'],
    volume_precision: 0,
    data_status: 'endofday',
  });
  return {
    onReady(cb) {
      setTimeout(() => cb({ supported_resolutions: ['1D', '1W', '1M'], supports_search: true, supports_group_request: false, supports_marks: false, supports_timescale_marks: false, supports_time: false }), 0);
    },
    searchSymbols(input, _exchange, _type, onResult) {
      const q = String(input || '').toLowerCase();
      onResult(symbols().filter((s) => s.name.toLowerCase().includes(q)).map((s) => ({ symbol: s.name, full_name: s.name, description: s.description, exchange: 'stockscan', type: 'index' })));
    },
    resolveSymbol(symbolName, onResolve, onError) {
      const s = symbols().find((x) => x.name === symbolName) || symbols()[0];
      setTimeout(() => (s ? onResolve(info(s)) : onError('unknown symbol')), 0);
    },
    getBars(symbolInfo, _resolution, { from, to, firstDataRequest }, onResult, onError) {
      try {
        const s = symbols().find((x) => x.name === symbolInfo.name) || symbols()[0];
        const rows = s.get();
        const out = rows
          .map((b) => (s.kind === 'line' ? { time: toMs(b.time), open: b.value, high: b.value, low: b.value, close: b.value } : { time: toMs(b.time), open: b.open, high: b.high, low: b.low, close: b.close }))
          .filter((b) => b.time >= from * 1000 && b.time < to * 1000);
        if (out.length) return onResult(out, { noData: false });
        // nothing in the window: point the library at the newest bar older than `from`, if any
        const older = rows.filter((b) => toMs(b.time) < from * 1000).at(-1);
        onResult([], { noData: true, nextTime: !firstDataRequest && older ? toMs(older.time) / 1000 : undefined });
      } catch (err) {
        onError(err.message);
      }
    },
    subscribeBars() {},
    unsubscribeBars() {},
  };
}
