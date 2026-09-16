// Static-build data access: the prebuilt indexes (index/*.json) and the
// saved filings / scores (data/store/**/*.json.zst, zstd with the same
// dictionaries the server writes with), all fetched as plain files.
import { init, createDCtx, decompressUsingDict } from '@bokuweb/zstd-wasm';
// a relative path: the package's "exports" map does not expose the wasm file
import wasmUrl from '../node_modules/@bokuweb/zstd-wasm/dist/web/zstd.wasm?url';
import { url } from './base';

const cache = new Map(); // path -> Promise of parsed JSON

export function json(path) {
  if (!cache.has(path)) {
    cache.set(
      path,
      fetch(url(path)).then((res) => {
        if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
        return res.json();
      }),
    );
  }
  return cache.get(path);
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
        fetch(url(`/data/zdict/${kind}-v1.zdict`))
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
        const [res] = await Promise.all([fetch(url(path)), zstd()]);
        if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
        const buf = new Uint8Array(await res.arrayBuffer());
        return JSON.parse(utf8.decode(decompressUsingDict(createDCtx(), buf, dicts[kind], { defaultHeapSize: 8 * 1024 * 1024 })));
      })(),
    );
    files.get(path).catch(() => files.delete(path));
  }
  return files.get(path);
}
