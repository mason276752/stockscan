// Local persistence, laid out so the data can live in git (many small
// immutable files, no file near GitHub's 100 MB limit, no LFS):
//
//   data/store/filings/<cik>/<accession>__<period end>__<form>__v<parser>.json.zst
//       the parsed statements of one filing (zstd JSON, dictionary-compressed). A filed document
//       never changes, so a file is written once and kept; a parser version
//       bump deletes it and it is re-fetched. The four primary statements
//       are not stored twice: `statements` is rebuilt from `allStatements`.
//   data/store/scores/<cik>/<accession>__<period end>__v<score version>.json.zst
//       the score of one filing
//   data/store/documentation.json
//       SEC's definition of every standard concept seen (us-gaap: … ), one
//       copy instead of one per filing (a fifth of a filing's bytes)
//   data/store/universe.json
//       every SEC filer with industry (SIC), filer status and public float,
//       from SEC's quarterly datasets (rebuilt weekly): the browse pages
//   data/store/companies/<CIK padded>.json
//       the company's EDGAR filing list (submissions, trimmed to 10-K/10-Q…):
//       what the filing picker shows and what the crawler compares the store
//       against - in git, so a fresh clone opens every company and resumes
//       the crawl without a single request to SEC
//   data/cache.sqlite   (not for git)
//       kv cache: ticker table, market snapshot, universe, ETF lists …
//
// Everything the store knows about which files exist is read from the file
// names at startup (no index file to drift). Writes are atomic (temp + rename).
// The old single-file SQLite store (data/stockscan.sqlite) is migrated on
// first start when the directory is still empty.
// Locations: STOCKSCAN_STORE (default <repo>/data/store), STOCKSCAN_CACHE
// (default <repo>/data/cache.sqlite), STOCKSCAN_DB (the legacy SQLite to
// migrate) - relative to the repo, not the working directory.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { slim, fatten } from './storeFormat.ts';
import type { DocIndex, SlimResult } from './storeFormat.ts';
import type { IsoDate, Json, Score, ScrapeResult, FilingHeader } from './types.ts';

/** What the file names tell us about a saved filing, with no file read. */
export interface FilingRecord {
  accession: string;
  cik: number;
  form: string | null;
  reportDate: IsoDate | null;
  version: number;
  file: string;
  /** the file's size, filled in on demand (bytesOf) - see scanFilings */
  bytes?: number;
}

/** The same for a saved score. */
export interface ScoreRecord {
  accession: string;
  cik: number;
  reportDate: IsoDate | null;
  version: number;
  file: string;
}

/** A filing file as it sits on disk: the header fields plus the slimmed result. */
interface FilingFile {
  accession: string;
  cik: number;
  form: string | null;
  reportDate: IsoDate | null;
  version: number;
  fetchedAt: string;
  data: SlimResult;
}

/** A score file. */
interface ScoreFile {
  accession: string;
  cik: number;
  reportDate: IsoDate | null;
  version: number;
  score: Score;
}

/** A small JSON document in the store, with how long ago it was written. */
export interface StoredDoc<T> {
  value: T;
  ageMs: number;
}

type StoreKind = 'filings' | 'scores';

// Files are zstd with a dictionary trained on this kind of JSON (server/data/
// zdict, node server/tools/train-zdict.mjs): a filing is a third smaller than
// with brotli, a score a third of the size, and decoding is faster. Files
// written before that (.json.br, brotli) still read; they are rewritten as
// .zst in the background after startup. A dictionary is frozen once used.
const EXT = '.json.zst';
// paths default to the repo's data/ whatever the working directory is
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(REPO, 'data');
const ZDICT_DIR = path.join(REPO, 'server', 'data', 'zdict');
const DICTS: Record<StoreKind, Buffer> = { filings: fs.readFileSync(path.join(ZDICT_DIR, 'filings-v1.zdict')), scores: fs.readFileSync(path.join(ZDICT_DIR, 'scores-v1.zdict')) };
const ZSTD = (kind: StoreKind) => ({ dictionary: DICTS[kind], params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } });
const pack = (kind: StoreKind, value: unknown) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(value)), ZSTD(kind));
const unpack = <T,>(kind: StoreKind, buf: Buffer, file: string): T => JSON.parse((file.endsWith('.br') ? zlib.brotliDecompressSync(buf) : zlib.zstdDecompressSync(buf, { dictionary: DICTS[kind] })).toString('utf8'));
// the legacy SQLite rows: gzip'd JSON, or plain text from even older versions
const unpackLegacy = (col: unknown) => JSON.parse(col instanceof Uint8Array ? zlib.gunzipSync(col).toString('utf8') : (col as string));

