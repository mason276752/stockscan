// Local persistence (SQLite via node:sqlite, no native dependency):
//   filings  parsed statements JSON per accession - a filed document never
//            changes, so these are kept indefinitely
//   kv       ticker table and per-company submissions, with a timestamp so
//            callers can decide whether to refresh
// Default location: ./data/stockscan.sqlite (override with STOCKSCAN_DB).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

// JSON is stored gzip'd (a parsed filing is ~300 KB as text, ~30 KB packed);
// rows written by earlier versions are plain text and still read fine.
const pack = (value) => zlib.gzipSync(JSON.stringify(value));
const unpack = (col) => JSON.parse(col instanceof Uint8Array ? zlib.gunzipSync(col).toString("utf8") : col);

let db = null;

export function openStore(file = process.env.STOCKSCAN_DB || path.join(process.cwd(), 'data', 'stockscan.sqlite')) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS filings (
      accession  TEXT PRIMARY KEY,
      cik        INTEGER NOT NULL,
      form       TEXT,
      report_date TEXT,
      json       TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS filings_cik ON filings(cik);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS kv (
      key        TEXT PRIMARY KEY,
      json       TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scores (
      accession   TEXT PRIMARY KEY,
      cik         INTEGER NOT NULL,
      report_date TEXT,
      version     INTEGER NOT NULL,
      json        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scores_cik ON scores(cik);
  `);
  // saved filings were produced by a given version of the parser; when the
  // parser changes, throw the old ones away so they get rebuilt
  const cols = db.prepare('PRAGMA table_info(filings)').all().map((c) => c.name);
  if (!cols.includes('version')) db.exec('ALTER TABLE filings ADD COLUMN version INTEGER NOT NULL DEFAULT 0');
  return db;
}

export function requireVersion(version) {
  const n = need().prepare('DELETE FROM filings WHERE version <> ?').run(version).changes;
  if (n) console.log(`store: dropped ${n} filings parsed by an older version`);
}

const need = () => {
  if (!db) throw new Error('store not opened');
  return db;
};

export const store = {
  get file() {
    return db?.location?.() ?? null;
  },

  getFiling(accession) {
    const row = need().prepare('SELECT json FROM filings WHERE accession = ?').get(accession);
    return row ? unpack(row.json) : null;
  },
  hasFiling(accession) {
    return !!need().prepare('SELECT 1 FROM filings WHERE accession = ?').get(accession);
  },
  putFiling(accession, cik, result, version) {
    need()
      .prepare('INSERT OR REPLACE INTO filings (accession, cik, form, report_date, json, fetched_at, version) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(accession, cik, result.filing?.form ?? null, result.filing?.periodEnd ?? null, pack(result), new Date().toISOString(), version);
  },
  filingCount(cik = null) {
    const row = cik == null ? need().prepare('SELECT COUNT(*) AS n FROM filings').get() : need().prepare('SELECT COUNT(*) AS n FROM filings WHERE cik = ?').get(cik);
    return row.n;
  },

  // kv entries come back with their age so callers can apply their own TTL
  getKV(key) {
    const row = need().prepare('SELECT json, updated_at FROM kv WHERE key = ?').get(key);
    return row ? { value: unpack(row.json), ageMs: Date.now() - row.updated_at } : null;
  },
  putKV(key, value) {
    need().prepare('INSERT OR REPLACE INTO kv (key, json, updated_at) VALUES (?, ?, ?)').run(key, pack(value), Date.now());
  },
  // accession -> report_date of every saved filing of a company (cheap: no JSON decoding)
  filingIndex(cik) {
    return need().prepare('SELECT accession, form, report_date FROM filings WHERE cik = ?').all(cik);
  },
  // scores: one per filing, keyed by accession, invalidated by version
  getScore(accession, version) {
    const row = need().prepare('SELECT json FROM scores WHERE accession = ? AND version = ?').get(accession, version);
    return row ? unpack(row.json) : null;
  },
  putScore(accession, cik, reportDate, version, score) {
    need().prepare('INSERT OR REPLACE INTO scores (accession, cik, report_date, version, json) VALUES (?, ?, ?, ?, ?)').run(accession, cik, reportDate ?? null, version, pack(score));
  },
  unscoredAccessions(version) {
    return need().prepare('SELECT f.accession FROM filings f LEFT JOIN scores s ON s.accession = f.accession AND s.version = ? WHERE s.accession IS NULL').all(version).map((r) => r.accession);
  },
  size() {
    const f = need().prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(json)), 0) AS bytes FROM filings').get();
    const k = need().prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(json)), 0) AS bytes FROM kv').get();
    return { filings: f.n, filingsBytes: f.bytes, kv: k.n, kvBytes: k.bytes };
  },
};
