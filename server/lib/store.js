// Local persistence, laid out so the data can live in git (many small
// immutable files, no file near GitHub's 100 MB limit, no LFS):
//
//   data/store/filings/<cik>/<accession>__<period end>__<form>__v<parser>.json.br
//       the parsed statements of one filing (brotli JSON). A filed document
//       never changes, so a file is written once and kept; a parser version
//       bump deletes it and it is re-fetched. The four primary statements
//       are not stored twice: `statements` is rebuilt from `allStatements`.
//   data/store/scores/<cik>/<accession>__<period end>__v<score version>.json.br
//       the score of one filing
//   data/store/documentation.json
//       SEC's definition of every standard concept seen (us-gaap: … ), one
//       copy instead of one per filing (a fifth of a filing's bytes)
//   data/cache.sqlite   (not for git)
//       kv cache: ticker table, submissions, daily bars, market snapshot …
//
// Everything the store knows about which files exist is read from the file
// names at startup (no index file to drift). Writes are atomic (temp + rename).
// The old single-file SQLite store (data/stockscan.sqlite) is migrated on
// first start when the directory is still empty.
// Locations: STOCKSCAN_STORE (default ./data/store), STOCKSCAN_CACHE
// (default ./data/cache.sqlite), STOCKSCAN_DB (the legacy SQLite to migrate).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { pickPrimary } from './statements.js';

const EXT = '.json.br';
const STD = /^(us-gaap|ifrs-full|dei|srt):/;
const BROTLI = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } };
const pack = (value) => zlib.brotliCompressSync(Buffer.from(JSON.stringify(value)), BROTLI);
const unpack = (buf) => JSON.parse(zlib.brotliDecompressSync(buf).toString('utf8'));
// the legacy SQLite rows: gzip'd JSON, or plain text from even older versions
const unpackLegacy = (col) => JSON.parse(col instanceof Uint8Array ? zlib.gunzipSync(col).toString('utf8') : col);

let root = null; // data/store
let cache = null; // the kv SQLite
const filings = new Map(); // accession -> { cik, form, reportDate, version, file, bytes }
const scores = new Map(); // accession -> { cik, reportDate, version, file }
let docs = {}; // concept -> SEC documentation (standard concepts)
let docsDirty = false;
let docsTimer = null;

