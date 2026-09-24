// Background crawl of the daily bars of every company in the ticker table,
// from TradingView: ten years the first time a symbol is seen (~30 KB), then
// only the bars since the last one - a run after the close is one short
// request per symbol, and the year files on disk change by a few bytes.
//
// One run per trading day, at 19:30 New York - in the hour the 23-hour US
// session (from December 2026: 20:00 ET to 19:00 ET the next day) is closed,
// when the day's bar is certainly final - and at startup if the last run
// predates that. Symbols TradingView
// does not know are retried a week later. STOCKSCAN_BARS_CRAWL=0 turns it
// off; it also needs TradingView (TV_ENABLED).

import { store } from './store.ts';
import { tickerTable } from './edgar.ts';
import { lastClose, syncTvBars } from './bars.ts';
import { tvStatus } from './tvws.ts';

const LANES = Math.max(1, Number(process.env.STOCKSCAN_BARS_CRAWL_PARALLEL) || 6); // TradingView allows 8 sessions at once; leave room for the user
const AFTER_CLOSE = 3.5 * 3600 * 1000; // 16:00 close + 3.5 h = 19:30 ET, inside the 19:00-20:00 pause of the 23-hour session
const POLL = 5 * 60 * 1000; // how often the clock is checked
const MAX_FAILS = 3;
const RETRY_FAILED = 7 * 24 * 3600 * 1000;
const LOG_EVERY = 60_000;
const RUN_KEY = 'barcrawl:last'; // not 'bars:…' - the bar store's kv migration sweeps that prefix
const FAILS_KEY = 'barcrawl:fails';

import type { Fetcher } from './secClient.ts';

/** How far the crawl has got. */
interface CrawlState {
  enabled: boolean;
  phase: 'waiting' | 'running';
  round: number;
  total: number;
  position: number;
  fetched: number;
  fresh: number;
  failed: number;
  bars: number;
  current: string | null;
  startedAt: string | null;
  lastRun: string | null;
}

/** A symbol TradingView could not answer for, and how often. */
interface FailRecord {
  n: number;
  at: string;
  error: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const n = (x: number) => x.toLocaleString('en-US');

export function createBarCrawler(client: Fetcher, { enabled = true }: { enabled?: boolean } = {}) {
  const state: CrawlState = {
    enabled: enabled && tvStatus().enabled,
    phase: 'waiting', // waiting | running
    round: 0,
    total: 0,
    position: 0,
    fetched: 0, // symbols that needed a request this run
    fresh: 0, // symbols already up to date
    failed: 0,
    bars: 0, // bars downloaded this run
    current: null,
    startedAt: null,
    lastRun: store.getKV<string>(RUN_KEY)?.value || null,
  };
  const fails: Record<string, FailRecord> = store.getKV<Record<string, FailRecord>>(FAILS_KEY)?.value || {};
  const inFlight = new Set<string>();

  async function run() {
    state.phase = 'running';
    state.round++;
    state.startedAt = new Date().toISOString();
    state.position = state.fetched = state.fresh = state.failed = state.bars = 0;
    const tickers = (await tickerTable(client)).map((t) => t.ticker).filter(Boolean);
    const symbols = [...new Set(tickers.map((t) => t.toUpperCase()))].sort();
    state.total = symbols.length;
    const timer = setInterval(logProgress, LOG_EVERY);
    let next = 0;
    const lane = async () => {
      for (;;) {
        const symbol = symbols[next++];
        if (!symbol) return;
        state.position++;
        const f = fails[symbol];
        if (f && f.n >= MAX_FAILS && Date.now() - Date.parse(f.at) < RETRY_FAILED) {
          state.failed++;
          continue;
        }
        inFlight.add(symbol);
        state.current = [...inFlight].join(', ');
        try {
          const bars = await syncTvBars(symbol);
          if (bars) {
            state.fetched++;
            state.bars += bars;
          } else state.fresh++;
          if (f) delete fails[symbol];
        } catch (err) {
          state.failed++;
          fails[symbol] = { n: (f?.n || 0) + 1, at: new Date().toISOString(), error: (err as Error).message };
          if ((f?.n || 0) + 1 >= MAX_FAILS) console.warn(`bars crawl ${symbol}: ${(err as Error).message}（放棄一週）`);
        } finally {
          inFlight.delete(symbol);
          state.current = inFlight.size ? [...inFlight].join(', ') : null;
        }
        if (state.position % 100 === 0) store.putKV(FAILS_KEY, fails);
      }
    };
    await Promise.all(Array.from({ length: LANES }, lane));
    store.putKV(FAILS_KEY, fails);
    clearInterval(timer);
    state.lastRun = new Date().toISOString();
    store.putKV(RUN_KEY, state.lastRun);
    state.phase = 'waiting';
    logProgress();
    console.log(`bars crawl ${state.round} done: ${n(state.fetched)} 檔更新（${n(state.bars)} 根）、${n(state.fresh)} 檔已是最新、${n(state.failed)} 檔失敗`);
  }

  function logProgress() {
    console.log(
      `bars crawl: ${n(state.position)} / ${n(state.total)} 檔（更新 ${n(state.fetched)}、已最新 ${n(state.fresh)}、失敗 ${n(state.failed)}、${n(state.bars)} 根）${state.current ? ` 目前 ${state.current}` : ''}`,
    );
  }

  // a run is due once the last close has settled and no run has seen it
  const due = () => {
    const now = Date.now();
    const close = lastClose(now);
    return now >= close + AFTER_CLOSE && (!state.lastRun || Date.parse(state.lastRun) < close + AFTER_CLOSE);
  };

  async function loop() {
    for (;;) {
      if (due()) {
        try {
          await run();
        } catch (err) {
          state.phase = 'waiting';
          console.warn(`bars crawl failed: ${(err as Error).message}`);
          await sleep(10 * 60 * 1000);
        }
      }
      await sleep(POLL);
    }
  }

  return {
    start() {
      if (state.enabled) loop();
    },
    // one pass over the ticker table now, then done: for a scheduled job
    // (the GitHub Actions build fetches this year's bars before publishing)
    async runOnce() {
      await run();
      return { fetched: state.fetched, fresh: state.fresh, failed: state.failed, bars: state.bars, total: state.total };
    },
    status: () => ({ ...state, lanes: LANES }),
  };
}
