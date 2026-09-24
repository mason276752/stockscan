// Score every saved filing that has no score of the current version (after
// a SCORE_VERSION bump) - one pass, then exit. The Pages workflow runs it before every
// build so a new scoring lands on the site with the commit that made it;
// the server does the same in the background at startup.
//   node server/tools/rescore.mjs
//
// --all recomputes every saved filing instead, at the current version, and
// writes back only the ones whose numbers really changed. That is the cheap
// way to roll out a scoring change that touches few filings: bumping
// SCORE_VERSION renames all 30,000 score files and the data ref has to carry
// every one of them again, while this leaves the untouched files byte for
// byte as they were, so the commit is only what moved.
//   node server/tools/rescore.mjs --all [--dry-run] [--cik 1652044] [--limit 500]
import { openStore, requireVersion } from '../lib/store.ts';
import { SCRAPE_VERSION } from '../lib/scrape.ts';
import { rescoreAll, scoreUnscored } from '../lib/score.ts';

const arg = (name) => process.argv.find((x, i, a) => a[i - 1] === name) || null;
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(0);
openStore();
requireVersion(SCRAPE_VERSION);

if (process.argv.includes('--all')) {
  const out = await rescoreAll({
    budgetMs: 5000,
    cik: arg('--cik'),
    limit: Number(arg('--limit')) || 0,
    dryRun: process.argv.includes('--dry-run'),
    log: (m) => console.log(`rescore: ${m}`),
    onProgress: (p) => console.log(`rescore: ${p.scanned} scanned, ${p.changed} changed (${secs()} s)`),
  });
  console.log(`rescore: ${out.scanned} filings, ${out.changed} ${process.argv.includes('--dry-run') ? 'would change' : 'rewritten'}, ${out.failed} failed in ${secs()} s`);
} else {
  const n = await scoreUnscored({ budgetMs: 5000, log: (m) => console.log(`rescore: ${m}`) });
  console.log(`rescore: ${n} filings in ${secs()} s`);
}
process.exit(0);