let root: string | null = null; // data/store
let cacheDir: string | null = null; // where cache.sqlite lives (derived data, safe to delete)
let cache: DatabaseSync = null as unknown as DatabaseSync; // the kv SQLite

// kv keys that also live as files in the store (see getKV): what the
// static build needs from the network and would otherwise fetch again on
// every CI run - the ETF list, the CUSIP table, each ETF's N-PORT filing
// list and the parsed N-PORT documents (a filed document never changes)
const DURABLE_KV = ['etfs', 'cusips', 'nport:', 'nport-list:'];
const durableKV = (key: string) => DURABLE_KV.some((p) => (p.endsWith(':') ? key.startsWith(p) : key === p));
// 'nport:0000036405-26-000480' -> 'kv/nport/0000036405-26-000480.json'
const durableFile = (key: string) => `kv/${key.replace(/[^A-Za-z0-9:_.-]/g, '_').replace(/:/g, '/')}.json`;
const filings = new Map<string, FilingRecord>();
const scores = new Map<string, ScoreRecord>();
// cik -> its filings, built the first time one is asked for and thrown away
// whenever `filings` changes. Scoring asks per company and the store is
// heading for six figures, so the scan it replaces is the whole of a
// rescore's time (store.filingIndex).
let byCik: Map<number, FilingRecord[]> | null = null;
const forgetByCik = () => {
  byCik = null;
};
let docs: DocIndex = {}; // concept -> SEC documentation (standard concepts)
let docsDirty = false;
let docsTimer: NodeJS.Timeout | null = null;

// file name <-> record. Forms carry a slash (10-K/A): '~' in the name.
const safe = (s: string | null | undefined) => String(s ?? '-').replace(/\//g, '~').replace(/[^A-Za-z0-9.~-]/g, '_') || '-';
const unsafe = (s: string) => (s === '-' ? null : s.replace(/~/g, '/'));
const filingName = (accession: string, reportDate: IsoDate | null, form: string | null, version: number) => `${accession}__${safe(reportDate)}__${safe(form)}__v${version}${EXT}`;
const scoreName = (accession: string, reportDate: IsoDate | null, version: number) => `${accession}__${safe(reportDate)}__v${version}${EXT}`;
const FILING_RE = /^(.+?)__(.+?)__(.+?)__v(\d+)\.json\.(?:br|zst)$/;
const SCORE_RE = /^(.+?)__(.+?)__v(\d+)\.json\.(?:br|zst)$/;

const dir = (kind: StoreKind, cik: number | string) => path.join(root!, kind, String(cik));

function writeAtomic(file: string, buf: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}
const unlinkQuiet = (file: string) => {
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
};
const rmdirQuiet = (d: string) => {
  try {
    fs.rmdirSync(d);
  } catch {
    /* not empty / gone */
  }
};

type SqliteFailure = Error & { code?: string; errcode?: number; errstr?: string };
const cacheFailure = (err: unknown): err is SqliteFailure => {
  const e = err as SqliteFailure;
  return e?.errcode === 11 || e?.errcode === 26 || e?.code === 'SQLITE_CORRUPT' || e?.code === 'SQLITE_NOTADB' || /database disk image is malformed|file is not a database/i.test(e?.message || '');
};
const closeCache = (db: DatabaseSync | null) => {
  try {
    db?.close();
  } catch {
    /* closing an already damaged cache must not hide the original failure */
  }
};
function configureCache(db: DatabaseSync) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS kv (
      key        TEXT PRIMARY KEY,
      json       BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}
function checkCache(db: DatabaseSync) {
  const rows = db.prepare('PRAGMA quick_check').all();
  const result = rows.map((row) => String(Object.values(row)[0])).join('; ');
  if (result === 'ok') return;
  const err = new Error(`cache integrity check failed: ${result || 'no result'}`) as SqliteFailure;
  err.errcode = 11;
  throw err;
}
function quarantineCache(file: string, db: DatabaseSync | null): string[] {
  const token = `${Date.now()}-${process.pid}`;
  const moved: string[] = [];
  const sidecars = [`${file}-wal`, `${file}-shm`];
  // Keep a byte-for-byte copy before close(): SQLite may remove empty sidecars
  // while closing the damaged connection.
  for (const from of sidecars) {
    if (!fs.existsSync(from)) continue;
    const to = `${from}.corrupt-${token}`;
    fs.copyFileSync(from, to);
    moved.push(to);
  }
  closeCache(db);
  for (const from of [file, ...sidecars]) {
    if (!fs.existsSync(from)) continue;
    const base = `${from}.corrupt-${token}`;
    const to = fs.existsSync(base) ? `${base}.after-close` : base;
    fs.renameSync(from, to);
    moved.push(to);
  }
  return moved;
}
function rebuildCache(file: string, db: DatabaseSync | null, reason: SqliteFailure): DatabaseSync {
  const moved = quarantineCache(file, db);
  console.warn(`store: SQLite 快取損毀（${reason.message}），已隔離 ${moved.map((name) => path.basename(name)).join(', ') || path.basename(file)} 並重建；${root}/ 未受影響`);
  const fresh = new DatabaseSync(file);
  configureCache(fresh);
  checkCache(fresh);
  return fresh;
}
function openCache(file: string): DatabaseSync {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file);
    checkCache(db);
    configureCache(db);
    return db;
  } catch (err) {
    if (!cacheFailure(err)) {
      closeCache(db);
      throw err;
    }
    return rebuildCache(file, db, err);
  }
}

