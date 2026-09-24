// The pure-frontend data layer as the page sees it: the same methods as
// api.http.ts, each forwarded to the worker (api.static.worker.ts) that
// holds the static build's indexes and does the work - fetching, inflating
// and parsing them, decoding filings, the screener, basket indexes - off the
// main thread. Only the answers come back, so the page never blocks on the
// data and never holds the big indexes itself.
import { BASE } from './base';
import { busy } from './busy';
import { locale } from './i18n';
import type { Api, StreamEvent, WarmupTask } from './apiTypes.ts';

/** One call waiting on the worker. */
interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  onEvent?: ((e: StreamEvent) => void) | null;
}

/** What the worker sends back: a progress line, an event, or an answer. */
interface WorkerMessage {
  id?: number;
  progress?: { path: string; loaded: number; total: number; done: boolean };
  event?: StreamEvent;
  error?: { message: string; status?: number };
  result?: unknown;
}

const worker = new Worker(new URL('./api.static.worker.ts', import.meta.url), { type: 'module', name: BASE }); // name: see base.ts
const pending = new Map<number, Pending>();
let seq = 0;

worker.onmessage = ({ data: msg }: MessageEvent<WorkerMessage>) => {
  if (msg.progress) {
    // a download's progress (busy.ts shows it): dropped from the list when done
    const { path, loaded, total, done } = msg.progress;
    if (done) delete busy.downloads[path];
    else busy.downloads[path] = { loaded, total };
    return;
  }
  const p = pending.get(msg.id!);
  if (!p) return;
  if ('event' in msg) return p.onEvent?.(msg.event!);
  pending.delete(msg.id!);
  if (msg.error) p.reject(Object.assign(new Error(msg.error.message), msg.error.status != null ? { status: msg.error.status } : {}));
  else p.resolve(msg.result);
};
worker.onerror = (e) => {
  const err = new Error(e.message || 'worker error');
  for (const p of pending.values()) p.reject(err);
  pending.clear();
};

// call api[method](...args) in the worker; streamed events (basketStream,
// ruleEtfStream) arrive on onEvent, signal cancels the call there
function call<T = unknown>(method: string, args: unknown[] = [], { onEvent = null, signal = null }: { onEvent?: ((e: StreamEvent) => void) | null; signal?: AbortSignal | null } = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new DOMException('aborted', 'AbortError'));
    const id = ++seq;
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onEvent });
    worker.postMessage({ id, method, args, locale: locale.value });
    signal?.addEventListener('abort', () => pending.has(id) && worker.postMessage({ id, abort: true }), { once: true });
  });
}
// every forwarded method keeps the Api signature: the worker answers the same
const forward = <M extends keyof Api>(method: M) => ((...args: unknown[]) => call(method as string, args)) as Api[M];

// what the idle prefetcher (prefetch.ts) warms after start-up: first the
// indexes every page needs (search, company records, the statement
// documentation - that one also loads the zstd decoder), then the big ones
// behind the screener and the browse pages; the worker loads and keeps them.
// On a slow connection (3G or below, or under 1.5 Mb/s as the browser
// measures it) the big ones (0.3-3.5 MB each) are left to be fetched when a
// page needs them: warming them would take minutes of the bandwidth the
// user's own clicks need.
const WARMUP: [key: string, priority: number, big?: string][] = [
  ['idx:tickers', 1],
  ['idx:scores', 1],
  ['idx:documentation', 1],
  ['idx:tvsymbols', 0],
  ['idx:browse', 0],
  ['idx:etfs', 0],
  ['idx:companies', 1, 'big'],
  ['idx:universe', 0, 'big'],
  ['idx:screen', 0, 'big'],
  ['idx:screen-history', -1, 'big'],
];
const slowConnection = () => {
  const c = (navigator as Navigator & { connection?: { effectiveType?: string; downlink?: number } }).connection;
  return !!c && (/(^|-)(2g|3g)$/.test(c.effectiveType || '') || ((c.downlink ?? 0) > 0 && (c.downlink ?? 0) < 1.5));
};

export const api: Api = {
  isStatic: true,
  meta: forward('meta'),
  search: forward('search'),
  company: forward('company'),
  filing: forward('filing'),
  filingUrl: () => null,
  quarters: forward('quarters'),
  quartersUrl: () => null,
  indicators: forward('indicators'),
  indicatorsUrl: () => null,
  valuation: forward('valuation'),
  valuationUrl: () => null,
  warmup: () => WARMUP.filter(([, , big]) => !big || !slowConnection()).map(([key, priority]): WarmupTask => [key, () => call('warm', [key]), priority]),
  status: forward('status'),
  screenFields: forward('screenFields'),
  screen: forward('screen'),
  screenUrl: () => null,
  scores: forward('scores'),
  score: forward('score'),
  browseSic: forward('browseSic'),
  browseFiler: forward('browseFiler'),
  browseCompanies: forward('browseCompanies'),
  browseEtfs: forward('browseEtfs'),
  etfHoldings: forward('etfHoldings'),
  etfHoldingsUrl: () => null,
  etfLive: forward('etfLive'),
  quotesStatus: forward('quotesStatus'),
  tvSymbol: forward('tvSymbol'),
  ibConnect: forward('ibConnect'),
  bars: forward('bars'),
  basket: forward('basket'),
  basketStream: (body, onEvent, signal) => call<void>('basketStream', [body], { onEvent, signal }),
  ruleEtf: forward('ruleEtf'),
  ruleEtfStream: (body, onEvent, signal) => call<void>('ruleEtfStream', [body], { onEvent, signal }),
};
