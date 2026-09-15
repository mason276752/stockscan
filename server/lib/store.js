// Local persistence (SQLite via node:sqlite, no native dependency):
//   filings  parsed statements JSON per accession - a filed document never
//            changes, so these are kept indefinitely
//   kv       ticker table and per-company submissions, with a timestamp so
//            callers can decide whether to refresh
// Default location: ./data/stockscan.sqlite (override with STOCKSCAN_DB).

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
    CREATE TABLE IF NOT EXISTS kv (
      key        TEXT PRIMARY KEY,
      json       TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return db;
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
    return row ? JSON.parse(row.json) : null;
  },
  hasFiling(accession) {
    return !!need().prepare('SELECT 1 FROM filings WHERE accession = ?').get(accession);
  },
  putFiling(accession, cik, result) {
    need()
      .prepare('INSERT OR REPLACE INTO filings (accession, cik, form, report_date, json, fetched_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(accession, cik, result.filing?.form ?? null, result.filing?.periodEnd ?? null, JSON.stringify(result), new Date().toISOString());
  },
  filingCount(cik = null) {
    const row = cik == null ? need().prepare('SELECT COUNT(*) AS n FROM filings').get() : need().prepare('SELECT COUNT(*) AS n FROM filings WHERE cik = ?').get(cik);
    return row.n;
  },

  // kv entries come back with their age so callers can apply their own TTL
  getKV(key) {
    const row = need().prepare('SELECT json, updated_at FROM kv WHERE key = ?').get(key);
    return row ? { value: JSON.parse(row.json), ageMs: Date.now() - row.updated_at } : null;
  },
  putKV(key, value) {
    need().prepare('INSERT OR REPLACE INTO kv (key, json, updated_at) VALUES (?, ?, ?)').run(key, JSON.stringify(value), Date.now());
  },
};
