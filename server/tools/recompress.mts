// One-shot: rewrite every data/store file still in brotli (.json.br) as zstd
// (.json.zst, dictionary-compressed) using all CPU cores. The server does the
// same thing slowly in the background; run this (with the server stopped)
// when you want it done now, e.g. before committing.
//   node server/tools/recompress.mjs [store dir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const ZDICT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'zdict');

/** What one worker reports back after a batch. */
interface Progress {
  done: number;
  before: number;
  after: number;
}

if (isMainThread) {
  const root = process.argv[2] || path.join(process.cwd(), 'data', 'store');
  const files: [string, string][] = [];
  for (const kind of ['filings', 'scores']) {
    const base = path.join(root, kind);
    if (!fs.existsSync(base)) continue;
    for (const cik of fs.readdirSync(base)) for (const name of fs.readdirSync(path.join(base, cik))) if (name.endsWith('.json.br')) files.push([kind, path.join(base, cik, name)]);
  }
  if (!files.length) {
    console.log('nothing to convert');
    process.exit(0);
  }
  const n = Math.max(1, Math.min(os.cpus().length - 1, 8));
  console.log(`${files.length} files, ${n} workers`);
  const t = Date.now();
  let done = 0;
  let before = 0;
  let after = 0;
  const shards = Array.from({ length: n }, (_, i) => files.filter((_, j) => j % n === i));
  let running = n;
  for (const shard of shards) {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: shard });
    w.on('message', (m: Progress) => {
      done += m.done;
      before += m.before;
      after += m.after;
      if (done % 2000 < m.done) console.log(`${done} / ${files.length}`);
    });
    w.on('error', (e) => console.error(e));
    w.on('exit', () => {
      if (--running === 0) console.log(`done in ${((Date.now() - t) / 1000).toFixed(0)} s: ${(before / 1048576).toFixed(0)} MB -> ${(after / 1048576).toFixed(0)} MB`);
    });
  }
} else {
  const dicts: Record<string, Buffer> = { filings: fs.readFileSync(path.join(ZDICT_DIR, 'filings-v1.zdict')), scores: fs.readFileSync(path.join(ZDICT_DIR, 'scores-v1.zdict')) };
  let batch: Progress = { done: 0, before: 0, after: 0 };
  for (const [kind, file] of workerData as [string, string][]) {
    const src = fs.readFileSync(file);
    const raw = zlib.brotliDecompressSync(src);
    const out = zlib.zstdCompressSync(raw, { dictionary: dicts[kind], params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } });
    const dest = file.replace(/\.json\.br$/, '.json.zst');
    fs.writeFileSync(`${dest}.tmp`, out);
    fs.renameSync(`${dest}.tmp`, dest);
    fs.unlinkSync(file);
    batch.done++;
    batch.before += src.length;
    batch.after += out.length;
    if (batch.done >= 100) {
      parentPort!.postMessage(batch);
      batch = { done: 0, before: 0, after: 0 };
    }
  }
  parentPort!.postMessage(batch);
}
