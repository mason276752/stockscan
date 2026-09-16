// Daily bars on disk, laid out so a settled bar is written once and never
// touched again (the directory lives in git: a changed file is a new blob):
//
//   data/bars/<source>/<SYMBOL>/<year>.zst   the bars of one calendar year, as fetched
//   data/bars/<source>/<SYMBOL>/meta.json    { symbol, source, currency, resolved, fetchedAt, adjust }
//
// Past years are immutable; only the current year's file grows. A year file
// is columnar JSON (dates as day deltas, prices as fixed-decimal integers
// relative to the previous close) under zstd - half the bytes of the
// brotli'd row JSON it replaces.
//
// A split shifts the whole history at the source. Instead of rewriting every
// year, `adjust` records it: [{ date, price, volume }] - bars before `date`
// are multiplied by the factors when read. Only when the new history does
// not line up with the old one in a single factor (a data revision) are the
// years concerned rewritten.
//
// Location: STOCKSCAN_BARS (default <repo>/data/bars). Series nobody has
// asked for in a month are dropped at startup; a small in-memory LRU of
// decoded series makes a repeated basket free.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { store } from './store.js';

const LRU_MAX = 400; // decoded series kept in memory (~100 KB each)
const MAX_AGE = 30 * 24 * 3600 * 1000; // a series nobody asked for in a month goes at startup
const TOL = 0.005; // closes within half a percent are the same bar
const ZSTD = { params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } };
const DAY = 86_400_000;

let root = null;
const lru = new Map(); // "src:SYMBOL" -> { meta, years: Map<year, raw bars>, view } (insertion order = recency)

const safe = (symbol) => String(symbol).toUpperCase().replace(/[^A-Z0-9.\-=^]/gi, '_');
const dir = (src, symbol) => path.join(root, src, safe(symbol));
const legacyFile = (src, symbol) => path.join(root, src, `${safe(symbol)}.json.br`);
const yearOf = (d) => d.date.slice(0, 4);

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

// ---- year file encoding -------------------------------------------------
// { d: decimals, t: [day deltas], o, h, l, c: [price deltas], v: [volumes] }
// t[0] is days since the epoch, the rest deltas; o and c are relative to the
// previous close (the first bar's to 0), h and l to the bar's own close.
const decimals = (x) => {
  const s = String(x);
  const i = s.indexOf('.');
  return i < 0 ? 0 : Math.min(6, s.length - i - 1);
};
export function encodeYear(days) {
  const d = Math.max(0, ...days.map((b) => Math.max(decimals(b.open), decimals(b.high), decimals(b.low), decimals(b.close))));
  const m = 10 ** d;
  const I = (x) => Math.round(x * m);
  const t = [];
  const o = [];
  const h = [];
  const l = [];
  const c = [];
  const v = [];
  let pt = 0;
  let pc = 0;
  for (const b of days) {
    const day = Math.round(Date.parse(b.date) / DAY);
    const close = I(b.close);
    t.push(day - pt);
    o.push(I(b.open) - pc);
    h.push(I(b.high) - close);
    l.push(I(b.low) - close);
    c.push(close - pc);
    v.push(Math.round(b.volume || 0));
    pt = day;
    pc = close;
  }
  return zlib.zstdCompressSync(Buffer.from(JSON.stringify({ d, t, o, h, l, c, v })), ZSTD);
}
export function decodeYear(buf) {
  const { d, t, o, h, l, c, v } = JSON.parse(zlib.zstdDecompressSync(buf).toString('utf8'));
  const m = 10 ** d;
  const out = [];
  let pt = 0;
  let pc = 0;
  for (let i = 0; i < t.length; i++) {
    pt += t[i];
    const close = pc + c[i];
    out.push({ date: new Date(pt * DAY).toISOString().slice(0, 10), open: (pc + o[i]) / m, high: (close + h[i]) / m, low: (close + l[i]) / m, close: close / m, volume: v[i] });
    pc = close;
  }
  return out;
}