// file name <-> record. Forms carry a slash (10-K/A): '~' in the name.
const safe = (s) => String(s ?? '-').replace(/\//g, '~').replace(/[^A-Za-z0-9.~-]/g, '_') || '-';
const unsafe = (s) => (s === '-' ? null : s.replace(/~/g, '/'));
const filingName = (accession, reportDate, form, version) => `${accession}__${safe(reportDate)}__${safe(form)}__v${version}${EXT}`;
const scoreName = (accession, reportDate, version) => `${accession}__${safe(reportDate)}__v${version}${EXT}`;
const FILING_RE = /^(.+?)__(.+?)__(.+?)__v(\d+)\.json\.br$/;
const SCORE_RE = /^(.+?)__(.+?)__v(\d+)\.json\.br$/;

const dir = (kind, cik) => path.join(root, kind, String(cik));

function writeAtomic(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}
const unlinkQuiet = (file) => {
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
};
const rmdirQuiet = (d) => {
  try {
    fs.rmdirSync(d);
  } catch {
    /* not empty / gone */
  }
};

// scan the tree once: file names carry everything the indexes need
function scan(kind, re, into, make) {
  into.clear();
  const base = path.join(root, kind);
  if (!fs.existsSync(base)) return;
  for (const cikDir of fs.readdirSync(base, { withFileTypes: true })) {
    if (!cikDir.isDirectory() || !/^\d+$/.test(cikDir.name)) continue;
    const cik = Number(cikDir.name);
    for (const name of fs.readdirSync(path.join(base, cikDir.name))) {
      const m = re.exec(name);
      if (!m) continue;
      const file = path.join(base, cikDir.name, name);
      const rec = make(m, cik, file);
      // two files for one accession (a crash between write and delete): keep the newest version
      const prev = into.get(rec.accession);
      if (prev && prev.version > rec.version) {
        unlinkQuiet(file);
        continue;
      }
      if (prev) unlinkQuiet(prev.file);
      into.set(rec.accession, rec);
    }
  }
}
const scanFilings = () =>
  scan('filings', FILING_RE, filings, (m, cik, file) => ({ accession: m[1], cik, reportDate: unsafe(m[2]), form: unsafe(m[3]), version: Number(m[4]), file, bytes: fs.statSync(file).size }));
const scanScores = () => scan('scores', SCORE_RE, scores, (m, cik, file) => ({ accession: m[1], cik, reportDate: unsafe(m[2]), version: Number(m[3]), file }));

function loadDocs() {
  try {
    docs = JSON.parse(fs.readFileSync(path.join(root, 'documentation.json'), 'utf8')) || {};
  } catch {
    docs = {};
  }
}
function flushDocs() {
  clearTimeout(docsTimer);
  docsTimer = null;
  if (!docsDirty || !root) return;
  docsDirty = false;
  const sorted = Object.fromEntries(Object.keys(docs).sort().map((k) => [k, docs[k]]));
  writeAtomic(path.join(root, 'documentation.json'), JSON.stringify(sorted, null, 1));
}
function scheduleDocs() {
  docsDirty = true;
  if (!docsTimer) docsTimer = setTimeout(flushDocs, 5000).unref();
}

// what goes into a filing file: no `statements` (rebuilt from allStatements),
// standard concepts' documentation moved to the shared dictionary
function slim(result) {
  const { statements, ...rest } = result;
  rest.allStatements = (rest.allStatements || []).map((st) => ({
    ...st,
    lineItems: (st.lineItems || []).map((li) => {
      if (!li.documentation || !STD.test(li.concept)) return li;
      if (docs[li.concept] !== li.documentation) {
        docs[li.concept] = li.documentation;
        scheduleDocs();
      }
      const { documentation, ...x } = li;
      return x;
    }),
  }));
  return rest;
}
function fatten(result) {
  for (const st of result.allStatements || []) {
    for (const li of st.lineItems || []) if (!li.documentation && STD.test(li.concept) && docs[li.concept]) li.documentation = docs[li.concept];
  }
  if (!result.statements) result.statements = pickPrimary(result.allStatements || []);
  return result;
}

export function openStore(storeDir = process.env.STOCKSCAN_STORE || path.join(process.cwd(), 'data', 'store'), cacheFile = process.env.STOCKSCAN_CACHE || path.join(process.cwd(), 'data', 'cache.sqlite')) {
  root = storeDir;
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  cache = new DatabaseSync(cacheFile);
  cache.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS kv (
      key        TEXT PRIMARY KEY,
      json       BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  loadDocs();
  scanFilings();
  scanScores();
  migrateLegacy(process.env.STOCKSCAN_DB || path.join(process.cwd(), 'data', 'stockscan.sqlite'));
  compactCache();
  process.on('exit', flushDocs);
  return root;
}

// Housekeeping for the kv cache at startup: rows still stored as plain text
// (first migration pass) get packed and the file is shrunk.
function compactCache() {
  const stale = 0;
  const text = cache.prepare("SELECT key FROM kv WHERE typeof(json) = 'text'").all().map((r) => r.key);
  if (text.length) {
    const get = cache.prepare('SELECT json FROM kv WHERE key = ?');
    const put = cache.prepare('UPDATE kv SET json = ? WHERE key = ?');
    for (let i = 0; i < text.length; i += 200) {
      cache.exec('BEGIN');
      for (const key of text.slice(i, i + 200)) {
        const row = get.get(key);
        if (row && typeof row.json === 'string') put.run(kvPack(JSON.parse(row.json)), key);
      }
      cache.exec('COMMIT');
    }
  }
  if (stale || text.length) {
    cache.exec('VACUUM');
    console.log(`store: 快取整理：壓縮 ${text.length} 筆純文字列`);
  }
  cache.exec('PRAGMA wal_checkpoint(TRUNCATE)'); // fold the WAL back into the file so it does not sit at its high-water mark
}

// The previous single-file SQLite store: copy everything over once (the
// store directory is empty, the old file exists), then leave the old file
// alone for the user to delete.
function migrateLegacy(file) {
  if (filings.size || !fs.existsSync(file)) return;
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    if (!tables.has('filings')) return;
    console.log(`store: 從舊的 ${file} 搬到 ${root}/ …`);
    let n = 0;
    for (const r of db.prepare('SELECT accession, cik, version, fetched_at, json FROM filings').iterate()) {
      const data = unpackLegacy(r.json);
      store.putFiling(r.accession, r.cik, data, r.version, r.fetched_at);
      if (++n % 1000 === 0) console.log(`store: 財報 ${n} 份…`);
    }
    let s = 0;
    if (tables.has('scores')) {
      for (const r of db.prepare('SELECT accession, cik, report_date, version, json FROM scores').iterate()) {
        store.putScore(r.accession, r.cik, r.report_date, r.version, unpackLegacy(r.json));
        s++;
      }
    }
    let k = 0;
    if (tables.has('kv')) {
      const put = cache.prepare('INSERT OR REPLACE INTO kv (key, json, updated_at) VALUES (?, ?, ?)');
      cache.exec('BEGIN');
      for (const r of db.prepare('SELECT key, json, updated_at FROM kv').iterate()) {
        put.run(r.key, kvPack(unpackLegacy(r.json)), r.updated_at);
        k++;
      }
      cache.exec('COMMIT');
    }
    flushDocs();
    console.log(`store: 搬完 ${n} 份財報、${s} 筆評分、${k} 筆快取；${file} 可以刪掉了`);
  } catch (err) {
    console.warn(`store: 舊資料庫搬移失敗：${err.message}`);
  } finally {
    db?.close();
  }
}

// files written by another parser version are thrown away (rebuilt on demand)
export function requireVersion(version) {
  let n = 0;
  for (const [acc, f] of filings) {
    if (f.version === version) continue;
    unlinkQuiet(f.file);
    rmdirQuiet(path.dirname(f.file));
    filings.delete(acc);
    n++;
  }
  if (n) console.log(`store: dropped ${n} filings parsed by an older version`);
}

const need = () => {
  if (!root) throw new Error('store not opened');
  return root;
};
// the kv cache is brotli'd too (fast setting: the market snapshot is rewritten every half hour)
const KV_BROTLI = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } };
const kvPack = (value) => zlib.brotliCompressSync(Buffer.from(JSON.stringify(value)), KV_BROTLI);
const kvUnpack = (col) => (col instanceof Uint8Array ? unpack(col) : JSON.parse(col));

