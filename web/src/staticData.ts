// Static-build data access: the prebuilt indexes (index/*.json.zst, named by
// their content - meta.json says which file each index is in this build)
// and the saved filings / scores (data/store/**/*.json.zst, zstd with the
// same dictionaries the server writes with), all fetched as plain files.
// Runs in the data-layer worker (api.static.worker.ts), so the inflating and
// parsing here never block the page; the parsed indexes stay there. A big
// download is read in chunks and its progress reported (setProgress) so the
// page can show how far along it is.
import { init, createDCtx, decompress, decompressUsingDict } from '@bokuweb/zstd-wasm';
// a relative path: the package's "exports" map does not expose the wasm file
import wasmUrl from '../node_modules/@bokuweb/zstd-wasm/dist/web/zstd.wasm?url';
import { url } from './base';
import type { AsOfColumns, BarFile, BarMeta, Concept, ScoreBadge, ScreenColumnFiles, ScreenColumns } from '../../server/lib/types.ts';
import type { Universe } from '../../server/lib/universe.ts';
import type { TickerRow } from '../../server/lib/edgar.ts';
import type { Etf } from '../../server/lib/etf.ts';
import type { FilerCount } from '../../server/lib/screen.ts';
import type { SicCode, SicDivision } from '../../server/lib/sic.ts';
import type { EtfHoldingsResponse } from './apiTypes.ts';

/** index/browse.json: the counts the browse pages show, computed at build time. */
export interface BrowseIndex {
  updatedAt: string | null;
  datasets: string[];
  sic: { divisions: SicDivision[]; codes: (SicCode & { total: number; listed: number })[] };
  filer: FilerCount[];
}

/** index/etfs.json: the ETF list, and which holdings files the build wrote. */
export interface EtfIndex {
  updatedAt: string | null;
  popular: string[];
  etfs: Etf[];
  holdings: string[];
}

/** index/meta.json: which file each index is in this build. */
export interface BuildMeta {
  builtAt?: string;
  files?: Record<string, string>;
  /** where a filing this build could not carry is read from (the data ref) */
  store?: string | null;
  [key: string]: unknown;
}

/** (path, bytes so far, total, finished) - how a download is progressing. */
export type ProgressFn = (path: string, loaded: number, total: number, done: boolean) => void;

const utf8 = new TextDecoder();

// ---- fetching ----
// An index or a finished year of bars is named by its content, so once
// fetched it is kept in the browser's Cache Storage and never downloaded
// again. Index files of earlier builds are dropped from it when the current
// build's meta.json arrives.
//
// A saved filing / score keeps its name (it carries the parser / score
// version, not the content), and the store does rewrite one in place - a
// filing re-parsed by the same version, the cover-share enrichment that
// filled in the share counts of old filings. So those are kept per build
// (?v=<build time>) like this year's bars: a build later than the copy in
// hand fetches it again instead of showing last week's parse for good.
const STORE_CACHE = 'stockscan-store-v2'; // v1 kept the store files for ever
const PROGRESS_MIN = 32 * 1024; // report the progress of downloads from this size
let onProgress: ProgressFn | null = null;
export function setProgress(fn: ProgressFn): void {
  onProgress = fn;
}

const failed = (path: string, res: Response) => Object.assign(new Error(`${path}: ${res.status} ${res.statusText}`), { status: res.status });