// scan the tree once: file names carry everything the indexes need
function scan<T extends { accession: string; version: number; file: string }>(kind: StoreKind, re: RegExp, into: Map<string, T>, make: (m: RegExpExecArray, cik: number, file: string) => T) {
  into.clear();
  forgetByCik();
  const base = path.join(root!, kind);
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
      if (prev && (prev.version > rec.version || (prev.version === rec.version && prev.file.endsWith('.zst')))) {
        unlinkQuiet(file);
        continue;
      }
      if (prev) unlinkQuiet(prev.file);
      into.set(rec.accession, rec);
    }
  }
}
// The scan reads the file names only. A filing's size is not in them, and
// stat'ing all ~200,000 of them cost a third of a second on every start for
// the sake of two callers - the static build's byte budget (publish.ts) and
// the byte total on /api/status - so it is filled in on demand instead and
// kept on the record.
const scanFilings = () => scan('filings', FILING_RE, filings, (m, cik, file) => ({ accession: m[1]!, cik, reportDate: unsafe(m[2]!), form: unsafe(m[3]!), version: Number(m[4]), file }));
const bytesOf = (rec: FilingRecord): number => {
  if (rec.bytes == null) {
    try {
      rec.bytes = fs.statSync(rec.file).size;
    } catch {
      rec.bytes = 0; // gone from under us: it is only a size
    }
  }
  return rec.bytes;
};
const scanScores = () => scan('scores', SCORE_RE, scores, (m, cik, file) => ({ accession: m[1]!, cik, reportDate: unsafe(m[2]!), version: Number(m[3]), file }));

function loadDocs() {
  try {
    docs = JSON.parse(fs.readFileSync(path.join(root!, 'documentation.json'), 'utf8')) || {};
  } catch {
    docs = {};
  }
}
function flushDocs() {
  if (docsTimer) clearTimeout(docsTimer);
  docsTimer = null;
  if (!docsDirty || !root) return;
  docsDirty = false;
  const sorted = Object.fromEntries(Object.keys(docs).sort().map((k) => [k, docs[k]]));
  writeAtomic(path.join(root!, 'documentation.json'), JSON.stringify(sorted, null, 1));
}
function scheduleDocs() {
  docsDirty = true;
  if (!docsTimer) docsTimer = setTimeout(flushDocs, 5000).unref();
}

export function openStore(storeDir: string = process.env.STOCKSCAN_STORE || path.join(DATA, 'store'), cacheFile: string = process.env.STOCKSCAN_CACHE || path.join(DATA, 'cache.sqlite')): string {
  root = storeDir;
  cacheDir = path.dirname(cacheFile);
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  cache = openCache(cacheFile);
  loadDocs();
  scanFilings();
  scanScores();
  migrateLegacy(process.env.STOCKSCAN_DB || path.join(DATA, 'stockscan.sqlite'));
  migrateSubmissions();
  migrateUniverse();
  compactCache();
  process.on('exit', flushDocs);
  setTimeout(recompress, 20_000).unref();
  return root;
}

