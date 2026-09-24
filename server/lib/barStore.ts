// Daily bars on disk, laid out so a settled bar is written once and never
// touched again (the directory lives in git: a changed file is a new blob):
//
//   data/bars/<source>/<SYMBOL>/<year>.zst   the bars of one finished calendar year - never rewritten
//   data/bars/<source>/<SYMBOL>/meta.json    { symbol, source, currency, resolved, years, adjust }
//   data/bars/<source>/<SYMBOL>/head.zst     this year's bars + fetchedAt: the one file that grows (.gitignore)
//
// The year files and meta.json are what git holds; meta changes only when a
// year is closed (`years`) or a split is recorded (`adjust`). head.zst is
// rewritten by every refresh and is not committed - a fresh checkout has the
// history to the end of last year and fetches this year's bars itself. On the
// first write of a new year the old head is sealed into <year>.zst.
//
// The file format and the split arithmetic are in barFormat.js (shared with
// the static site, which reads these files in the browser).
//
// Location: STOCKSCAN_BARS (default <repo>/data/bars). Series nobody has
// asked for in a month are dropped at startup; a small in-memory LRU of
// decoded series makes a repeated basket free.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { store } from './store.ts';
import { adjusted, decodeBars, diffSeries, encodeBars, same, settledAt, unadjust, yearOf } from './barFormat.ts';

export { mergeDays, settledAt } from './barFormat.ts';

const LRU_MAX = 400; // decoded series kept in memory (~100 KB each)
const MAX_AGE = 30 * 24 * 3600 * 1000; // a series nobody asked for in a month goes at startup
const ZSTD = { params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } };

let root = null;
const lru = new Map(); // "src:SYMBOL" -> { meta, years: Map<year, raw bars>, head: raw bars, fetchedAt, view } (insertion order = recency)

const safe = (symbol) => String(symbol).toUpperCase().replace(/[^A-Z0-9.\-=^]/gi, '_');
const dir = (src, symbol) => path.join(root, src, safe(symbol));
const legacyFile = (src, symbol) => path.join(root, src, `${safe(symbol)}.json.br`);
const thisYear = () => new Date().toISOString().slice(0, 4);
const pack = (obj) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(obj)), ZSTD);
const unpack = (buf) => JSON.parse(zlib.zstdDecompressSync(buf).toString('utf8'));
const byDate = (a, b) => (a.date < b.date ? -1 : 1);

function remember(key, rec) {
  lru.delete(key);
  lru.set(key, rec);
  if (lru.size > LRU_MAX) lru.delete(lru.keys().next().value);
  return rec;
}

function writeAtomic(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}
const unlinkQuiet = (f) => {
  try {
    fs.unlinkSync(f);
  } catch {
    /* gone */
  }
};