export const store = {
  get file() {
    return root;
  },

  getFiling(accession) {
    need();
    const f = filings.get(accession);
    if (!f) return null;
    try {
      return fatten(unpack(fs.readFileSync(f.file)).data);
    } catch (err) {
      console.warn(`store: ${path.basename(f.file)} unreadable (${err.message}), dropped`);
      unlinkQuiet(f.file);
      filings.delete(accession);
      return null;
    }
  },
  hasFiling(accession) {
    need();
    return filings.has(accession);
  },
  putFiling(accession, cik, result, version, fetchedAt = new Date().toISOString()) {
    need();
    const reportDate = result.filing?.periodEnd ?? null;
    const form = result.filing?.form ?? null;
    const file = path.join(dir('filings', cik), filingName(accession, reportDate, form, version));
    const buf = pack({ accession, cik, form, reportDate, version, fetchedAt, data: slim(result) });
    writeAtomic(file, buf);
    const prev = filings.get(accession);
    if (prev && prev.file !== file) unlinkQuiet(prev.file);
    filings.set(accession, { accession, cik: Number(cik), form, reportDate, version, file, bytes: buf.length });
  },
  filingCount(cik = null) {
    need();
    if (cik == null) return filings.size;
    let n = 0;
    for (const f of filings.values()) if (f.cik === Number(cik)) n++;
    return n;
  },
  // accession -> report_date of every saved filing of a company (cheap: no file reads)
  filingIndex(cik) {
    need();
    const out = [];
    for (const f of filings.values()) if (f.cik === Number(cik)) out.push({ accession: f.accession, form: f.form, report_date: f.reportDate });
    return out;
  },

  // kv entries come back with their age so callers can apply their own TTL
  getKV(key) {
    const row = cache.prepare('SELECT json, updated_at FROM kv WHERE key = ?').get(key);
    if (!row) return null;
    const value = kvUnpack(row.json);
    // a row written as plain text (first migration pass): re-pack it on the way out
    if (typeof row.json === 'string') cache.prepare('UPDATE kv SET json = ? WHERE key = ?').run(kvPack(value), key);
    return { value, ageMs: Date.now() - row.updated_at };
  },
  putKV(key, value) {
    cache.prepare('INSERT OR REPLACE INTO kv (key, json, updated_at) VALUES (?, ?, ?)').run(key, kvPack(value), Date.now());
  },
  kvKeys(prefix) {
    return cache.prepare('SELECT key FROM kv WHERE substr(key, 1, ?) = ?').all(prefix.length, prefix).map((r) => r.key);
  },
  deleteKV(key) {
    cache.prepare('DELETE FROM kv WHERE key = ?').run(key);
  },
  compactKV() {
    cache.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
  },

  // scores: one per filing, keyed by accession, invalidated by version
  getScore(accession, version) {
    need();
    const s = scores.get(accession);
    if (!s || s.version !== version) return null;
    return this.scoreJson(accession);
  },
  putScore(accession, cik, reportDate, version, score) {
    need();
    const file = path.join(dir('scores', cik), scoreName(accession, reportDate, version));
    writeAtomic(file, pack({ accession, cik, reportDate, version, score }));
    const prev = scores.get(accession);
    if (prev && prev.file !== file) unlinkQuiet(prev.file);
    scores.set(accession, { accession, cik: Number(cik), reportDate: reportDate ?? null, version, file });
  },
  scoreCount(version) {
    need();
    let n = 0;
    for (const s of scores.values()) if (s.version === version) n++;
    return n;
  },
  // newest scored filing per company
  latestScoreRows(version) {
    const best = new Map();
    for (const s of scores.values()) {
      if (s.version !== version || !s.reportDate) continue;
      const b = best.get(s.cik);
      if (!b || s.reportDate > b.reportDate) best.set(s.cik, s);
    }
    return [...best.values()].map((s) => this.scoreJson(s.accession)).filter(Boolean);
  },
  // every scored filing (light: no file reads), newest first within a company
  scoreIndex(version) {
    need();
    const rows = [];
    for (const s of scores.values()) if (s.version === version) rows.push({ accession: s.accession, cik: s.cik, report_date: s.reportDate });
    return rows.sort((a, b) => a.cik - b.cik || (a.report_date < b.report_date ? 1 : a.report_date > b.report_date ? -1 : 0));
  },
  scoreJson(accession) {
    need();
    const s = scores.get(accession);
    if (!s) return null;
    try {
      return unpack(fs.readFileSync(s.file)).score;
    } catch {
      unlinkQuiet(s.file);
      scores.delete(accession);
      return null;
    }
  },
  unscoredAccessions(version) {
    need();
    const out = [];
    for (const acc of filings.keys()) {
      const s = scores.get(acc);
      if (!s || s.version !== version) out.push(acc);
    }
    return out;
  },
  // drop every saved filing / score of companies outside `ciks` (delisted
  // filers: nothing to buy, so nothing to keep) -> { companies, filings, scores }
  purgeExcept(ciks) {
    need();
    const keep = new Set(ciks.map(Number));
    const gone = new Set();
    let nf = 0;
    let ns = 0;
    for (const [acc, f] of filings) {
      if (keep.has(f.cik)) continue;
      unlinkQuiet(f.file);
      filings.delete(acc);
      gone.add(f.cik);
      nf++;
    }
    for (const [acc, s] of scores) {
      if (keep.has(s.cik)) continue;
      unlinkQuiet(s.file);
      scores.delete(acc);
      gone.add(s.cik);
      ns++;
    }
    for (const cik of gone) {
      rmdirQuiet(dir('filings', cik));
      rmdirQuiet(dir('scores', cik));
    }
    return { companies: gone.size, filings: nf, scores: ns };
  },
  size() {
    need();
    let bytes = 0;
    for (const f of filings.values()) bytes += f.bytes;
    const k = cache.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(json)), 0) AS bytes FROM kv').get();
    return { filings: filings.size, filingsBytes: bytes, scores: scores.size, kv: k.n, kvBytes: k.bytes };
  },
};