// files still in the brotli format: rewrite them as zstd one at a time,
// spaced out so the server stays responsive (~0.1 s each, ~15 min for 10k)
function recompress() {
  const todo: [StoreKind, FilingRecord | ScoreRecord][] = [
    ...[...filings.values()].filter((f) => f.file.endsWith('.br')).map((f): [StoreKind, FilingRecord] => ['filings', f]),
    ...[...scores.values()].filter((f) => f.file.endsWith('.br')).map((f): [StoreKind, ScoreRecord] => ['scores', f]),
  ];
  if (!todo.length) return;
  console.log(`store: ${todo.length} 個檔案從 brotli 轉成 zstd（背景進行）…`);
  let i = 0;
  let saved = 0;
  const step = () => {
    if (i >= todo.length) {
      console.log(`store: 轉檔完成，省下 ${(saved / 1048576).toFixed(0)} MB`);
      return;
    }
    const [kind, rec] = todo[i++]!;
    const live = (kind === 'filings' ? filings : scores).get(rec.accession);
    if (live === rec && fs.existsSync(rec.file)) {
      try {
        const value = JSON.parse(zlib.brotliDecompressSync(fs.readFileSync(rec.file)).toString('utf8'));
        const buf = pack(kind, value);
        const file = rec.file.replace(/\.json\.br$/, EXT);
        writeAtomic(file, buf);
        unlinkQuiet(rec.file);
        const was = kind === 'filings' ? bytesOf(rec as FilingRecord) : 0;
        saved += was - buf.length;
        rec.file = file;
        if (kind === 'filings') (rec as FilingRecord).bytes = buf.length;
      } catch (err) {
        console.warn(`store: ${path.basename(rec.file)} 轉檔失敗：${(err as Error).message}`);
      }
    }
    setTimeout(step, 30).unref();
  };
  step();
}

// filing lists saved in the kv cache by earlier versions: move them into the
// store (they are data a clone should have, not a cache)
let kvShrunk = false;
function migrateSubmissions() {
  const keys = cache.prepare("SELECT key FROM kv WHERE substr(key, 1, 12) = 'submissions:'").all().map((r) => r.key as string);
  if (!keys.length) return;
  const get = cache.prepare('SELECT json, updated_at FROM kv WHERE key = ?');
  for (const key of keys) {
    const row = get.get(key);
    if (!row) continue;
    const file = path.join(root!, 'companies', `${key.slice('submissions:'.length)}.json`);
    if (!fs.existsSync(file)) {
      writeAtomic(file, JSON.stringify(kvUnpack(row.json)));
      const t = new Date(row.updated_at as number);
      fs.utimesSync(file, t, t); // keep the fetch time (the TTL reads mtime)
    }
    cache.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }
  kvShrunk = true;
  console.log(`store: ${keys.length} 家公司的申報清單從快取搬到 ${root}/companies/`);
}
// the SIC / filer universe likewise (rebuilt weekly from SEC's datasets; a
// clone should not have to wait minutes for it)
function migrateUniverse() {
  const row = cache.prepare("SELECT json, updated_at FROM kv WHERE key = 'universe'").get();
  if (!row) return;
  const file = path.join(root!, 'universe.json');
  if (!fs.existsSync(file)) {
    writeAtomic(file, JSON.stringify(kvUnpack(row.json)));
    const t = new Date(row.updated_at as number);
    fs.utimesSync(file, t, t);
  }
  cache.prepare("DELETE FROM kv WHERE key = 'universe'").run();
  kvShrunk = true;
}

// Housekeeping for the kv cache at startup: rows still stored as plain text
// (first migration pass) get packed and the file is shrunk.
function compactCache() {
  const stale = 0;
  const text = cache.prepare("SELECT key FROM kv WHERE typeof(json) = 'text'").all().map((r) => r.key as string);
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
  if (stale || text.length || kvShrunk) {
    cache.exec('VACUUM');
    console.log(`store: 快取整理：壓縮 ${text.length} 筆純文字列`);
  }
  cache.exec('PRAGMA wal_checkpoint(TRUNCATE)'); // fold the WAL back into the file so it does not sit at its high-water mark
}