// ---- files ---------------------------------------------------------------
// { meta, years: Map<finished year, raw bars>, head: raw bars of this year, fetchedAt, view: null }
function load(src, symbol) {
  const d = dir(src, symbol);
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(d, 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
  const years = new Map();
  const head = [];
  let fetchedAt = null;
  const current = thisYear();
  try {
    for (const name of fs.readdirSync(d)) {
      const m = /^(\d{4})\.zst$/.exec(name);
      if (m) {
        const bars = decodeBars(unpack(fs.readFileSync(path.join(d, name))));
        // a year file of the running year: the layout before head.zst - becomes the head on the next write
        if (m[1] >= current) head.push(...bars);
        else years.set(m[1], bars);
      } else if (name === 'head.zst') {
        const h = unpack(fs.readFileSync(path.join(d, name)));
        fetchedAt = h.fetchedAt || null;
        head.push(...decodeBars(h));
      }
    }
  } catch {
    return null;
  }
  head.sort(byDate);
  fetchedAt ??= meta.fetchedAt || null; // meta.json of the previous layout carried it
  meta.adjust ||= [];
  return { meta, years, head, fetchedAt, view: null };
}
// every bar the record holds, oldest first, as the files have them
function rawBars(rec) {
  const raw = [];
  for (const year of [...rec.years.keys()].sort()) raw.push(...rec.years.get(year));
  raw.push(...rec.head);
  return raw;
}
// the record as a series in the source's current basis (what callers see)
function view(rec) {
  if (!rec.view) {
    const { fetchedAt: _old, years: _years, ...meta } = rec.meta;
    rec.view = { ...meta, fetchedAt: rec.fetchedAt, days: adjusted(rawBars(rec), rec.meta.adjust) };
  }
  return rec.view;
}
const isUnsettled = (rec) => {
  const last = view(rec).days.at(-1);
  return last && Date.parse(rec.fetchedAt || 0) < settledAt(last.date) ? last.date : null;
};

export function openBarStore(d = process.env.STOCKSCAN_BARS || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'bars')) {
  root = d;
  fs.mkdirSync(root, { recursive: true });
  migrateFromKv();
  sweep();
  setTimeout(migrateLayout, 5000).unref();
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

// Earlier layouts, converted in the background (and on first read):
//   <SYMBOL>.json.br            one brotli'd row JSON per symbol
//   <SYMBOL>/<this year>.zst    the running year as a year file, fetchedAt in meta.json
function readLegacy(f) {
  try {
    return JSON.parse(zlib.brotliDecompressSync(fs.readFileSync(f)).toString('utf8'));
  } catch {
    return null;
  }
}
function migrateLayout() {
  const todo = [];
  const current = `${thisYear()}.zst`;
  for (const src of fs.readdirSync(root, { withFileTypes: true })) {
    if (!src.isDirectory()) continue;
    for (const e of fs.readdirSync(path.join(root, src.name), { withFileTypes: true })) {
      if (e.name.endsWith('.json.br')) todo.push([src.name, e.name.slice(0, -'.json.br'.length), 'br']);
      else if (e.isDirectory() && fs.existsSync(path.join(root, src.name, e.name, current))) todo.push([src.name, e.name, 'year']);
    }
  }
  if (!todo.length) return;
  console.log(`bars: ${todo.length} 檔日線轉成新版檔案配置（背景進行）…`);
  let i = 0;
  const step = () => {
    if (i >= todo.length) {
      console.log('bars: 轉檔完成');
      return;
    }
    const [src, symbol, kind] = todo[i++];
    try {
      if (kind === 'br') {
        const f = legacyFile(src, symbol);
        const rec = readLegacy(f);
        if (rec?.days?.length && !fs.existsSync(path.join(dir(src, symbol), 'meta.json'))) barStore.put(src, symbol, rec, { keep: false });
        unlinkQuiet(f);
      } else {
        const rec = lru.get(`${src}:${symbol}`) || load(src, symbol);
        if (rec) save(src, symbol, rec);
      }
    } catch (err) {
      console.warn(`bars: ${src}/${symbol} 轉檔失敗：${err.message}`);
    }
    setTimeout(step, 20).unref();
  };
  step();
}

// drop series untouched for a month; a read touches meta.json's mtime
function sweep() {
  const cutoff = Date.now() - MAX_AGE;
  let n = 0;
  for (const src of fs.readdirSync(root, { withFileTypes: true })) {
    if (!src.isDirectory()) continue;
    for (const name of fs.readdirSync(path.join(root, src.name), { withFileTypes: true })) {
      const f = path.join(root, src.name, name.name);
      try {
        if (name.isDirectory()) {
          if (fs.statSync(path.join(f, 'meta.json')).mtimeMs < cutoff) {
            fs.rmSync(f, { recursive: true, force: true });
            n++;
          }
        } else if (fs.statSync(f).mtimeMs < cutoff) {
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

// Write a record: the dirty finished years, the head (always: fetchedAt
// changed) and meta.json only when its content changed. Bars of a finished
// year still sitting in the head (the year turned since the last write) are
// sealed into their year file first.
function save(src, symbol, rec, dirtyYears = new Set()) {
  const d = dir(src, symbol);
  const current = thisYear();
  const sealed = rec.head.filter((b) => yearOf(b) < current);
  if (sealed.length) {
    for (const [year, bars] of groupByYear(sealed)) {
      rec.years.set(year, [...(rec.years.get(year) || []), ...bars].sort(byDate));
      dirtyYears.add(year);
    }
    rec.head = rec.head.filter((b) => yearOf(b) >= current);
  }
  for (const year of dirtyYears) writeAtomic(path.join(d, `${year}.zst`), pack(encodeBars(rec.years.get(year) || [])));
  const meta = { symbol: rec.meta.symbol, source: rec.meta.source, currency: rec.meta.currency ?? null, resolved: rec.meta.resolved ?? null, years: [...rec.years.keys()].sort(), adjust: rec.meta.adjust || [] };
  const json = JSON.stringify(meta);
  let onDisk = null;
  try {
    onDisk = fs.readFileSync(path.join(d, 'meta.json'), 'utf8');
  } catch {
    /* new */
  }
  if (json !== onDisk) writeAtomic(path.join(d, 'meta.json'), json);
  rec.meta = meta;
  writeAtomic(path.join(d, 'head.zst'), pack({ fetchedAt: rec.fetchedAt, ...encodeBars(rec.head) }));
  unlinkQuiet(path.join(d, `${current}.zst`)); // the previous layout's file for the running year
  rec.view = null;
}
function groupByYear(days) {
  const out = new Map();
  for (const b of days) (out.get(yearOf(b)) || out.set(yearOf(b), []).get(yearOf(b))).push(b);
  return out;
}

// Put `rows` - bars in the source's current basis - into one year of a
// record, keeping whatever else that year already holds (the incoming bar
// wins) and storing them raw. A finished year is marked dirty: its file has
// to be rewritten, which is what the split record exists to avoid.
function rewriteYear(rec, year, rows, current, dirtyYears) {
  const inHead = year >= current;
  const merged = new Map((inHead ? rec.head.filter((b) => yearOf(b) === year) : rec.years.get(year) || []).map((b) => [b.date, b]));
  for (const b of rows) merged.set(b.date, unadjust(b, rec.meta.adjust));
  const out = [...merged.values()].sort(byDate);
  if (inHead) rec.head = [...rec.head.filter((b) => yearOf(b) !== year), ...out].sort(byDate);
  else {
    rec.years.set(year, out);
    dirtyYears.add(year);
  }
  rec.view = null;
}

// The bars the record would now hand back differently from the source.
const offBy = (rec, incoming) => {
  const saved = new Map(view(rec).days.map((b) => [b.date, b]));
  return incoming.filter((b) => saved.has(b.date) && !same(saved.get(b.date).close, b.close));
};

// bytes of a file or of everything under a directory
function du(f) {
  const st = fs.statSync(f);
  if (!st.isDirectory()) return st.size;
  let bytes = 0;
  for (const e of fs.readdirSync(f)) {
    try {
      bytes += du(path.join(f, e));
    } catch {
      /* gone */
    }
  }
  return bytes;
}

export const barStore = {
  get file() {
    return root;
  },
  // fetchedAt of a saved series (is it fresh?) without decoding its bars, or null
  fetchedAt(src, symbol) {
    const hit = lru.get(`${src}:${String(symbol).toUpperCase()}`);
    if (hit) return hit.fetchedAt;
    const d = dir(src, symbol);
    try {
      return unpack(fs.readFileSync(path.join(d, 'head.zst'))).fetchedAt || null;
    } catch {
      /* no head yet */
    }
    try {
      return JSON.parse(fs.readFileSync(path.join(d, 'meta.json'), 'utf8')).fetchedAt || null; // the previous layout
    } catch {
      return null;
    }
  },
  // the saved series of a symbol from one source (current basis), or null.
  // keep: false leaves it out of the LRU (a crawl of thousands of symbols
  // must not push the user's baskets out of it).
  get(src, symbol, { keep = true } = {}) {
    const key = `${src}:${String(symbol).toUpperCase()}`;
    const hit = lru.get(key);
    if (hit) return view(keep ? remember(key, hit) : hit);
    let rec = load(src, symbol);
    if (!rec) {
      const old = readLegacy(legacyFile(src, symbol));
      if (!old?.days?.length) return null;
      rec = barStore.put(src, symbol, old, { record: true, keep });
      unlinkQuiet(legacyFile(src, symbol));
      return view(rec);
    }
    const now = new Date();
    try {
      fs.utimesSync(path.join(dir(src, symbol), 'meta.json'), now, now); // "used": keeps it from the sweep
    } catch {
      /* gone */
    }
    return view(keep ? remember(key, rec) : rec);
  },
  // Save a series in the source's current basis. Only what changed is
  // written: the head (this year), a split as one line of meta, a data
  // revision as the finished years it touches.
  put(src, symbol, value, { record = false, keep = true } = {}) {
    const key = `${src}:${String(symbol).toUpperCase()}`;
    const { days, fetchedAt, incremental: _n, ...meta } = value;
    const incoming = [...days].sort(byDate);
    const prev = lru.get(key) || load(src, symbol);
    const rec = prev || { meta: { adjust: [] }, years: new Map(), head: [], fetchedAt: null, view: null };
    rec.meta = { ...rec.meta, symbol: meta.symbol || rec.meta.symbol, source: meta.source || rec.meta.source, currency: meta.currency ?? rec.meta.currency ?? null, resolved: meta.resolved ?? rec.meta.resolved ?? null };
    const dirty = new Set(); // years whose bars change
    if (prev) {
      const { split, dates } = diffSeries(view(prev).days, incoming, isUnsettled(prev));
      if (split) {
        rec.meta.adjust = [...rec.meta.adjust, split];
        rec.view = null; // the decoded series is now a factor out of date
        console.log(`bars ${symbol}: ${split.date} 之前的價格 ×${split.price}（分割），歷史檔不改，記在 meta`);
      }
      for (const d of dates) dirty.add(d.slice(0, 4));
    }
    const have = new Set(prev ? view(prev).days.map((b) => b.date) : []);
    for (const b of incoming) if (!have.has(b.date)) dirty.add(yearOf(b));
    // Whatever the factors worked out to, a reader has to see the source's
    // own series: a shared date the saved bars still disagree with is
    // rewritten from the incoming one. A split that reconciles every bar
    // adds nothing here - this is what stops a single bar left behind on the
    // old basis from standing in the chart as a 25x spike nobody can explain.
    if (prev) {
      const nowSaved = new Map(adjusted(rawBars(rec), rec.meta.adjust).map((b) => [b.date, b]));
      for (const b of incoming) {
        const was = nowSaved.get(b.date);
        if (was && !same(was.close, b.close)) dirty.add(yearOf(b));
      }
    }
    // a dirty year is rebuilt from the saved bars plus the incoming ones (incoming wins), stored raw
    const current = thisYear();
    const grouped = groupByYear(incoming);
    const dirtyYears = new Set();
    for (const year of dirty) rewriteYear(rec, year, grouped.get(year) || [], current, dirtyYears);
    // A split is one line of meta and the bars before its date are multiplied
    // on the way out - right only while that reproduces what the source
    // sends. Whatever it does not is written out as its own raw bar: a bar
    // saved mid-session on the old basis lands on the wrong side of the
    // date the factor starts, and then reads back 25x too low for ever.
    // It is one bar, not a rewrite of the history.
    const off = offBy(rec, incoming);
    if (off.length) {
      for (const [year, rows] of groupByYear(off)) rewriteYear(rec, year, rows, current, dirtyYears);
      console.log(`bars ${symbol}: ${off.length} 根跟來源對不上（分割調整的交界），那幾根直接改寫`);
    }
    rec.fetchedAt = fetchedAt || new Date().toISOString();
    save(src, symbol, rec, dirtyYears);
    if (keep || lru.has(key)) remember(key, rec);
    return record ? rec : view(rec);
  },
  // Series of symbols the ticker table no longer carries - delisted, or
  // moved to the OTC market - go from disk (the caller names the benchmark
  // ETFs, which are in no ticker table). A short list is a truncated
  // download, not an empty market: it purges nothing.
  purgeExcept(symbols) {
    if (!root) return null;
    const keep = new Set((symbols || []).filter(Boolean).map((x) => safe(x)));
    if (keep.size < 100) return null;
    let n = 0;
    let bytes = 0;
    for (const src of fs.readdirSync(root, { withFileTypes: true })) {
      if (!src.isDirectory()) continue;
      for (const e of fs.readdirSync(path.join(root, src.name), { withFileTypes: true })) {
        const symbol = e.isDirectory() ? e.name : e.name.replace(/\.json\.br$/, '');
        if (keep.has(safe(symbol))) continue;
        const f = path.join(root, src.name, e.name);
        try {
          bytes += du(f);
          fs.rmSync(f, { recursive: true, force: true });
          n++;
        } catch {
          /* gone */
        }
        lru.delete(`${src.name}:${String(symbol).toUpperCase()}`);
      }
    }
    return { symbols: n, bytes };
  },
  stats() {
    let files = 0;
    let bytes = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else {
          try {
            bytes += fs.statSync(f).size;
            files++;
          } catch {
            /* gone */
          }
        }
      }
    };
    if (root) walk(root);
    return { files, bytes, inMemory: lru.size };
  },
};
