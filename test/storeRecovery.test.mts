import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore, store } from '../server/lib/store.ts';
import { savedTickers } from '../server/lib/edgar.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stockscan-cache-recovery-'));
const storeDir = path.join(tmp, 'store');
const cacheFile = path.join(tmp, 'cache.sqlite');
const oldLegacy = process.env.STOCKSCAN_DB;

function writeStoreFallbacks() {
  fs.mkdirSync(path.join(storeDir, 'kv'), { recursive: true });
  fs.writeFileSync(path.join(storeDir, 'kv', 'etfs.json'), JSON.stringify({ key: 'etfs', updatedAt: '2026-01-01T00:00:00.000Z', value: ['SPY'] }));
  fs.writeFileSync(path.join(storeDir, 'tickers.json'), JSON.stringify({ updatedAt: '2026-01-01T00:00:00.000Z', tickers: [{ cik: 1, ticker: 'TEST', name: 'Test Co', exchange: 'NYSE' }] }));
}

function writeCorruptCache() {
  const db = new DatabaseSync(cacheFile);
  db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, json BLOB NOT NULL, updated_at INTEGER NOT NULL)');
  db.prepare('INSERT INTO kv (key, json, updated_at) VALUES (?, ?, ?)').run('market:snapshot', Buffer.alloc(200_000, 1), Date.now());
  db.close();
  fs.writeFileSync(`${cacheFile}-wal`, 'old wal');
  fs.writeFileSync(`${cacheFile}-shm`, 'old shm');
  fs.truncateSync(cacheFile, 4096); // Keep the header, drop the table and its overflow pages.
}

test('a malformed cache is quarantined and rebuilt from durable files', () => {
  writeStoreFallbacks();
  writeCorruptCache();
  process.env.STOCKSCAN_DB = path.join(tmp, 'legacy.sqlite');

  openStore(storeDir, cacheFile);

  const names = fs.readdirSync(tmp);
  for (const suffix of ['', '-wal', '-shm']) assert.ok(names.some((name) => name.startsWith(`cache.sqlite${suffix}.corrupt-`)), `${suffix || 'main'} cache file was quarantined`);

  assert.deepEqual(store.getKV<string[]>('etfs')?.value, ['SPY']);
  assert.deepEqual(savedTickers()?.value.map((row) => row.ticker), ['TEST']);
  assert.equal(store.getKV('market:snapshot'), null);
  store.putKV('ephemeral', { rebuilt: true });
  assert.deepEqual(store.getKV('ephemeral')?.value, { rebuilt: true });

  const fresh = new DatabaseSync(cacheFile, { readOnly: true });
  assert.equal(Object.values(fresh.prepare('PRAGMA quick_check').get()!)[0], 'ok');
  fresh.close();
});

test.after(() => {
  if (oldLegacy == null) delete process.env.STOCKSCAN_DB;
  else process.env.STOCKSCAN_DB = oldLegacy;
  fs.rmSync(tmp, { recursive: true, force: true });
});