// The previous single-file SQLite store: copy everything over once (the
// store directory is empty, the old file exists), then leave the old file
// alone for the user to delete.
function migrateLegacy(file: string) {
  if (filings.size || !fs.existsSync(file)) return;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name as string));
    if (!tables.has('filings')) return;
    console.log(`store: 從舊的 ${file} 搬到 ${root}/ …`);
    let n = 0;
    for (const r of db.prepare('SELECT accession, cik, version, fetched_at, json FROM filings').iterate()) {
      const data = unpackLegacy(r.json);
      store.putFiling(r.accession as string, r.cik as number, data, r.version as number, r.fetched_at as string);
      if (++n % 1000 === 0) console.log(`store: 財報 ${n} 份…`);
    }
    let s = 0;
    if (tables.has('scores')) {
      for (const r of db.prepare('SELECT accession, cik, report_date, version, json FROM scores').iterate()) {
        store.putScore(r.accession as string, r.cik as number, r.report_date as IsoDate | null, r.version as number, unpackLegacy(r.json));
        s++;
      }
    }
    let k = 0;
    if (tables.has('kv')) {
      const put = cache.prepare('INSERT OR REPLACE INTO kv (key, json, updated_at) VALUES (?, ?, ?)');
      cache.exec('BEGIN');
      for (const r of db.prepare('SELECT key, json, updated_at FROM kv').iterate()) {
        put.run(r.key as string, kvPack(unpackLegacy(r.json)), r.updated_at as number);
        k++;
      }
      cache.exec('COMMIT');
    }
    flushDocs();
    console.log(`store: 搬完 ${n} 份財報、${s} 筆評分、${k} 筆快取；${file} 可以刪掉了`);
  } catch (err) {
    console.warn(`store: 舊資料庫搬移失敗：${(err as Error).message}`);
  } finally {
    db?.close();
  }
}

