// Daily bars on disk, one file per symbol and source:
//   data/bars/<source>/<SYMBOL>.json.br   { symbol, source, currency, resolved, fetchedAt, days: [...] }
// separate from the kv cache because they are most of its bytes, have their
// own lifecycle (refreshed by appending the bars since the last one, dropped
// after a month unused), and are read a hundred at a time for a basket - a
// small in-memory LRU of decoded series makes a repeated basket free.
// Not for git (a cache). Location: STOCKSCAN_BARS (default ./data/bars).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { store } from './store.js';

const EXT = '.json.br';
const LRU_MAX = 400; // decoded series kept in memory (~100 KB each)
const MAX_AGE = 30 * 24 * 3600 * 1000; // a series nobody asked for in a month goes at startup
const BROTLI = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } };

let root = null;
const lru = new Map(); // "src:SYMBOL" -> record (insertion order = recency)

const file = (src, symbol) => path.join(root, src, `${String(symbol).toUpperCase().replace(/[^A-Z0-9.\-=^]/gi, '_')}${EXT}`);

function remember(key, rec) {
  lru.delete(key);
  lru.set(key, rec);
  if (lru.size > LRU_MAX) lru.delete(lru.keys().next().value);
  return rec;
}

export function openBarStore(dir = process.env.STOCKSCAN_BARS || path.join(process.cwd(), 'data', 'bars')) {
  root = dir;
  fs.mkdirSync(root, { recursive: true });
  migrateFromKv();
  sweep();
  return root;
}

// bars saved by earlier versions in the kv cache: move them over once
function migrateFromKv() {
  const keys = store.kvKeys('bars:');
  if (!keys.length) return;
  let n = 0;
  for (const key of keys) {
    const m = /^bars:([a-z0-9]+):(.+)$/.exec(key);
    const saved = m && store.getKV(key);
    if (saved?.value?.days?.length) {
      barStore.put(m[1], m[2], saved.value);
      n++;
    }
    store.deleteKV(key);
  }
  store.compactKV();
  console.log(`bars: ${n} 檔日線從 kv 快取搬到 ${root}/`);
}

// drop series untouched for a month; a read touches the file's mtime
function sweep() {
  const cutoff = Date.now() - MAX_AGE;
  let n = 0;
  for (const src of fs.readdirSync(root, { withFileTypes: true })) {
    if (!src.isDirectory()) continue;
    for (const name of fs.readdirSync(path.join(root, src.name))) {
      const f = path.join(root, src.name, name);
      try {
        if (fs.statSync(f).mtimeMs < cutoff) {
          fs.unlinkSync(f);
          n++;
        }
      } catch {
        /* gone */
      }
    }
  }
  if (n) console.log(`bars: 清掉 ${n} 檔一個月沒用到的日線`);
}

export const barStore = {
  get file() {
    return root;
  },
  // the saved series of a symbol from one source, or null
  get(src, symbol) {
    const key = `${src}:${String(symbol).toUpperCase()}`;
    const hit = lru.get(key);
    if (hit) return remember(key, hit);
    const f = file(src, symbol);
    let buf;
    try {
      buf = fs.readFileSync(f);
    } catch {
      return null;
    }
    try {
      const rec = JSON.parse(zlib.brotliDecompressSync(buf).toString('utf8'));
      const now = new Date();
      fs.utimesSync(f, now, now); // "used": keeps it from the sweep
      return remember(key, rec);
    } catch {
      try {
        fs.unlinkSync(f);
      } catch {
        /* gone */
      }
      return null;
    }
  },
  put(src, symbol, rec) {
    const f = file(src, symbol);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, zlib.brotliCompressSync(Buffer.from(JSON.stringify(rec)), BROTLI));
    fs.renameSync(tmp, f);
    return remember(`${src}:${String(symbol).toUpperCase()}`, rec);
  },
  stats() {
    let files = 0;
    let bytes = 0;
    if (root) {
      for (const src of fs.readdirSync(root, { withFileTypes: true })) {
        if (!src.isDirectory()) continue;
        for (const name of fs.readdirSync(path.join(root, src.name))) {
          try {
            bytes += fs.statSync(path.join(root, src.name, name)).size;
            files++;
          } catch {
            /* gone */
          }
        }
      }
    }
    return { files, bytes, inMemory: lru.size };
  },
};

// Splice freshly fetched bars (the tail of the series, fetched with a few
// days of overlap) onto the saved ones. The overlap must agree - a split or
// an adjustment change since the last fetch shifts the whole history, and
// then only a full refetch is right: returns null.
export function mergeDays(saved, fresh) {
  if (!fresh.length) return saved;
  if (!saved.length) return fresh;
  const first = fresh[0].date;
  if (saved.at(-1).date < first) return null; // no overlap: cannot tell whether the history still matches
  const byDate = new Map(fresh.map((d) => [d.date, d]));
  let checked = 0;
  for (const d of saved) {
    if (d.date < first) continue;
    const f = byDate.get(d.date);
    if (!f) continue;
    checked++;
    if (Math.abs(f.close / d.close - 1) > 0.005) return null;
  }
  if (!checked) return null;
  return [...saved.filter((d) => d.date < first), ...fresh];
}