// ---- adjustments ---------------------------------------------------------
// the series as a source reports it today: raw bars with every split applied
const round = (x) => Math.round(x * 1e6) / 1e6;
function adjusted(years, adjust) {
  const out = [];
  for (const year of [...years.keys()].sort()) {
    for (const b of years.get(year)) {
      let price = 1;
      let volume = 1;
      for (const a of adjust) {
        if (b.date < a.date) {
          price *= a.price;
          volume *= a.volume;
        }
      }
      out.push(price === 1 ? b : { date: b.date, open: round(b.open * price), high: round(b.high * price), low: round(b.low * price), close: round(b.close * price), volume: Math.round(b.volume * volume) });
    }
  }
  return out;
}
// the factors that turn a current-basis bar on `date` back into a raw one
function rawFactor(adjust, date) {
  let price = 1;
  let volume = 1;
  for (const a of adjust) {
    if (date < a.date) {
      price /= a.price;
      volume /= a.volume;
    }
  }
  return { price, volume };
}
const unadjust = (b, adjust) => {
  const f = rawFactor(adjust, b.date);
  return f.price === 1 ? b : { date: b.date, open: round(b.open * f.price), high: round(b.high * f.price), low: round(b.low * f.price), close: round(b.close * f.price), volume: Math.round(b.volume * f.volume) };
};
const same = (a, b) => Math.abs(a / b - 1) <= TOL;

// 16:15 New York on `date`: a bar fetched before that was still forming
const NY_HOUR = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
export function settledAt(date) {
  const noon = Date.parse(`${date}T12:00:00Z`);
  const behind = 12 - (Number(NY_HOUR.format(new Date(noon))) % 24); // hours New York is behind UTC (4 or 5)
  return noon + (4.25 + behind) * 3_600_000;
}
const isUnsettled = (rec) => {
  const last = view(rec).days.at(-1);
  return last && Date.parse(rec.meta.fetchedAt || 0) < settledAt(last.date) ? last.date : null;
};

// Compare the incoming series with the saved view over the dates both have:
// { split: { date, price, volume } | null, dates: [bars that differ and must be rewritten] }.
// A split is every bar before some date moved by one factor and nothing
// after it; the `unsettled` bar (still forming when saved) may differ freely.
export function diffSeries(view, incoming, unsettled = null) {
  const byDate = new Map(view.map((b) => [b.date, b]));
  const changed = [];
  const unchanged = [];
  const dates = [];
  for (const b of incoming) {
    const old = byDate.get(b.date);
    if (!old) continue;
    if (b.date === unsettled) {
      if (!same(b.close, old.close) || !same(b.volume || 1, old.volume || 1)) dates.push(b.date);
      continue;
    }
    (same(b.close, old.close) ? unchanged : changed).push({ date: b.date, ratio: b.close / old.close, volume: old.volume && b.volume ? b.volume / old.volume : null });
  }
  if (!changed.length) return { split: null, dates };
  const firstUnchanged = unchanged[0];
  const prefix = unchanged.every((u) => u.date > changed.at(-1).date); // every bar before some date changed, none after
  const ratio = changed[Math.floor(changed.length / 2)].ratio;
  const oneFactor = changed.every((c) => same(c.ratio, ratio));
  if (prefix && oneFactor && !same(ratio, 1) && changed.length >= 2) {
    const volumes = changed.map((c) => c.volume).filter((x) => x);
    const volume = volumes.length ? volumes[Math.floor(volumes.length / 2)] : 1 / ratio;
    // the first bar of the new basis: the first unchanged one, else the day after the last changed one
    const date = firstUnchanged?.date || new Date(Date.parse(changed.at(-1).date) + DAY).toISOString().slice(0, 10);
    return { split: { date, price: round(ratio), volume: round(volume) }, dates };
  }
  return { split: null, dates: [...dates, ...changed.map((c) => c.date)] };
}