// files written by another parser version are thrown away (rebuilt on demand)
export function requireVersion(version: number): void {
  let n = 0;
  for (const [acc, f] of filings) {
    if (f.version === version) continue;
    unlinkQuiet(f.file);
    rmdirQuiet(path.dirname(f.file));
    filings.delete(acc);
    forgetByCik();
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
const kvPack = (value: unknown) => zlib.brotliCompressSync(Buffer.from(JSON.stringify(value)), KV_BROTLI);
const kvUnpack = (col: unknown) => JSON.parse(col instanceof Uint8Array ? zlib.brotliDecompressSync(col).toString('utf8') : (col as string));

export const store = {
  get file(): string | null {
    return root;
  },

  getFiling(accession: string): ScrapeResult | null {
    need();
    const f = filings.get(accession);
    if (!f) return null;
    try {
      return fatten(unpack<FilingFile>('filings', fs.readFileSync(f.file), f.file).data, docs);
    } catch (err) {
      console.warn(`store: ${path.basename(f.file)} unreadable (${(err as Error).message}), dropped`);
      unlinkQuiet(f.file);
      filings.delete(accession);
      forgetByCik();
      return null;
    }
  },
  // just the `filing` header of a saved filing (no statements rebuilt): for indexes
  filingHeader(accession: string): FilingHeader | null {
    need();
    const f = filings.get(accession);
    if (!f) return null;
    try {
      return unpack<FilingFile>('filings', fs.readFileSync(f.file), f.file).data?.filing || null;
    } catch {
      return null;
    }
  },
  hasFiling(accession: string): boolean {
    need();
    return filings.has(accession);
  },
  putFiling(accession: string, cik: number | string, result: ScrapeResult, version: number, fetchedAt: string = new Date().toISOString()): void {
    need();
    const reportDate = result.filing?.periodEnd ?? null;
    const form = result.filing?.form ?? null;
    const file = path.join(dir('filings', cik), filingName(accession, reportDate, form, version));
    const buf = pack('filings', { accession, cik, form, reportDate, version, fetchedAt, data: slim(result, docs, scheduleDocs) });
    writeAtomic(file, buf);
    const prev = filings.get(accession);
    if (prev && prev.file !== file) unlinkQuiet(prev.file);
    filings.set(accession, { accession, cik: Number(cik), form, reportDate, version, file, bytes: buf.length });
    forgetByCik();
  },
  filingCount(cik: number | string | null = null): number {
    need();
    if (cik == null) return filings.size;
    let n = 0;
    for (const f of filings.values()) if (f.cik === Number(cik)) n++;
    return n;
  },
  // every saved filing / score (light: from the file names), with the file's
  // path relative to the store - for the static-site build
  allFilings(): FilingRecord[] {
    need();
    return [...filings.values()].map((f) => ({ accession: f.accession, cik: f.cik, form: f.form, reportDate: f.reportDate, version: f.version, bytes: bytesOf(f), file: path.relative(root!, f.file) }));
  },
  allScores(): ScoreRecord[] {
    need();
    return [...scores.values()].map((s) => ({ accession: s.accession, cik: s.cik, reportDate: s.reportDate, version: s.version, file: path.relative(root!, s.file) }));
  },
  // accession -> report_date of every saved filing of a company (cheap: no file reads)
  filingIndex(cik: number | string): { accession: string; form: string | null; report_date: IsoDate | null }[] {
    need();
    if (!byCik) {
      byCik = new Map<number, FilingRecord[]>();
      for (const f of filings.values()) {
        const list = byCik.get(f.cik);
        if (list) list.push(f);
        else byCik.set(f.cik, [f]);
      }
    }
    return (byCik.get(Number(cik)) || []).map((f) => ({ accession: f.accession, form: f.form, report_date: f.reportDate }));
  },

  // small plain-JSON documents in the store (companies/<cik>.json …): git-
  // friendly, with the write time so callers can apply their own TTL
  getDoc<T = Json>(name: string): StoredDoc<T> | null {
    need();
    try {
      const st = fs.statSync(path.join(root!, name));
      return { value: JSON.parse(fs.readFileSync(path.join(root!, name), 'utf8')), ageMs: Date.now() - st.mtimeMs };
    } catch {
      return null;
    }
  },
  putDoc(name: string, value: unknown): void {
    need();
    writeAtomic(path.join(root!, name), JSON.stringify(value));
  },
  listDocs(dir: string): string[] {
    need();
    try {
      return fs.readdirSync(path.join(root!, dir)).filter((n) => n.endsWith('.json')).map((n) => `${dir}/${n}`);
    } catch {
      return [];
    }
  },

  // kv entries come back with their age so callers can apply their own TTL.
  // Durable keys (DURABLE_KV) are mirrored as data/store/kv/<key>.json with
  // the write time inside, so they travel with the store (the data ref, a
  // fresh CI runner) and the TTL still works after a git checkout; the
  // SQLite row is only a faster copy of the file.
  getKV<T = Json>(key: string): StoredDoc<T> | null {
    const row = cache.prepare('SELECT json, updated_at FROM kv WHERE key = ?').get(key);
    if (row) {
      const value = kvUnpack(row.json);
      // a row written as plain text (first migration pass): re-pack it on the way out
      if (typeof row.json === 'string') cache.prepare('UPDATE kv SET json = ? WHERE key = ?').run(kvPack(value), key);
      return { value, ageMs: Date.now() - (row.updated_at as number) };
    }
    if (!durableKV(key)) return null;
    const doc = this.getDoc<{ updatedAt?: string; value: T }>(durableFile(key))?.value;
    if (!doc || typeof doc !== 'object' || !('value' in doc)) return null;
    const at = Date.parse(doc.updatedAt || '') || 0;
    cache.prepare('INSERT OR REPLACE INTO kv (key, json, updated_at) VALUES (?, ?, ?)').run(key, kvPack(doc.value), at);
    return { value: doc.value, ageMs: Date.now() - at };
  },
  putKV(key: string, value: unknown): void {
    const now = Date.now();
    cache.prepare('INSERT OR REPLACE INTO kv (key, json, updated_at) VALUES (?, ?, ?)').run(key, kvPack(value), now);
    if (durableKV(key)) this.putDoc(durableFile(key), { key, updatedAt: new Date(now).toISOString(), value });
  },
  kvKeys(prefix: string): string[] {
    return cache.prepare('SELECT key FROM kv WHERE substr(key, 1, ?) = ?').all(prefix.length, prefix).map((r) => r.key as string);
  },
  deleteKV(key: string): void {
    cache.prepare('DELETE FROM kv WHERE key = ?').run(key);
  },
  compactKV(): void {
    cache.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
  },

  // A derived blob kept as its own file beside cache.sqlite rather than as
  // a kv row: the kv rows are brotli'd one at a time, which is the wrong
  // shape for something rewritten whole at tens of MB (score.ts's as-of
  // columns). Like everything else there, losing it costs a rebuild.
  readCache(name: string): Buffer | null {
    need();
    try {
      return fs.readFileSync(path.join(cacheDir!, name));
    } catch {
      return null;
    }
  },
  writeCache(name: string, buf: Buffer): void {
    need();
    try {
      writeAtomic(path.join(cacheDir!, name), buf);
    } catch (err) {
      console.warn(`store: 寫入快取 ${name} 失敗：${(err as Error).message}`); // a cache: carry on without it
    }
  },

  // scores: one per filing, keyed by accession, invalidated by version
  getScore(accession: string, version: number): Score | null {
    need();
    const s = scores.get(accession);
    if (!s || s.version !== version) return null;
    return this.scoreJson(accession);
  },
  putScore(accession: string, cik: number | string, reportDate: IsoDate | null, version: number, score: Score): void {
    need();
    const file = path.join(dir('scores', cik), scoreName(accession, reportDate, version));
    writeAtomic(file, pack('scores', { accession, cik, reportDate, version, score }));
    const prev = scores.get(accession);
    if (prev && prev.file !== file) unlinkQuiet(prev.file);
    scores.set(accession, { accession, cik: Number(cik), reportDate: reportDate ?? null, version, file });
  },
  scoreCount(version: number): number {
    need();
    let n = 0;
    for (const s of scores.values()) if (s.version === version) n++;
    return n;
  },
  // newest scored filing per company
  latestScoreRows(version: number): Score[] {
    const best = new Map<number, ScoreRecord>();
    for (const s of scores.values()) {
      if (s.version !== version || !s.reportDate) continue;
      const b = best.get(s.cik);
      if (!b || s.reportDate > b.reportDate!) best.set(s.cik, s);
    }
    return [...best.values()].map((s) => this.scoreJson(s.accession)).filter((x): x is Score => !!x);
  },
  // every scored filing (light: no file reads), newest first within a company
  scoreIndex(version: number): { accession: string; cik: number; report_date: IsoDate | null }[] {
    need();
    const rows: { accession: string; cik: number; report_date: IsoDate | null }[] = [];
    for (const s of scores.values()) if (s.version === version) rows.push({ accession: s.accession, cik: s.cik, report_date: s.reportDate });
    return rows.sort((a, b) => a.cik - b.cik || (a.report_date! < b.report_date! ? 1 : a.report_date! > b.report_date! ? -1 : 0));
  },
  scoreJson(accession: string): Score | null {
    need();
    const s = scores.get(accession);
    if (!s) return null;
    try {
      return unpack<ScoreFile>('scores', fs.readFileSync(s.file), s.file).score;
    } catch {
      unlinkQuiet(s.file);
      scores.delete(accession);
      return null;
    }
  },
  unscoredAccessions(version: number): string[] {
    need();
    const out: string[] = [];
    for (const acc of filings.keys()) {
      const s = scores.get(acc);
      if (!s || s.version !== version) out.push(acc);
    }
    return out;
  },
  // drop every saved filing / score of companies outside `ciks` (delisted
  // filers: nothing to buy, so nothing to keep) -> { companies, filings, scores }
  purgeExcept(ciks: readonly (number | string)[]): { companies: number; filings: number; scores: number; docs: number } {
    need();
    const keep = new Set(ciks.map(Number));
    const gone = new Set<number>();
    let nf = 0;
    let ns = 0;
    for (const [acc, f] of filings) {
      if (keep.has(f.cik)) continue;
      unlinkQuiet(f.file);
      filings.delete(acc);
      forgetByCik();
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
    // the saved submissions of those companies go too - both shapes the
    // directory holds: <cik>.json and CIK<cik>-submissions-NNN.json
    let nd = 0;
    for (const name of this.listDocs('companies')) {
      const cik = Number(/(\d{6,10})/.exec(path.basename(name))?.[1]);
      if (!cik || keep.has(cik)) continue;
      unlinkQuiet(path.join(root!, name));
      nd++;
    }
    return { companies: gone.size, filings: nf, scores: ns, docs: nd };
  },
  size(): { filings: number; filingsBytes: number; scores: number; kv: number; kvBytes: number } {
    need();
    let bytes = 0;
    for (const f of filings.values()) bytes += bytesOf(f); // the first call stats what it has not seen; a write records its own size
    const k = cache.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(json)), 0) AS bytes FROM kv').get()!;
    return { filings: filings.size, filingsBytes: bytes, scores: scores.size, kv: k.n as number, kvBytes: k.bytes as number };
  },
};
