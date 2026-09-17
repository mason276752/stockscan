// Static-build data access: the prebuilt indexes (index/*.json.zst, named by
// their content - meta.json says which file each index is in this build)
// and the saved filings / scores (data/store/**/*.json.zst, zstd with the
// same dictionaries the server writes with), all fetched as plain files.
// Runs in the data-layer worker (api.static.worker.js), so the inflating and
// parsing here never block the page; the parsed indexes stay there. A big
// download is read in chunks and its progress reported (setProgress) so the
// page can show how far along it is.
import { init, createDCtx, decompress, decompressUsingDict } from '@bokuweb/zstd-wasm';
// a relative path: the package's "exports" map does not expose the wasm file
import wasmUrl from '../node_modules/@bokuweb/zstd-wasm/dist/web/zstd.wasm?url';
import { url } from './base';

const utf8 = new TextDecoder();

// ---- fetching ----
// Everything but meta.json and this year's bars is immutable (a filing never
// changes, an index or a finished year of bars is named by its content), so
// once fetched it is kept in the browser's Cache Storage and never
// downloaded again. Index files of earlier builds are dropped from it when
// the current build's meta.json arrives.
const STORE_CACHE = 'stockscan-store-v1';
const PROGRESS_MIN = 32 * 1024; // report the progress of downloads from this size
let onProgress = null; // (path, loaded, total, done) => void
export function setProgress(fn) {
  onProgress = fn;
}

const failed = (path, res) => Object.assign(new Error(`${path}: ${res.status} ${res.statusText}`), { status: res.status });

// the bytes of a response, read in chunks so their arrival can be reported
async function bytes(path, res) {
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !onProgress || total < PROGRESS_MIN) return new Uint8Array(await res.arrayBuffer());
  const chunks = [];
  let loaded = 0;
  onProgress(path, 0, total, false);
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress(path, Math.min(loaded, total), total, false);
    }
  } finally {
    onProgress(path, total, total, true);
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

async function openCache() {
  try {
    return 'caches' in globalThis ? await caches.open(STORE_CACHE) : null;
  } catch {
    return null; // no Cache Storage (insecure origin, private mode …): plain fetches
  }
}

// an immutable file: from Cache Storage, else fetched and put there
async function fetchImmutable(path) {
  const req = url(path);
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
      await c.put(req, new Response(buf, { headers: { 'content-type': type } }));
    } catch {
      /* quota / storage error: fine, it is only a cache */
    }
  }
  return buf;
}

// a file that changes with the build (this year's bars): Cache Storage keyed
// by the build (?v=<build time>), the copies of earlier builds dropped
async function fetchVersioned(path, v) {
  const req = `${url(path)}?v=${encodeURIComponent(v)}`;
  const c = await openCache();
  try {
    const hit = c && (await c.match(req));
    if (hit) return new Uint8Array(await hit.arrayBuffer());
    if (c) for (const k of await c.keys()) if (k.url.startsWith(`${url(path)}?v=`) && k.url !== req) await c.delete(k);
  } catch {
    /* fetch */
  }
  const res = await fetch(req);
  if (!res.ok) throw failed(path, res);
  const type = res.headers.get('content-type') || 'application/octet-stream';
  const buf = await bytes(path, res);
  if (c) {
    try {
      await c.put(req, new Response(buf, { headers: { 'content-type': type } }));
    } catch {
      /* quota: fine */
    }
  }
  return buf;
}

// index files not of this build (earlier hashes, the ?v= names of old app versions)
async function pruneIndexes(files) {
  const c = await openCache();
  if (!c) return;
  const keep = new Set(Object.values(files || {}).map((f) => url(`/index/${f}`)));
  for (const k of await c.keys()) {
    const p = new URL(k.url).pathname;
    if (p.includes('/index/') && !keep.has(p)) await c.delete(k);
  }
}

// ---- parsed JSON, once per file ----
const parsed = new Map(); // key -> Promise of the parsed JSON
function once(key, load) {
  if (!parsed.has(key)) {
    parsed.set(key, load());
    parsed.get(key).catch(() => parsed.delete(key));
  }
  return parsed.get(key);
}

// meta.json: the first fetch, always revalidated, names this build's index files
export const meta = () =>
  once('meta', async () => {
    const path = '/index/meta.json';
    const res = await fetch(url(path), { cache: 'no-cache' });
    if (!res.ok) throw failed(path, res);
    const m = JSON.parse(utf8.decode(await bytes(path, res)));
    pruneIndexes(m.files).catch(() => {});
    return m;
  });

// the indexes the build writes (name -> the parsed JSON of this build's file)
export const index = (name) =>
  once(`index:${name}`, async () => {
    const [m] = await Promise.all([meta(), wasm()]);
    const file = m.files?.[name];
    if (!file) throw new Error(`index ${name}: not in this build`);
    const buf = await fetchImmutable(`/index/${file}`);
    return JSON.parse(utf8.decode(decompress(buf, { defaultHeapSize: 64 * 1024 * 1024 })));
  });
export const tickers = () => index('tickers');
export const companies = () => index('companies');
export const scoresMin = () => index('scores-min');
export const screenIndex = () => index('screen');
export const screenHistoryIndex = () => index('screen-history');
export const universe = () => index('universe');
export const browse = () => index('browse');
export const etfs = () => index('etfs');
export const etfHoldings = (ticker) => index(`etf-${ticker}`);
export const tvSymbols = () => index('tvsymbols');
export const documentation = () => index('documentation');

// ---- zstd ----
// the decoder (80 KB, preloaded by index.html) is all the indexes and bars
// need; the dictionaries (90 KB) only come when a filing / score is read
let wasmReady = null;
const wasm = () => (wasmReady ??= init(wasmUrl));
const dict = (kind) => once(`dict:${kind}`, () => fetchImmutable(`/data/zdict/${kind}-v1.zdict`));

// a saved filing / score file -> the JSON the server would have read
export const readZst = (kind, path) =>
  once(path, async () => {
    const [buf, d] = await Promise.all([fetchImmutable(path), dict(kind), wasm()]);
    return JSON.parse(utf8.decode(decompressUsingDict(createDCtx(), buf, d, { defaultHeapSize: 8 * 1024 * 1024 })));
  });

// ---- daily bars (data/bars/<source>/<SYMBOL>/…, plain zstd, no dictionary) ----
// a finished year never changes (immutable); meta.json and head.zst change
// with the build (versioned)
const build = () => meta().then((m) => m.builtAt || '');
export async function readBarsZst(path, { immutable = false } = {}) {
  const [buf] = await Promise.all([immutable ? fetchImmutable(path) : fetchVersioned(path, await build()), wasm()]);
  return JSON.parse(utf8.decode(decompress(buf, { defaultHeapSize: 2 * 1024 * 1024 })));
}
export async function readBarsMeta(path) {
  return JSON.parse(utf8.decode(await fetchVersioned(path, await build())));
}
