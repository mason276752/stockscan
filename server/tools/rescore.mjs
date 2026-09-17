// Score every saved filing that has no score of the current version (after
// a SCORE_VERSION bump) - one pass, then exit. The Pages workflow runs it before every
// build so a new scoring lands on the site with the commit that made it;
// the server does the same in the background at startup.
//   node server/tools/rescore.mjs
import { openStore, requireVersion } from '../lib/store.js';
import { SCRAPE_VERSION } from '../lib/scrape.js';
import { scoreUnscored } from '../lib/score.js';

const t0 = Date.now();
openStore();
requireVersion(SCRAPE_VERSION);
const n = await scoreUnscored({ budgetMs: 5000, log: (m) => console.log(`rescore: ${m}`) });
console.log(`rescore: ${n} filings in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
process.exit(0);