// ---- files ---------------------------------------------------------------
function load(src, symbol) {
  const d = dir(src, symbol);
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(d, 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
  const years = new Map();
  try {
    for (const name of fs.readdirSync(d)) {
      const m = /^(\d{4})\.zst$/.exec(name);
      if (m) years.set(m[1], decodeYear(fs.readFileSync(path.join(d, name))));
    }
  } catch {
    return null;
  }
  meta.adjust ||= [];
  return { meta, years, view: null };
}
const view = (rec) => {
  rec.view ||= { ...rec.meta, days: adjusted(rec.years, rec.meta.adjust) };
  return rec.view;
};
function saveMeta(src, symbol, meta) {
  writeAtomic(path.join(dir(src, symbol), 'meta.json'), JSON.stringify(meta));
}
function saveYear(src, symbol, year, days) {
  writeAtomic(path.join(dir(src, symbol), `${year}.zst`), encodeYear(days));
}
const groupByYear = (days) => {
  const out = new Map();
  for (const b of days) (out.get(yearOf(b)) || out.set(yearOf(b), []).get(yearOf(b))).push(b);
  return out;
};

export function openBarStore(d = process.env.STOCKSCAN_BARS || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'bars')) {
  root = d;
  fs.mkdirSync(root, { recursive: true });
  migrateFromKv();
  sweep();
  setTimeout(migrateLegacy, 5000).unref();
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

// <SYMBOL>.json.br files of the previous layout (one brotli'd row JSON per
// symbol): converted on first read, and in the background for the rest
function readLegacy(f) {
  try {
    return JSON.parse(zlib.brotliDecompressSync(fs.readFileSync(f)).toString('utf8'));
  } catch {
    return null;
  }
}
function migrateLegacy() {
  const todo = [];
  for (const src of fs.readdirSync(root, { withFileTypes: true })) {
    if (!src.isDirectory()) continue;
    for (const name of fs.readdirSync(path.join(root, src.name))) if (name.endsWith('.json.br')) todo.push([src.name, name.slice(0, -'.json.br'.length)]);
  }
  if (!todo.length) return;
  console.log(`bars: ${todo.length} 檔日線轉成逐年檔（背景進行）…`);
  let i = 0;
  const step = () => {
    if (i >= todo.length) {
      console.log('bars: 轉檔完成');
      return;
    }
    const [src, symbol] = todo[i++];
    const f = legacyFile(src, symbol);
    if (fs.existsSync(f)) {
      const rec = readLegacy(f);
      if (rec?.days?.length && !fs.existsSync(path.join(dir(src, symbol), 'meta.json'))) barStore.put(src, symbol, rec);
      unlinkQuiet(f);
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

export const barStore = {
  get file() {
    return root;
  },
  // the saved series of a symbol from one source (current basis), or null
  get(src, symbol) {
    const key = `${src}:${String(symbol).toUpperCase()}`;
    const hit = lru.get(key);
    if (hit) return view(remember(key, hit));
    let rec = load(src, symbol);
    if (!rec) {
      const old = readLegacy(legacyFile(src, symbol));
      if (!old?.days?.length) return null;
      rec = barStore.put(src, symbol, old, { record: true });
      unlinkQuiet(legacyFile(src, symbol));
      return view(rec);
    }
    const now = new Date();
    try {
      fs.utimesSync(path.join(dir(src, symbol), 'meta.json'), now, now); // "used": keeps it from the sweep
    } catch {
      /* gone */
    }
    return view(remember(key, rec));
  },
  // Save a series in the source's current basis. Only what changed is
  // written: the years with new bars, a split as one line of meta, a data
  // revision as the years it touches - and the meta file every time.
  put(src, symbol, value, { record = false } = {}) {
    const key = `${src}:${String(symbol).toUpperCase()}`;
    const { days, ...meta } = value;
    const incoming = [...days].sort((a, b) => (a.date < b.date ? -1 : 1));
    const prev = lru.get(key) || load(src, symbol);
    let adjust = prev?.meta.adjust || [];
    const years = prev ? new Map(prev.years) : new Map();
    const dirty = new Set();
    if (prev) {
      const { split, dates } = diffSeries(view(prev).days, incoming, isUnsettled(prev));
      if (split) {
        adjust = [...adjust, split];
        console.log(`bars ${symbol}: ${split.date} 之前的價格 ×${split.price}（分割），歷史檔不改，記在 meta`);
      }
      for (const d of dates) dirty.add(d.slice(0, 4));
    }
    // bars we do not have yet make their year dirty; a dirty year is rebuilt
    // from the saved bars plus the incoming ones (incoming wins), stored raw
    const have = new Set(prev ? view(prev).days.map((b) => b.date) : []);
    for (const b of incoming) if (!have.has(b.date)) dirty.add(yearOf(b));
    const byYear = groupByYear(incoming);
    for (const year of dirty) {
      const merged = new Map((years.get(year) || []).map((b) => [b.date, b]));
      for (const b of byYear.get(year) || []) merged.set(b.date, unadjust(b, adjust));
      const rows = [...merged.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
      years.set(year, rows);
      saveYear(src, symbol, year, rows);
    }
    meta.adjust = adjust;
    delete meta.incremental;
    saveMeta(src, symbol, meta);
    const rec = remember(key, { meta, years, view: null });
    return record ? rec : view(rec);
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

// Splice freshly fetched bars (the tail of the series, fetched with a few
// days of overlap) onto the saved ones. The overlap must agree - a split or
// an adjustment change since the last fetch shifts the whole history, and
// then only a full refetch is right: returns null. The saved bar of
// `unsettled` (fetched during its session, so still forming) may differ.
export function mergeDays(saved, fresh, unsettled = null) {
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
    if (d.date === unsettled) continue;
    checked++;
    if (!same(f.close, d.close)) return null;
  }
  if (!checked && saved.at(-1).date !== unsettled) return null;
  return [...saved.filter((d) => d.date < first), ...fresh];
}
