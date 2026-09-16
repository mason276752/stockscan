// Static-build data access: the prebuilt indexes (index/*.json) and the
// saved filings / scores (data/store/**/*.json.zst, zstd with the same
// dictionaries the server writes with), all fetched as plain files.
import { init, createDCtx, decompressUsingDict } from '@bokuweb/zstd-wasm';
// a relative path: the package's "exports" map does not expose the wasm file
import wasmUrl from '../node_modules/@bokuweb/zstd-wasm/dist/web/zstd.wasm?url';
import { url } from './base';

const cache = new Map(); // path -> Promise of parsed JSON

// The indexes change with every build: fetched with ?v=<build time> so the
// browser's HTTP cache can keep them until the next build (meta.json itself
// is always revalidated).
let build = null;
export function json(path) {
  if (!cache.has(path)) {
    cache.set(
      path,
      (async () => {
        if (path !== '/index/meta.json') build ??= meta().then((m) => m.builtAt || '');
        const v = path === '/index/meta.json' ? '' : await build;
        const res = v ? await fetchVersioned(path, v) : await fetch(url(path), { cache: 'no-cache' });
        if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
        return res.json();
      })(),
    );
    cache.get(path).catch(() => cache.delete(path));
  }
  return cache.get(path);
}

// an index file of this build: Cache Storage keyed by the build, the copies
// of earlier builds dropped
async function fetchVersioned(path, v) {
  const req = `${url(path)}?v=${encodeURIComponent(v)}`;
  let c = null;
  try {
    c = 'caches' in globalThis ? await caches.open(STORE_CACHE) : null;
    const hit = c && (await c.match(req));
    if (hit) return hit;
    if (c) for (const k of await c.keys()) if (k.url.startsWith(`${url(path)}?v=`) && k.url !== req) await c.delete(k);
  } catch {
    c = null;
  }
  const res = await fetch(req);
  if (res.ok && c) {
    try {
      await c.put(req, res.clone());
    } catch {
      /* quota: fine */
    }
  }
  return res;
}

// A saved filing / score never changes (its name carries the parser
// version), so once fetched it is kept in the browser's Cache Storage and
// never downloaded again; the same for the dictionaries.
const STORE_CACHE = 'stockscan-store-v1';
async function fetchImmutable(path) {
  const req = url(path);
  let c = null;
  try {
    c = 'caches' in globalThis ? await caches.open(STORE_CACHE) : null;
    const hit = c && (await c.match(req));
    if (hit) return hit;
  } catch {
    c = null; // no Cache Storage (insecure origin, private mode …): plain fetch
  }
  const res = await fetch(req);
  if (res.ok && c) {
    try {
      await c.put(req, res.clone());
    } catch {
      /* quota / storage error: fine, it is only a cache */
    }
  }
  return res;
}

// the indexes the build writes
export const meta = () => json('/index/meta.json');
export const tickers = () => json('/index/tickers.json');
export const companies = () => json('/index/companies.json');
export const scoresMin = () => json('/index/scores-min.json');
export const screenRowsIndex = () => json('/index/screen.json');
export const universe = () => json('/index/universe.json');
export const etfs = () => json('/index/etfs.json');
export const tvSymbols = () => json('/index/tvsymbols.json');
export const documentation = () => json('/data/store/documentation.json');

// ---- zstd with dictionary ----
let ready = null;
const dicts = {};
function zstd() {
  if (!ready) {
    ready = Promise.all([
      init(wasmUrl),
      ...['filings', 'scores'].map((kind) =>
        fetchImmutable(`/data/zdict/${kind}-v1.zdict`)
          .then((r) => r.arrayBuffer())
          .then((b) => (dicts[kind] = new Uint8Array(b))),
      ),
    ]);
  }
  return ready;
}
const utf8 = new TextDecoder();
const files = new Map(); // path -> Promise of decoded JSON (a filing never changes)

// a saved filing / score file -> the JSON the server would have read
export function readZst(kind, path) {
  if (!files.has(path)) {
    files.set(
      path,
      (async () => {
        const [res] = await Promise.all([fetchImmutable(path), zstd()]);
        if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
        const buf = new Uint8Array(await res.arrayBuffer());
        return JSON.parse(utf8.decode(decompressUsingDict(createDCtx(), buf, dicts[kind], { defaultHeapSize: 8 * 1024 * 1024 })));
      })(),
    );
    files.get(path).catch(() => files.delete(path));
  }
  return files.get(path);
}
