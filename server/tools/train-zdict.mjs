// Train the zstd dictionaries the store compresses filings and scores with
// (server/data/zdict/*.zdict). Needs the `zstd` CLI. A dictionary must never
// change once files were written with it: to retrain, add a new name and
// keep the old file (see DICTS in server/lib/store.js).
//   node server/tools/train-zdict.mjs [store dir] [samples per kind]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const root = process.argv[2] || path.join(process.cwd(), 'data', 'store');
const N = Number(process.argv[3]) || 1500;
const out = path.join(process.cwd(), 'server', 'data', 'zdict');
fs.mkdirSync(out, { recursive: true });

const decode = (f) => (f.endsWith('.br') ? zlib.brotliDecompressSync(fs.readFileSync(f)) : null);
for (const [kind, size] of [['filings', 262144], ['scores', 112640]]) {
  const base = path.join(root, kind);
  const all = [];
  for (const cik of fs.readdirSync(base)) for (const name of fs.readdirSync(path.join(base, cik))) if (name.endsWith('.json.br')) all.push(path.join(base, cik, name));
  // an evenly spread sample across companies
  const step = Math.max(1, Math.floor(all.length / N));
  const sample = all.filter((_, i) => i % step === 0).slice(0, N);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `zdict-${kind}-`));
  let i = 0;
  for (const f of sample) {
    const buf = decode(f);
    if (buf) fs.writeFileSync(path.join(tmp, `${i++}.json`), buf);
  }
  const dict = path.join(out, `${kind}-v1.zdict`);
  execFileSync('zstd', ['--train', '-q', `--maxdict=${size}`, '-o', dict, ...fs.readdirSync(tmp).map((n) => path.join(tmp, n))], { stdio: 'pipe' });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`${kind}: trained on ${i} samples -> ${dict} (${fs.statSync(dict).size} bytes)`);
}