// the bytes of a response, read in chunks so their arrival can be reported
async function bytes(path: string, res: Response): Promise<Uint8Array> {
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !onProgress || total < PROGRESS_MIN) return new Uint8Array(await res.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  onProgress(path, 0, total, false);
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress!(path, Math.min(loaded, total), total, false);
    }
  } finally {
    onProgress!(path, total, total, true);
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

let cacheReady: Promise<Cache | null> | null = null;
const openCache = () =>
  (cacheReady ??= (async () => {
    let c: Cache | null = null;
    try {
      c = 'caches' in globalThis ? await caches.open(STORE_CACHE) : null;
    } catch {
      return null; // no Cache Storage (insecure origin, private mode …): plain fetches
    }
    // the caches of an earlier scheme (their store files may be stale for ever)
    try {
      for (const name of await caches.keys()) if (name !== STORE_CACHE && name.startsWith('stockscan-store-')) await caches.delete(name);
    } catch {
      /* an old cache left behind only costs space */
    }
    return c;
  })());

// a site path, or an absolute URL as it is (a filing this build did not
// carry, read from the data ref - see storeUrl)
const at = (p: string) => (/^https?:\/\//.test(p) ? p : url(p));

// an immutable file: from Cache Storage, else fetched and put there
async function fetchImmutable(path: string): Promise<Uint8Array> {
  const req = at(path);
  const c = await openCache();
  try {
    const hit = c && (await c.match(req));
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  } catch {
    /* a broken entry: fetch */
  }
  const res = await fetch(req);
  if (!res.ok) throw failed(path, res);
  const type = res.headers.get('content-type') || 'application/octet-stream';
  const buf = await bytes(path, res);
  if (c) {
    try {
      await c.put(req, new Response(buf as BodyInit, { headers: { 'content-type': type } }));
    } catch {
      /* quota / storage error: fine, it is only a cache */
    }
  }
  return buf;
}

// a file that changes with the build (a saved filing / score, this year's
// bars): Cache Storage keyed by the build (?v=<build time>); the copies of
// earlier builds go in pruneOld, not one cache scan per miss
async function fetchVersioned(path: string, v: string): Promise<Uint8Array> {
  const req = `${at(path)}?v=${encodeURIComponent(v)}`;
  const c = await openCache();
  try {
    const hit = c && (await c.match(req));
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  } catch {
    /* fetch */
  }
  const res = await fetch(req);
  if (!res.ok) throw failed(path, res);
  const type = res.headers.get('content-type') || 'application/octet-stream';
  const buf = await bytes(path, res);
  if (c) {
    try {
      await c.put(req, new Response(buf as BodyInit, { headers: { 'content-type': type } }));
    } catch {
      /* quota: fine */
    }
  }
  return buf;
}

// what an earlier build left in the cache, in one pass when its meta.json
// arrives: index files of other hashes, and the ?v=<build> copies of the
// files that are kept per build (Cache Storage keys are absolute URLs)
async function pruneOld(m: BuildMeta): Promise<void> {
  const c = await openCache();
  if (!c) return;
  const keep = new Set(Object.values(m.files || {}).map((f) => url(`/index/${f}`)));
  const built = `?v=${encodeURIComponent(m.builtAt || '')}`;
  for (const k of await c.keys()) {
    const u = new URL(k.url);
    if (u.pathname.includes('/index/')) {
      if (!keep.has(u.pathname)) await c.delete(k);
    } else if (u.search.startsWith('?v=') && u.search !== built) await c.delete(k);
  }
}

// ---- parsed JSON, once per file ----
const parsed = new Map<string, Promise<unknown>>(); // key -> Promise of the parsed JSON
function once<T>(key: string, load: () => Promise<T>): Promise<T> {
  if (!parsed.has(key)) {
    parsed.set(key, load());
    parsed.get(key)!.catch(() => parsed.delete(key));
  }
  return parsed.get(key) as Promise<T>;
}

// meta.json: the first fetch, always revalidated, names this build's index files
export const meta = (): Promise<BuildMeta> =>
  once<BuildMeta>('meta', async () => {
    const path = '/index/meta.json';
    const res = await fetch(url(path), { cache: 'no-cache' });
    if (!res.ok) throw failed(path, res);
    const m = JSON.parse(utf8.decode(await bytes(path, res)));
    pruneOld(m).catch(() => {});
    return m;
  });

// the indexes the build writes (name -> the parsed JSON of this build's file)
export const index = <T = unknown,>(name: string): Promise<T> =>
  once<T>(`index:${name}`, async () => {
    const [m] = await Promise.all([meta(), wasm()]);
    const file = m.files?.[name];
    if (!file) throw new Error(`index ${name}: not in this build`);
    const buf = await fetchImmutable(`/index/${file}`);
    return JSON.parse(utf8.decode(decompress(buf, { defaultHeapSize: 64 * 1024 * 1024 })));
  });
export const tickers = <T = TickerRow[],>() => index<T>('tickers');
export const companies = <T = unknown,>() => index<T>('companies');
export const scoresMin = <T = Record<string, ScoreBadge | null>,>() => index<T>('scores-min');
export const screenIndex = () => index<ScreenColumns>('screen');
export const screenHistoryIndex = () => index<ScreenColumnFiles['history']>('screen-history');
// the screener's as-of files, one per year of filing date: which years this
// build published (from meta.json's file list), and one of them
export const screenAsOfYears = () =>
  meta().then((m) =>
    Object.keys(m.files || {})
      .map((k) => /^screen-asof-(\d{4})$/.exec(k)?.[1])
      .filter((x): x is string => !!x)
      .map(Number)
      .sort((a, b) => b - a),
  );
export const screenAsOfShard = (year: number) => index<AsOfColumns>(`screen-asof-${year}`);
export const universe = <T = Universe,>() => index<T>('universe');
export const browse = <T = BrowseIndex,>() => index<T>('browse');
export const etfs = <T = EtfIndex,>() => index<T>('etfs');
export const etfHoldings = (ticker: string) => index<EtfHoldingsResponse>(`etf-${ticker}`);
export const tvSymbols = () => index<Record<string, { symbol: string; exchange: string | null }>>('tvsymbols');
export const documentation = () => index<Record<Concept, string>>('documentation');

// the build a versioned file is taken from
const build = () => meta().then((m) => m.builtAt || '');

// ---- zstd ----
// the decoder (80 KB, preloaded by index.html) is all the indexes and bars
// need; the dictionaries (90 KB) only come when a filing / score is read
let wasmReady: Promise<unknown> | null = null;
// the package's own types predate the argument; the web build takes the URL
const wasm = () => (wasmReady ??= (init as (url?: string) => Promise<void>)(wasmUrl));
// the dictionaries carry their version in the name and are never rewritten
const dict = (kind: string) => once(`dict:${kind}`, () => fetchImmutable(`/data/zdict/${kind}-v1.zdict`));

// Where a saved filing / score is: under this site, or - when the build
// could not fit it in (`off`, see server/lib/publish.js) - in the data ref
// on raw.githubusercontent.com, which serves it with CORS open. The path
// below data/store is the same tree either way, so only the base differs.
// null when the build named no data ref: nothing can read that one.
export const storeUrl = (m: BuildMeta, rel: string, off?: boolean | number | null): string | null => (off ? (m.store ? `${m.store}${rel}` : null) : `/data/store/${rel}`);

// a saved filing / score file -> the JSON the server would have read (per
// build: the store can rewrite one under the same name, see above)
export const readZst = <T = unknown,>(kind: string, path: string): Promise<T> =>
  once<T>(path, async () => {
    const [buf, d] = await Promise.all([build().then((v) => fetchVersioned(path, v)), dict(kind), wasm()]);
    return JSON.parse(utf8.decode(decompressUsingDict(createDCtx(), buf, d, { defaultHeapSize: 8 * 1024 * 1024 })));
  });

// ---- daily bars (data/bars/<source>/<SYMBOL>/…, plain zstd, no dictionary) ----
// a finished year never changes (immutable); meta.json and head.zst change
// with the build (versioned)
export async function readBarsZst(path: string, { immutable = false }: { immutable?: boolean } = {}): Promise<BarFile & { fetchedAt?: string }> {
  const [buf] = await Promise.all([immutable ? fetchImmutable(path) : fetchVersioned(path, await build()), wasm()]);
  return JSON.parse(utf8.decode(decompress(buf, { defaultHeapSize: 2 * 1024 * 1024 })));
}
export async function readBarsMeta(path: string): Promise<BarMeta> {
  return JSON.parse(utf8.decode(await fetchVersioned(path, await build())));
}
